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
  // Online (Paystack) payments are a later stage; these two need no payment gateway.
  var PAYMENT_METHODS = ['cash', 'mpesa_manual'];
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
   *   userId, deviceId, now(ms), nextRev, randomHex(bytes)
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

    var saleNumber = newSaleNumber(input.deviceId, nowMs, input.randomHex);
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
      status: 'paid',
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
        referenceNote: clean(input.referenceNote, 200) || null,
        status: 'paid'
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
      referenceNote: isCash ? null : (clean(input.referenceNote, 200) || null)
    };
    return { ok: true, changes: changes, nextRev: rev, receipt: receipt };
  }

  return {
    build: build,
    priceFor: priceFor,
    newSaleNumber: newSaleNumber,
    isoStamp: isoStamp,
    uuid: uuid,
    PAYMENT_METHODS: PAYMENT_METHODS,
    SALE_TYPES: SALE_TYPES
  };
}));
