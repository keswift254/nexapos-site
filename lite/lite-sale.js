/*
 * NexaPOS Lite till - turns a cart into the sync records of a sale.
 *
 * This is a line-for-line port of the app's checkout (CheckoutService.checkout in the NexaPOS app): the same
 * checks, the same messages, the same totals, and the same records in the same order. A sale made here must be
 * indistinguishable from one made in the app, because every other device of the shop will read it, and the
 * server refuses anything else (see SyncGuard in the platform). tests/lite/sale.test.js compares what this
 * builds, field for field, with what the real app recorded for the same sale (tests/lite/fixtures).
 *
 * ES5 only (iOS 10 Safari). Pure: no network, no storage, no DOM; the clock and the random source are handed in.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NexaLiteSale = factory();
  }
}(this, function () {
  'use strict';

  var SALE_TYPES = ['retail', 'wholesale'];
  // 'paystack' is an online payment: the sale is recorded as PENDING (stock reserved) until the payment is confirmed,
  // then settled by settle() below - exactly as the app's beginPaystackSale / finalizePaystackSale / cancelPaystackSale.
  var PAYMENT_METHODS = ['cash', 'mpesa_manual', 'paystack'];
  var SALE_NUMBER_PATTERN = /^[0-9A-Z]{6}-\d{14}-[0-9A-Z]{4}$/;
  var MAX_QUANTITY = 100000;
  var SALE_NUMBER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  function fail(message) {
    return { ok: false, message: message };
  }

  function isInt(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value;
  }

  function trim(text) {
    return String(text === undefined || text === null ? '' : text).replace(/^\s+|\s+$/g, '');
  }

  /** Control characters are never wanted in a name or note (the server refuses them). */
  function clean(text, max) {
    var cleaned = trim(text).replace(/[\u0000-\u001f\u007f]/g, ' ');
    return cleaned.length > max ? cleaned.substring(0, max) : cleaned;
  }

  /** The price a product line gets for a sale type (CartItem.repriced): wholesale when it is set, else retail. */
  function priceFor(product, saleType) {
    return saleType === 'wholesale' && product.wholesalePriceCents > 0 ? product.wholesalePriceCents : product.retailPriceCents;
  }

  function uuid(randomHex) {
    var h = randomHex(16);
    var variant = '89ab'.charAt(parseInt(h.charAt(16), 16) % 4);
    return h.substring(0, 8) + '-' + h.substring(8, 12) + '-4' + h.substring(13, 16) + '-' + variant + h.substring(17, 20) + '-' + h.substring(20, 32);
  }

  /** 2026-11-08T10:00:00.123000Z - the app's format (microseconds; a browser only has milliseconds). */
  function isoStamp(ms) {
    return new Date(ms).toISOString().replace(/Z$/, '000Z');
  }

  function two(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** The app names a sale <device code>-<local time yyyyMMddHHmmss>-<4 random characters>. */
  function newSaleNumber(deviceId, ms, randomHex) {
    var code = String(deviceId).replace(/^lite-/, '').replace(/[^0-9A-Za-z]/g, '').substring(0, 6).toUpperCase();
    while (code.length < 6) {
      code += '0';
    }
    var d = new Date(ms);
    var stamp = '' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
    var bytes = randomHex(4);
    var suffix = '';
    for (var i = 0; i < 4; i++) {
      suffix += SALE_NUMBER_CHARS.charAt(parseInt(bytes.substring(i * 2, i * 2 + 2), 16) % 36);
    }
    return code + '-' + stamp + '-' + suffix;
  }

  /**
   * input: {
   *   cart: [{productId|null, name, unitPriceCents, quantity}],  products: {id: {id,name,status,stockQty,costPriceCents}},
   *   saleType, paymentMethod, discountCents, customerName, customerPhone, referenceNote, cashReceivedCents,
   *   userId, deviceId, now(ms), nextRev, randomHex(bytes), saleNumber (optional: an online sale needs its number before
   *   it is built, because the number is the payment reference)
   * }
   * -> { ok: true, changes: [...], nextRev, receipt } | { ok: false, message }
   */
  function build(input) {
    var cart = input.cart || [];
    var products = input.products || {};

    if (SALE_TYPES.indexOf(input.saleType) < 0) {
      return fail('Select a valid sale type.');
    }
    if (PAYMENT_METHODS.indexOf(input.paymentMethod) < 0) {
      return fail('Select a valid payment method.');
    }
    if (!cart.length) {
      return fail('Add at least one product to the sale.');
    }

    // ---- the cart (CheckoutService._validateCart) ----------------------------------------------------------
    var manualLines = [];
    var mergedOrder = [];
    var merged = {};
    var i;
    for (i = 0; i < cart.length; i++) {
      var line = cart[i];
      if (!isInt(line.quantity) || line.quantity > MAX_QUANTITY) {
        return fail(line.productId ? 'Each sale item must have a valid product and quantity.' : 'Manual item quantity must be at least 1.');
      }
      if (!isInt(line.unitPriceCents) || line.unitPriceCents < 0) {
        return fail('Each sale item must have a valid product and quantity.');
      }
      if (!line.productId) {
        var manualName = clean(line.name, 200);
        if (!manualName) {
          return fail('Enter the manual item name.');
        }
        if (line.quantity < 1) {
          return fail('Manual item quantity must be at least 1.');
        }
        if (line.unitPriceCents <= 0) {
          return fail('Manual item price must be greater than 0.');
        }
        manualLines.push({ productId: null, name: manualName, unitPriceCents: line.unitPriceCents, costPriceCents: 0, quantity: line.quantity });
        continue;
      }
      if (line.quantity < 1) {
        return fail('Each sale item must have a valid product and quantity.');
      }
      if (merged.hasOwnProperty(line.productId)) {
        // The same product twice: quantities add up, the latest price wins.
        merged[line.productId].quantity += line.quantity;
        merged[line.productId].unitPriceCents = line.unitPriceCents;
      } else {
        merged[line.productId] = { productId: line.productId, quantity: line.quantity, unitPriceCents: line.unitPriceCents };
        mergedOrder.push(line.productId);
      }
    }

    var lines = manualLines.slice(0);
    for (i = 0; i < mergedOrder.length; i++) {
      var wanted = merged[mergedOrder[i]];
      var product = products.hasOwnProperty(wanted.productId) ? products[wanted.productId] : null;
      if (!product || product.status !== 'active') {
        return fail('One of the selected products is no longer available.');
      }
      if (product.stockQty < 1) {
        return fail(product.name + ' is out of stock.');
      }
      if (wanted.quantity > product.stockQty) {
        return fail('Only ' + product.stockQty + ' ' + product.name + ' in stock.');
      }
      lines.push({ productId: product.id, name: clean(product.name, 200), unitPriceCents: wanted.unitPriceCents, costPriceCents: product.costPriceCents, quantity: wanted.quantity });
    }

    // ---- totals (CheckoutService._computeTotals) ------------------------------------------------------------
    var subtotal = 0;
    for (i = 0; i < lines.length; i++) {
      lines[i].lineTotalCents = lines[i].unitPriceCents * lines[i].quantity;
      subtotal += lines[i].lineTotalCents;
    }
    var discount = isInt(input.discountCents) && input.discountCents > 0 ? input.discountCents : 0;
    if (discount > subtotal) {
      discount = subtotal;
    }
    var total = subtotal - discount;

    var isCash = input.paymentMethod === 'cash';
    var online = input.paymentMethod === 'paystack';
    if (input.saleNumber !== undefined && input.saleNumber !== null && !SALE_NUMBER_PATTERN.test(input.saleNumber)) {
      return fail('That sale number is not valid.');
    }
    if (!isCash && total < 1) {
      return fail('The total is zero, so there is nothing to charge.');
    }

    // ---- the records, in the order the app writes them -------------------------------------------------------
    var rev = input.nextRev;
    var nowMs = input.now();
    var stamp = isoStamp(nowMs);
    var changes = [];
    function row(table, fields) {
      var payload = {
        id: uuid(input.randomHex),
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
        localRev: rev,
        createdByDeviceId: input.deviceId,
        syncState: 'local_only'
      };
      for (var key in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) {
          payload[key] = fields[key];
        }
      }
      rev += 1;
      changes.push({ table_name: table, row_id: payload.id, local_rev: payload.localRev, updated_at: payload.updatedAt, payload: payload });
      return payload;
    }

    var saleNumber = input.saleNumber || newSaleNumber(input.deviceId, nowMs, input.randomHex);
    var customerName = clean(input.customerName, 120) || 'Walk-in customer';
    var phone = trim(input.customerPhone);
    var cashReceived = isCash && isInt(input.cashReceivedCents) && input.cashReceivedCents > 0 ? input.cashReceivedCents : null;

    var sale = row('sales', {
      saleNumber: saleNumber,
      userId: input.userId,
      customerName: customerName,
      customerPhone: !isCash && phone ? phone.replace(/[^0-9+()\- ]/g, '').substring(0, 32) || null : null,
      saleType: input.saleType,
      paymentMethod: input.paymentMethod,
      subtotalCents: subtotal,
      discountCents: discount,
      totalCents: total,
      status: online ? 'pending' : 'paid',
      cashReceivedCents: cashReceived
    });

    for (i = 0; i < lines.length; i++) {
      row('sale_items', {
        saleId: sale.id,
        productId: lines[i].productId,
        itemName: lines[i].name,
        quantity: lines[i].quantity,
        unitPriceCents: lines[i].unitPriceCents,
        costPriceCents: lines[i].costPriceCents,
        lineTotalCents: lines[i].lineTotalCents
      });
    }
    for (i = 0; i < lines.length; i++) {
      if (lines[i].productId) {
        row('stock_movements', {
          productId: lines[i].productId,
          userId: input.userId,
          movementType: 'sale',
          quantity: -lines[i].quantity,
          note: 'Sale ' + saleNumber
        });
      }
    }
    if (!isCash) {
      row('payment_records', {
        saleId: sale.id,
        method: input.paymentMethod,
        amountCents: total,
        // An online payment is reserved ('initiated') under the sale number, which is also Paystack's reference.
        referenceNote: online ? saleNumber : (clean(input.referenceNote, 200) || null),
        status: online ? 'initiated' : 'paid'
      });
    }

    var receipt = {
      saleId: sale.id,
      saleNumber: saleNumber,
      createdAt: nowMs,
      customerName: customerName,
      saleType: input.saleType,
      paymentMethod: input.paymentMethod,
      lines: lines,
      subtotalCents: subtotal,
      discountCents: discount,
      totalCents: total,
      cashReceivedCents: cashReceived,
      changeDueCents: cashReceived === null ? null : cashReceived - total,
      referenceNote: isCash ? null : (online ? saleNumber : (clean(input.referenceNote, 200) || null)),
      online: online,
      amountToPayCents: online ? total : null
    };
    return { ok: true, changes: changes, nextRev: rev, receipt: receipt };
  }

  /** A time strictly later than the row's last one, so the newer version wins everywhere (the app compares them as text). */
  function laterStamp(previous, nowMs) {
    var previousMs = Date.parse(String(previous).replace(/(\.\d{3})\d*Z$/, '$1Z'));
    return isoStamp(isFinite(previousMs) && previousMs >= nowMs ? previousMs + 1 : nowMs);
  }

  /**
   * Settles a pending online sale once its payment is known. The records are the SAME sale and payment rows, updated
   * (same ids, a newer time, the next revisions), exactly as the app does it:
   *   'paid'      -> the sale becomes paid and its payment paid;
   *   'cancelled' -> the stock the sale took is returned, the sale becomes cancelled and its payment failed.
   * input: {original: the pending sale's records, outcome: 'paid'|'cancelled', deviceId, now(), nextRev, randomHex}
   * -> {ok, changes, nextRev} | {ok:false, message}
   */
  function settle(input) {
    var sale = null;
    var payment = null;
    var movements = [];
    for (var i = 0; i < input.original.length; i++) {
      var change = input.original[i];
      if (change.table_name === 'sales') { sale = change.payload; }
      if (change.table_name === 'payment_records') { payment = change.payload; }
      if (change.table_name === 'stock_movements') { movements.push(change.payload); }
    }
    if (!sale || !payment || sale.paymentMethod !== 'paystack' || sale.status !== 'pending' || payment.status !== 'initiated') {
      return fail('That is not an online sale waiting for its payment.');
    }
    if (input.outcome !== 'paid' && input.outcome !== 'cancelled') {
      return fail('Say whether the payment was received or the sale cancelled.');
    }
    var rev = input.nextRev;
    var nowMs = input.now();
    var changes = [];
    function update(table, previous, fields) {
      var payload = {};
      for (var key in previous) {
        if (Object.prototype.hasOwnProperty.call(previous, key)) { payload[key] = previous[key]; }
      }
      payload.updatedAt = laterStamp(previous.updatedAt, nowMs);
      payload.localRev = rev;
      for (var field in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, field)) { payload[field] = fields[field]; }
      }
      rev += 1;
      changes.push({ table_name: table, row_id: payload.id, local_rev: payload.localRev, updated_at: payload.updatedAt, payload: payload });
    }
    if (input.outcome === 'cancelled') {
      // Put back what the sale took, one return per product (the sale's movements are already one per product).
      var stamp = isoStamp(nowMs);
      for (var m = 0; m < movements.length; m++) {
        var returned = {
          id: uuid(input.randomHex), createdAt: stamp, updatedAt: stamp, deletedAt: null, localRev: rev,
          createdByDeviceId: input.deviceId, syncState: 'local_only',
          productId: movements[m].productId, userId: null, movementType: 'return', quantity: -movements[m].quantity,
          note: 'Online payment not completed'
        };
        rev += 1;
        changes.push({ table_name: 'stock_movements', row_id: returned.id, local_rev: returned.localRev, updated_at: returned.updatedAt, payload: returned });
      }
    }
    update('sales', sale, { status: input.outcome === 'paid' ? 'paid' : 'cancelled' });
    update('payment_records', payment, { status: input.outcome === 'paid' ? 'paid' : 'failed' });
    return { ok: true, changes: changes, nextRev: rev };
  }

  // ---- expenses ----------------------------------------------------------------------------------------------------
  // The same rules as the app's ExpenseService (a name, an amount above zero, an optional note, a day) plus the limits the
  // shop server checks (the SyncGuard in the platform): a real day from 2020 up to today, an amount the shop can hold.
  var EARLIEST_EXPENSE_DAY = '2020-01-01';
  var MAX_EXPENSE_CENTS = 100000000;

  /** Control characters out, spaces trimmed, cut to a length (and trimmed again: the cut may leave a space at the end). */
  function expenseText(text, max) {
    var cleaned = trim(String(text === undefined || text === null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, ' '));
    return trim(cleaned.length > max ? cleaned.substring(0, max) : cleaned);
  }

  /** A real calendar day written yyyy-mm-dd. */
  function realDay(text) {
    var found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text === undefined || text === null ? '' : text));
    if (!found) {
      return false;
    }
    var year = Number(found[1]);
    var month = Number(found[2]);
    var day = Number(found[3]);
    var date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  /** Today, on this iPad's clock, as yyyy-mm-dd. */
  function dayOf(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }

  /**
   * A new expense, as the app writes it: ONE record (the expense), entered by the logged-in user, created and updated at the
   * same moment. input: {title, amountCents, expenseDate (yyyy-mm-dd), note, userId, deviceId, now(), nextRev, randomHex(bytes)}
   * -> {ok, changes, nextRev, expense: the record} | {ok:false, message}
   */
  function buildExpense(input) {
    var title = expenseText(input.title, 200);
    if (!title) {
      return fail('Enter the expense name.');
    }
    if (!isInt(input.amountCents) || input.amountCents <= 0) {
      return fail('Enter an expense amount greater than zero.');
    }
    if (input.amountCents > MAX_EXPENSE_CENTS) {
      return fail('That amount is too large.');
    }
    if (!realDay(input.expenseDate)) {
      return fail('Choose the day of the expense.');
    }
    var nowMs = input.now();
    if (input.expenseDate < EARLIEST_EXPENSE_DAY) {
      return fail('An expense cannot be dated before 2020.');
    }
    if (input.expenseDate > dayOf(nowMs)) {
      return fail('An expense cannot be dated in the future.');
    }
    var stamp = isoStamp(nowMs);
    var payload = {
      id: uuid(input.randomHex),
      createdAt: stamp,
      updatedAt: stamp,
      deletedAt: null,
      localRev: input.nextRev,
      createdByDeviceId: input.deviceId,
      syncState: 'local_only',
      userId: input.userId || null,
      expenseDate: input.expenseDate,
      title: title,
      amountCents: input.amountCents,
      note: expenseText(input.note, 500) || null
    };
    return {
      ok: true,
      changes: [{ table_name: 'expenses', row_id: payload.id, local_rev: payload.localRev, updated_at: payload.updatedAt, payload: payload }],
      nextRev: input.nextRev + 1,
      expense: payload
    };
  }

  /**
   * Deleting an expense, as the app does it: the same record with deletedAt and updatedAt set to one newer time and the next
   * revision. Only the device that entered an expense can delete it (the shop's sync accepts nothing else from this iPad).
   * input: {original: the expense's stored record, deviceId, now(), nextRev} -> {ok, changes, nextRev} | {ok:false, message}
   */
  function deleteExpense(input) {
    var original = input.original;
    if (!original || typeof original !== 'object' || !original.id) {
      return fail('That expense could not be found.');
    }
    if (original.deletedAt) {
      return fail('That expense is already deleted.');
    }
    if (original.createdByDeviceId !== input.deviceId) {
      return fail('That expense was entered on another device. It can only be deleted there.');
    }
    var payload = {};
    for (var key in original) {
      if (Object.prototype.hasOwnProperty.call(original, key)) {
        payload[key] = original[key];
      }
    }
    var when = laterStamp(original.updatedAt, input.now());
    payload.updatedAt = when;
    payload.deletedAt = when;
    payload.localRev = input.nextRev;
    return {
      ok: true,
      changes: [{ table_name: 'expenses', row_id: payload.id, local_rev: payload.localRev, updated_at: payload.updatedAt, payload: payload }],
      nextRev: input.nextRev + 1
    };
  }

  // ---- refunds (a line-for-line port of RefundService in the app) ----------------------------------------------------
  // A refund is its own NEW sale with negative amounts, one negative line for each item given back, a stock 'return' for each
  // item that goes back on the shelf and, for M-Pesa, a negative payment record. The sale refunded is never touched.
  var MAX_REFUND_REASON = 200;
  var EXACT = 4503599627370496; // 2^52: below this every sum in a browser's doubles is exact
  var TOO_BIG = 'This sale is too big for the Lite till to share out to the cent. Refund it in the NexaPOS app.';

  /**
   * round(a * b / c) for whole, non-negative numbers, exactly as the app works it out (it has big integers; this page has only
   * doubles) - or null when the answer could not be exact here. A caller then refuses the refund rather than guess a cent.
   */
  function roundedShare(a, b, c) {
    if (!isInt(a) || !isInt(b) || !isInt(c) || a < 0 || b < 0) {
      return null;
    }
    if (c <= 0) {
      return 0;
    }
    var whole = Math.floor(a / c);
    while (whole * c > a) {
      whole -= 1;
    }
    while ((whole + 1) * c <= a) {
      whole += 1;
    }
    var rest = a - whole * c;
    var numerator = rest * b * 2 + c;
    if (whole * b > EXACT || numerator > EXACT) {
      return null;
    }
    var step = 2 * c;
    var low = Math.floor(numerator / step);
    while (low * step > numerator) {
      low -= 1;
    }
    while ((low + 1) * step <= numerator) {
      low += 1;
    }
    return whole * b + low;
  }

  /** The sale's lines with how much of each is already given back (by the shop's refunds AND by refunds waiting on this iPad). */
  function refundLines(source) {
    var byId = {};
    var order = [];
    var items = source.items || [];
    var i;
    for (i = 0; i < items.length; i++) {
      byId[items[i].id] = { item: items[i], remaining: items[i].quantity };
      order.push(items[i].id);
    }
    var given = source.lines || [];
    for (i = 0; i < given.length; i++) {
      if (byId.hasOwnProperty(given[i].itemId)) {
        byId[given[i].itemId].remaining = byId[given[i].itemId].item.quantity - given[i].refunded;
      }
    }
    return { byId: byId, order: order };
  }

  /** Why this sale cannot be refunded at all (RefundableSale.whyNot), or null. */
  function whyNotRefundable(source) {
    var sale = source.sale;
    if (sale.saleType === 'refund') {
      return 'A refund cannot be refunded.';
    }
    if (sale.status !== 'paid') {
      return 'Only a paid sale can be refunded.';
    }
    var lines = refundLines(source);
    for (var i = 0; i < lines.order.length; i++) {
      if (lines.byId[lines.order[i]].remaining > 0) {
        return null;
      }
    }
    return 'This sale has already been refunded in full.';
  }

  /**
   * The money for a set of choices, worked out exactly as the app records it (RefundService.quote). Pure: nothing is written.
   * source: what the shop's lite_sale gave, with this iPad's waiting refunds added: {sale, items, lines:[{itemId, quantity,
   *   refunded}], refunded:{subtotalCents, discountCents, totalCents, cashCents}} (all positive: money that already went back).
   * choices: [{itemId, quantity, restock}]
   * -> {ok:true, subtotalCents, discountCents, totalCents, cashCents (null unless the sale was paid partly in cash and partly
   *    by an M-Pesa prompt)} | {ok:false, message}
   */
  function quoteRefund(source, choices) {
    var blocked = whyNotRefundable(source);
    if (blocked) {
      return fail(blocked);
    }
    var lines = refundLines(source).byId;
    var seen = {};
    var subtotal = 0;
    var i;
    for (i = 0; i < choices.length; i++) {
      var choice = choices[i];
      var line = lines.hasOwnProperty(choice.itemId) ? lines[choice.itemId] : null;
      if (!line) {
        return fail('That item is not part of this sale.');
      }
      if (seen.hasOwnProperty(choice.itemId)) {
        return fail('An item is listed twice.');
      }
      seen[choice.itemId] = true;
      if (!isInt(choice.quantity) || choice.quantity < 1) {
        return fail('Enter a quantity of 1 or more.');
      }
      if (line.remaining < 1) {
        return fail(line.item.itemName + ' has already been refunded.');
      }
      if (choice.quantity > line.remaining) {
        return fail('Only ' + line.remaining + ' of ' + line.item.itemName + ' can still be refunded.');
      }
      subtotal += choice.quantity * line.item.unitPriceCents;
    }
    if (!choices.length) {
      return fail('Choose at least one item to refund.');
    }

    var sale = source.sale;
    var before = source.refunded;
    // The discount is given back in proportion to the goods, in whole cents, so that the refunds of one sale always add up to
    // exactly what the customer paid (the last one takes the rounding).
    var discountTarget = roundedShare(sale.discountCents, before.subtotalCents + subtotal, sale.subtotalCents);
    if (discountTarget === null || subtotal > EXACT) {
      return fail(TOO_BIG);
    }
    var discount = discountTarget - before.discountCents;
    if (discount < 0) {
      discount = 0;
    }
    if (discount > subtotal) {
      discount = subtotal;
    }
    var total = subtotal - discount;
    if (total < 1) {
      return fail('There is nothing to refund on those items.');
    }

    var cash = null;
    // a split sale: part in cash, the rest by M-Pesa - a prompt ('paystack') or the shop's own till ('mpesa_manual'); the app's
    // Sale.isSplitPayment
    if ((sale.paymentMethod === 'paystack' || sale.paymentMethod === 'mpesa_manual') && sale.cashReceivedCents !== null && sale.cashReceivedCents !== undefined) {
      var cashTarget = roundedShare(sale.cashReceivedCents, before.totalCents + total, sale.totalCents);
      if (cashTarget === null) {
        return fail(TOO_BIG);
      }
      var share = cashTarget - before.cashCents;
      if (share < 0) {
        share = 0;
      }
      if (share > total) {
        share = total;
      }
      cash = share;
    }
    return { ok: true, subtotalCents: subtotal, discountCents: discount, totalCents: total, cashCents: cash };
  }

  /**
   * Builds the records of a refund (RefundService.refund, minus the password, which the core checks first).
   * input: {source (as quoteRefund), choices, reason, products: {id: product} (the goods this till knows: stock only goes back for
   *   a product that still exists), userId (the administrator or manager refunding), deviceId, now(ms), nextRev, randomHex(bytes)}
   * -> {ok:true, changes, nextRev, receipt} | {ok:false, message}
   */
  function buildRefund(input) {
    var reason = trim(String(input.reason === undefined || input.reason === null ? '' : input.reason).replace(/[\u0000-\u001f\u007f]/g, ' '));
    if (!reason) {
      return fail('Enter the reason for the refund.');
    }
    if (reason.length > MAX_REFUND_REASON) {
      return fail('The reason is too long (200 characters at most).');
    }
    var checked = quoteRefund(input.source, input.choices || []);
    if (!checked.ok) {
      return checked;
    }
    var sale = input.source.sale;
    var original = refundLines(input.source).byId;
    var products = input.products || {};

    var lines = [];
    var goesBack = [];
    var i;
    for (i = 0; i < input.choices.length; i++) {
      var choice = input.choices[i];
      var from = original[choice.itemId].item;
      var restocked = choice.restock !== false && !!from.productId && products.hasOwnProperty(from.productId);
      lines.push({
        productId: from.productId === undefined ? null : from.productId,
        itemName: from.itemName,
        quantity: 0 - choice.quantity,
        unitPriceCents: from.unitPriceCents,
        // The cost only comes back when the goods do: stock thrown away stays a cost of the shop.
        costPriceCents: restocked ? from.costPriceCents : 0,
        lineTotalCents: 0 - choice.quantity * from.unitPriceCents,
        refundOfItemId: from.id,
        quantityBack: choice.quantity,
        restocked: restocked
      });
      if (restocked) {
        goesBack.push({ productId: from.productId, quantity: choice.quantity });
      }
    }

    var rev = input.nextRev;
    var nowMs = input.now();
    var stamp = isoStamp(nowMs);
    var changes = [];
    function row(table, fields) {
      var payload = {
        id: uuid(input.randomHex),
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
        localRev: rev,
        createdByDeviceId: input.deviceId,
        syncState: 'local_only'
      };
      for (var key in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) {
          payload[key] = fields[key];
        }
      }
      rev += 1;
      changes.push({ table_name: table, row_id: payload.id, local_rev: payload.localRev, updated_at: payload.updatedAt, payload: payload });
      return payload;
    }

    var refundNumber = newSaleNumber(input.deviceId, nowMs, input.randomHex);
    var customerName = sale.customerName === undefined || sale.customerName === null ? 'Walk-in customer' : sale.customerName;
    var customerPhone = sale.customerPhone === undefined ? null : sale.customerPhone;
    var refund = row('sales', {
      saleNumber: refundNumber,
      userId: input.userId,
      customerName: customerName,
      customerPhone: customerPhone,
      saleType: 'refund',
      paymentMethod: sale.paymentMethod,
      subtotalCents: 0 - checked.subtotalCents,
      discountCents: 0 - checked.discountCents,
      totalCents: 0 - checked.totalCents,
      status: 'paid',
      cashReceivedCents: checked.cashCents === null ? null : 0 - checked.cashCents,
      refundOfSaleId: sale.id,
      refundReason: reason
    });
    for (i = 0; i < lines.length; i++) {
      row('sale_items', {
        saleId: refund.id,
        productId: lines[i].productId,
        itemName: lines[i].itemName,
        quantity: lines[i].quantity,
        unitPriceCents: lines[i].unitPriceCents,
        costPriceCents: lines[i].costPriceCents,
        lineTotalCents: lines[i].lineTotalCents,
        refundOfItemId: lines[i].refundOfItemId
      });
    }
    for (i = 0; i < goesBack.length; i++) {
      row('stock_movements', {
        productId: goesBack[i].productId,
        userId: input.userId,
        movementType: 'return',
        quantity: goesBack[i].quantity,
        note: 'Refund ' + refundNumber
      });
    }
    if (sale.paymentMethod !== 'cash') {
      row('payment_records', {
        saleId: refund.id,
        method: sale.paymentMethod,
        amountCents: 0 - checked.totalCents,
        referenceNote: 'Refund of ' + sale.saleNumber,
        status: 'refunded'
      });
    }

    var shown = [];
    for (i = 0; i < lines.length; i++) {
      shown.push({
        name: lines[i].itemName,
        quantity: lines[i].quantityBack,
        unitPriceCents: lines[i].unitPriceCents,
        lineTotalCents: lines[i].quantityBack * lines[i].unitPriceCents,
        restocked: lines[i].restocked
      });
    }
    var receipt = {
      saleId: refund.id,
      saleNumber: refundNumber,
      createdAt: nowMs,
      customerName: customerName,
      saleType: 'refund',
      paymentMethod: sale.paymentMethod,
      isRefund: true,
      refundOfSaleId: sale.id,
      refundOfSaleNumber: sale.saleNumber,
      reason: reason,
      lines: shown,
      // the amounts that went BACK to the customer, written as positive money
      subtotalCents: checked.subtotalCents,
      discountCents: checked.discountCents,
      totalCents: checked.totalCents,
      cashBackCents: checked.cashCents,
      referenceNote: null,
      online: false
    };
    return { ok: true, changes: changes, nextRev: rev, receipt: receipt };
  }

  return {
    build: build,
    settle: settle,
    buildExpense: buildExpense,
    deleteExpense: deleteExpense,
    quoteRefund: quoteRefund,
    buildRefund: buildRefund,
    roundedShare: roundedShare,
    whyNotRefundable: whyNotRefundable,
    refundLines: refundLines,
    MAX_REFUND_REASON: MAX_REFUND_REASON,
    dayOf: dayOf,
    priceFor: priceFor,
    newSaleNumber: newSaleNumber,
    isoStamp: isoStamp,
    uuid: uuid,
    PAYMENT_METHODS: PAYMENT_METHODS,
    SALE_TYPES: SALE_TYPES
  };
}));
