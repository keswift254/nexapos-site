/*
 * The Lite sale builder must produce exactly what the real NexaPOS app records for the same sale.
 * fixtures/sale_scenarios.json is written by the app's own tests (it runs real checkouts through the
 * real CheckoutService and captures the sync records). Here the same sales are rung up through
 * lite/lite-sale.js and the records compared field for field; only things that legitimately differ
 * between runs (ids, times, revisions, the sale number) are masked.
 *
 * Run: node tests/lite/sale.test.js
 */
'use strict';

var assert = require('assert');
var Sale = require('../../lite/lite-sale.js');
var fixture = require('./fixtures/sale_scenarios.json');

var scenarios = {};
fixture.scenarios.forEach(function (s) { scenarios[s.name] = s; });

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

var NOW = new Date(2026, 10, 8, 14, 30, 5, 123).getTime(); // local time on purpose: the sale number uses it
function randomHex(bytes) { return require('crypto').randomBytes(bytes).toString('hex'); }
var DEVICE_ID = 'lite-9f3a2c1d5e6b7a8c9d0e1f2a';

function productsOf(scenario, stock) {
  var map = {};
  scenario.context.products.forEach(function (p) {
    map[p.id] = { id: p.id, name: p.name, status: p.status, stockQty: stock === undefined ? 100 : stock, costPriceCents: p.costPriceCents, retailPriceCents: p.retailPriceCents, wholesalePriceCents: p.wholesalePriceCents };
  });
  return map;
}
function productNamed(scenario, name) {
  return scenario.context.products.filter(function (p) { return p.name === name; })[0];
}
function sell(scenario, overrides, stock) {
  var input = {
    cart: [], products: productsOf(scenario, stock), saleType: 'retail', paymentMethod: 'cash', discountCents: 0,
    customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: null,
    userId: scenario.context.cashierId, deviceId: DEVICE_ID, now: function () { return NOW; }, nextRev: 1, randomHex: randomHex
  };
  for (var k in overrides) { input[k] = overrides[k]; }
  return Sale.build(input);
}

/** What may differ between two runs of the same sale. */
function mask(change) {
  var p = JSON.parse(JSON.stringify(change.payload));
  ['id', 'saleId'].forEach(function (k) { if (k in p) { p[k] = '<id>'; } });
  ['createdAt', 'updatedAt'].forEach(function (k) { p[k] = '<time>'; });
  p.localRev = '<rev>';
  p.createdByDeviceId = '<device>';
  if (p.saleNumber) { p.saleNumber = '<saleNumber>'; }
  if (typeof p.note === 'string') { p.note = p.note.replace(/[0-9A-Z]{6}-\d{14}-[0-9A-Z]{4}/, '<saleNumber>'); }
  if (typeof p.referenceNote === 'string' && /^[0-9A-Z]{6}-\d{14}-[0-9A-Z]{4}$/.test(p.referenceNote)) { p.referenceNote = '<saleNumber>'; }
  return { table_name: change.table_name, payload: p };
}
function sorted(value) {
  if (Array.isArray(value)) { return value.map(sorted); }
  if (value && typeof value === 'object') { var o = {}; Object.keys(value).sort().forEach(function (k) { o[k] = sorted(value[k]); }); return o; }
  return value;
}
function sameAsApp(scenarioName, built) {
  var expected = scenarios[scenarioName].stages[0].changes;
  assert.ok(built.ok, built.message);
  assert.strictEqual(built.changes.length, expected.length, scenarioName + ': number of records');
  for (var i = 0; i < expected.length; i++) {
    assert.deepStrictEqual(sorted(mask(built.changes[i])), sorted(mask(expected[i])), scenarioName + ': record #' + (i + 1) + ' (' + expected[i].table_name + ') differs from what the app writes');
  }
}

// ---- the same sales as the app's own tests -------------------------------------------------------------------
test('cash sale of two products = what the app records', function () {
  var s = scenarios.cash_sale_two_lines;
  var widget = productNamed(s, 'Widget'), gadget = productNamed(s, 'Gadget');
  sameAsApp('cash_sale_two_lines', sell(s, {
    cart: [{ productId: widget.id, name: 'Widget', unitPriceCents: 10000, quantity: 2 }, { productId: gadget.id, name: 'Gadget', unitPriceCents: 25050, quantity: 1 }],
    cashReceivedCents: 50000
  }));
});

test('cash sale with a discount and a named customer = what the app records', function () {
  var s = scenarios.cash_sale_discount;
  sameAsApp('cash_sale_discount', sell(s, { cart: [{ productId: productNamed(s, 'Widget').id, name: 'Widget', unitPriceCents: 10000, quantity: 3 }], discountCents: 1500, customerName: '  Wanjiru ', cashReceivedCents: 30000 }));
});

test('M-Pesa received (manual) = what the app records', function () {
  var s = scenarios.mpesa_manual_sale;
  sameAsApp('mpesa_manual_sale', sell(s, { cart: [{ productId: productNamed(s, 'Gadget').id, name: 'Gadget', unitPriceCents: 25050, quantity: 2 }], paymentMethod: 'mpesa_manual', customerPhone: '0712345678', referenceNote: 'QWE123XYZ9' }));
});

test('wholesale sale = what the app records', function () {
  var s = scenarios.wholesale_sale;
  sameAsApp('wholesale_sale', sell(s, { cart: [{ productId: productNamed(s, 'Widget').id, name: 'Widget', unitPriceCents: 8000, quantity: 10 }], saleType: 'wholesale', cashReceivedCents: 80000 }));
});

test('a manual line (no product, no stock) = what the app records', function () {
  var s = scenarios.manual_line_sale;
  sameAsApp('manual_line_sale', sell(s, {
    cart: [{ productId: productNamed(s, 'Widget').id, name: 'Widget', unitPriceCents: 10000, quantity: 1 }, { productId: null, name: 'Delivery', unitPriceCents: 20000, quantity: 1 }],
    cashReceivedCents: 30000
  }));
});

// ---- shape and bookkeeping -----------------------------------------------------------------------------------
test('records are well formed: ids, times, revisions, sale number, relations', function () {
  var s = scenarios.cash_sale_two_lines;
  var built = sell(s, { cart: [{ productId: productNamed(s, 'Widget').id, name: 'Widget', unitPriceCents: 10000, quantity: 2 }, { productId: productNamed(s, 'Gadget').id, name: 'Gadget', unitPriceCents: 25050, quantity: 1 }], cashReceivedCents: 50000, nextRev: 41 });
  assert.ok(built.ok);
  var ids = {};
  var sale = built.changes[0].payload;
  built.changes.forEach(function (c, i) {
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.payload.id), 'v4 uuid: ' + c.payload.id);
    assert.ok(!ids[c.payload.id], 'unique id');
    ids[c.payload.id] = true;
    assert.strictEqual(c.row_id, c.payload.id);
    assert.strictEqual(c.local_rev, 41 + i, 'consecutive revisions in write order');
    assert.strictEqual(c.payload.localRev, c.local_rev);
    assert.strictEqual(c.updated_at, c.payload.updatedAt);
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(c.payload.updatedAt), 'app time format: ' + c.payload.updatedAt);
    assert.strictEqual(c.payload.createdByDeviceId, DEVICE_ID);
    assert.strictEqual(c.payload.deletedAt, null);
    if (c.table_name === 'sale_items') { assert.strictEqual(c.payload.saleId, sale.id); }
  });
  assert.strictEqual(built.nextRev, 41 + built.changes.length);
  assert.ok(/^[0-9A-Z]{6}-\d{14}-[0-9A-Z]{4}$/.test(sale.saleNumber), sale.saleNumber);
  assert.ok(/^9F3A2C-20261108143005-/.test(sale.saleNumber), 'device code and LOCAL time: ' + sale.saleNumber);
  built.changes.filter(function (c) { return c.table_name === 'stock_movements'; }).forEach(function (c) { assert.strictEqual(c.payload.note, 'Sale ' + sale.saleNumber); });
});

test('every record has exactly the fields the app writes', function () {
  var seen = {};
  fixture.scenarios.forEach(function (s) { s.stages.forEach(function (st) { st.changes.forEach(function (c) { seen[c.table_name] = Object.keys(c.payload).sort(); }); }); });
  var s = scenarios.mpesa_manual_sale;
  var built = sell(s, { cart: [{ productId: productNamed(s, 'Gadget').id, name: 'Gadget', unitPriceCents: 25050, quantity: 2 }], paymentMethod: 'mpesa_manual' });
  built.changes.forEach(function (c) { assert.deepStrictEqual(Object.keys(c.payload).sort(), seen[c.table_name], c.table_name); });
});

test('the receipt summary adds up', function () {
  var s = scenarios.cash_sale_discount;
  var built = sell(s, { cart: [{ productId: productNamed(s, 'Widget').id, name: 'Widget', unitPriceCents: 10000, quantity: 3 }], discountCents: 1500, cashReceivedCents: 30000 });
  assert.deepStrictEqual([built.receipt.subtotalCents, built.receipt.discountCents, built.receipt.totalCents, built.receipt.changeDueCents], [30000, 1500, 28500, 1500]);
  assert.strictEqual(built.receipt.customerName, 'Walk-in customer');
});

// ---- the app's checks, with the app's own messages ---------------------------------------------------------------
test('refuses what the app refuses, with the same words', function () {
  var s = scenarios.cash_sale_two_lines;
  var widget = productNamed(s, 'Widget');
  var line = function (extra) { var l = { productId: widget.id, name: 'Widget', unitPriceCents: 10000, quantity: 1 }; for (var k in extra) { l[k] = extra[k]; } return l; };
  assert.strictEqual(sell(s, { cart: [] }).message, 'Add at least one product to the sale.');
  assert.strictEqual(sell(s, { cart: [line()], saleType: 'free' }).message, 'Select a valid sale type.');
  assert.strictEqual(sell(s, { cart: [line()], paymentMethod: 'intasend' }).message, 'Select a valid payment method.');
  assert.strictEqual(sell(s, { cart: [line({ productId: null, name: ' ', unitPriceCents: 500 })] }).message, 'Enter the manual item name.');
  assert.strictEqual(sell(s, { cart: [line({ productId: null, name: 'Fee', unitPriceCents: 0 })] }).message, 'Manual item price must be greater than 0.');
  assert.strictEqual(sell(s, { cart: [line({ productId: null, name: 'Fee', unitPriceCents: 500, quantity: 0 })] }).message, 'Manual item quantity must be at least 1.');
  assert.strictEqual(sell(s, { cart: [line({ quantity: 0 })] }).message, 'Each sale item must have a valid product and quantity.');
  assert.strictEqual(sell(s, { cart: [line({ productId: '00000000-0000-4000-8000-0000000000ff' })] }).message, 'One of the selected products is no longer available.');
  assert.strictEqual(sell(s, { cart: [line()] }, 0).message, 'Widget is out of stock.');
  assert.strictEqual(sell(s, { cart: [line({ quantity: 6 })] }, 5).message, 'Only 5 Widget in stock.');
  var inactive = productsOf(s); inactive[widget.id].status = 'inactive';
  assert.strictEqual(sell(s, { cart: [line()], products: inactive }).message, 'One of the selected products is no longer available.');
});

test('the same product twice becomes one line: quantities add, the latest price wins', function () {
  var s = scenarios.cash_sale_two_lines;
  var w = productNamed(s, 'Widget').id;
  var built = sell(s, { cart: [{ productId: w, name: 'Widget', unitPriceCents: 10000, quantity: 2 }, { productId: w, name: 'Widget', unitPriceCents: 9000, quantity: 3 }] });
  var items = built.changes.filter(function (c) { return c.table_name === 'sale_items'; });
  assert.strictEqual(items.length, 1);
  assert.deepStrictEqual([items[0].payload.quantity, items[0].payload.unitPriceCents, items[0].payload.lineTotalCents], [5, 9000, 45000]);
  var moves = built.changes.filter(function (c) { return c.table_name === 'stock_movements'; });
  assert.deepStrictEqual(moves.map(function (c) { return c.payload.quantity; }), [-5]);
  // ...and the stock check sees the merged quantity: 2 + 3 > 4 in stock.
  assert.strictEqual(sell(s, { cart: [{ productId: w, name: 'Widget', unitPriceCents: 10000, quantity: 2 }, { productId: w, name: 'Widget', unitPriceCents: 10000, quantity: 3 }] }, 4).message, 'Only 4 Widget in stock.');
});

test('a discount bigger than the sale is cut down to the sale (cash only; there is nothing to charge by M-Pesa)', function () {
  var s = scenarios.cash_sale_two_lines;
  var cart = [{ productId: productNamed(s, 'Widget').id, name: 'Widget', unitPriceCents: 10000, quantity: 1 }];
  var cash = sell(s, { cart: cart, discountCents: 99999 });
  assert.ok(cash.ok);
  assert.deepStrictEqual([cash.receipt.discountCents, cash.receipt.totalCents], [10000, 0]);
  assert.strictEqual(sell(s, { cart: cart, discountCents: 99999, paymentMethod: 'mpesa_manual' }).ok, false);
  assert.strictEqual(sell(s, { cart: cart, discountCents: -500 }).receipt.discountCents, 0, 'a negative discount is no discount');
});

test('cash received only belongs to a cash sale; a phone only to M-Pesa', function () {
  var s = scenarios.cash_sale_two_lines;
  var cart = [{ productId: productNamed(s, 'Widget').id, name: 'Widget', unitPriceCents: 10000, quantity: 1 }];
  var mpesa = sell(s, { cart: cart, paymentMethod: 'mpesa_manual', cashReceivedCents: 99999, customerPhone: ' 0712 345 678 ' });
  assert.strictEqual(mpesa.changes[0].payload.cashReceivedCents, null);
  assert.strictEqual(mpesa.changes[0].payload.customerPhone, '0712 345 678');
  var cash = sell(s, { cart: cart, customerPhone: '0712345678', cashReceivedCents: 0 });
  assert.strictEqual(cash.changes[0].payload.customerPhone, null);
  assert.strictEqual(cash.changes[0].payload.cashReceivedCents, null, 'nothing entered is not "0 tendered"');
});

test('numbers must be whole numbers; names are cleaned', function () {
  var s = scenarios.cash_sale_two_lines;
  var w = productNamed(s, 'Widget').id;
  assert.strictEqual(sell(s, { cart: [{ productId: w, name: 'W', unitPriceCents: 10000, quantity: 1.5 }] }).ok, false);
  assert.strictEqual(sell(s, { cart: [{ productId: w, name: 'W', unitPriceCents: NaN, quantity: 1 }] }).ok, false);
  assert.strictEqual(sell(s, { cart: [{ productId: w, name: 'W', unitPriceCents: 100.5, quantity: 1 }] }).ok, false);
  assert.strictEqual(sell(s, { cart: [{ productId: w, name: 'W', unitPriceCents: 10000, quantity: 100001 }] }, 999999).ok, false);
  var fee = sell(s, { cart: [{ productId: null, name: 'De\u0000liv\u0007ery' + new Array(300).join('x'), unitPriceCents: 500, quantity: 1 }], customerName: 'Wan\u0000jiru' });
  assert.ok(fee.ok);
  var item = fee.changes[1].payload;
  assert.ok(item.itemName.length <= 200 && !/[\u0000-\u001f]/.test(item.itemName));
  assert.strictEqual(fee.changes[0].payload.customerName, 'Wan jiru');
});

test('an M-Pesa sale with a discount is paid the TOTAL, not the subtotal', function () {
  var s = scenarios.mpesa_manual_sale;
  var built = sell(s, { cart: [{ productId: productNamed(s, 'Gadget').id, name: 'Gadget', unitPriceCents: 25050, quantity: 2 }], paymentMethod: 'mpesa_manual', discountCents: 1100, referenceNote: '  AB12  ' });
  assert.ok(built.ok, built.message);
  var payment = built.changes.filter(function (c) { return c.table_name === 'payment_records'; })[0].payload;
  assert.deepStrictEqual([built.changes[0].payload.subtotalCents, built.changes[0].payload.totalCents, payment.amountCents, payment.referenceNote, payment.status, payment.method], [50100, 49000, 49000, 'AB12', 'paid', 'mpesa_manual']);
});
// ---- online (Paystack) sales: pending, then settled -----------------------------------------------------------
function pendingOnline(s, cart, extra) {
  var request = { cart: cart, paymentMethod: 'paystack', saleNumber: 'AAAAAA-20261105120000-ZZZZ' };
  for (var k in extra) { request[k] = extra[k]; }
  return sell(s, request);
}
function settleIt(built, outcome, nextRev, nowMs) {
  return Sale.settle({ original: built.changes, outcome: outcome, deviceId: DEVICE_ID, now: function () { return nowMs === undefined ? NOW + 60000 : nowMs; }, nextRev: nextRev || built.nextRev, randomHex: randomHex });
}
function compareStage(scenarioName, stageIndex, builtChanges) {
  var expected = scenarios[scenarioName].stages[stageIndex].changes;
  assert.strictEqual(builtChanges.length, expected.length, scenarioName + ' stage ' + (stageIndex + 1) + ': number of records');
  for (var i = 0; i < expected.length; i++) {
    assert.deepStrictEqual(sorted(mask(builtChanges[i])), sorted(mask(expected[i])), scenarioName + ' stage ' + (stageIndex + 1) + ': record #' + (i + 1) + ' (' + expected[i].table_name + ') differs from what the app writes');
  }
}

test('a pending Paystack sale = what the app records when it starts an online payment', function () {
  var s = scenarios.paystack_pending_then_paid;
  var pending = pendingOnline(s, [{ productId: productNamed(s, 'Widget').id, name: 'Widget', unitPriceCents: 10000, quantity: 1 }, { productId: productNamed(s, 'Gadget').id, name: 'Gadget', unitPriceCents: 25050, quantity: 1 }]);
  assert.ok(pending.ok, pending.message);
  compareStage('paystack_pending_then_paid', 0, pending.changes);
  assert.strictEqual(pending.changes[0].payload.saleNumber, 'AAAAAA-20261105120000-ZZZZ', 'the sale number is the payment reference');
  assert.strictEqual(pending.receipt.online, true);
  assert.strictEqual(pending.receipt.amountToPayCents, 35050);
});

test('settling as paid = what the app records when Paystack confirms', function () {
  var s = scenarios.paystack_pending_then_paid;
  var pending = pendingOnline(s, [{ productId: productNamed(s, 'Widget').id, name: 'Widget', unitPriceCents: 10000, quantity: 1 }, { productId: productNamed(s, 'Gadget').id, name: 'Gadget', unitPriceCents: 25050, quantity: 1 }]);
  var settled = settleIt(pending, 'paid');
  assert.ok(settled.ok, settled.message);
  compareStage('paystack_pending_then_paid', 1, settled.changes);
  // The SAME sale and payment rows, updated (not new ones), later than before, with the next revisions.
  assert.strictEqual(settled.changes[0].row_id, pending.changes[0].row_id);
  assert.strictEqual(settled.changes[1].row_id, pending.changes[pending.changes.length - 1].row_id);
  assert.ok(settled.changes[0].payload.updatedAt > pending.changes[0].payload.updatedAt);
  assert.strictEqual(settled.changes[0].payload.createdAt, pending.changes[0].payload.createdAt, 'createdAt never changes');
  assert.deepStrictEqual(settled.changes.map(function (c) { return c.local_rev; }), [pending.nextRev, pending.nextRev + 1]);
  assert.strictEqual(settled.nextRev, pending.nextRev + 2);
});

test('settling as cancelled = what the app records when an online payment is abandoned (stock returned)', function () {
  var s = scenarios.paystack_pending_then_cancelled;
  var pending = pendingOnline(s, [{ productId: productNamed(s, 'Widget').id, name: 'Widget', unitPriceCents: 10000, quantity: 2 }], { saleNumber: 'BBBBBB-20261105130000-YYYY' });
  assert.ok(pending.ok, pending.message);
  compareStage('paystack_pending_then_cancelled', 0, pending.changes);
  var cancelled = settleIt(pending, 'cancelled');
  assert.ok(cancelled.ok, cancelled.message);
  compareStage('paystack_pending_then_cancelled', 1, cancelled.changes);
  assert.deepStrictEqual(cancelled.changes.map(function (c) { return c.table_name; }), ['stock_movements', 'sales', 'payment_records']);
  assert.strictEqual(cancelled.changes[0].payload.quantity, 2);
  assert.strictEqual(cancelled.changes[0].payload.userId, null);
});

test('a cancelled online sale returns exactly what each product line took', function () {
  var s = scenarios.paystack_pending_then_paid;
  var w = productNamed(s, 'Widget').id, g = productNamed(s, 'Gadget').id;
  var pending = pendingOnline(s, [{ productId: w, name: 'Widget', unitPriceCents: 10000, quantity: 3 }, { productId: g, name: 'Gadget', unitPriceCents: 25050, quantity: 2 }, { productId: null, name: 'Delivery', unitPriceCents: 500, quantity: 1 }]);
  var cancelled = settleIt(pending, 'cancelled');
  var returns = {};
  cancelled.changes.filter(function (c) { return c.table_name === 'stock_movements'; }).forEach(function (c) { returns[c.payload.productId] = (returns[c.payload.productId] || 0) + c.payload.quantity; });
  var took = {};
  pending.changes.filter(function (c) { return c.table_name === 'stock_movements'; }).forEach(function (c) { took[c.payload.productId] = (took[c.payload.productId] || 0) - c.payload.quantity; });
  assert.deepStrictEqual(returns, took);
  assert.deepStrictEqual(Object.keys(returns).sort(), [w, g].sort(), 'a manual line has no stock to return');
});

test('an update is always strictly later than the version it replaces, even if the clock has not moved', function () {
  var s = scenarios.paystack_pending_then_paid;
  var pending = pendingOnline(s, [{ productId: productNamed(s, 'Widget').id, name: 'Widget', unitPriceCents: 10000, quantity: 1 }]);
  var sameClock = settleIt(pending, 'paid', undefined, NOW);
  assert.ok(sameClock.changes[0].payload.updatedAt > pending.changes[0].payload.updatedAt, sameClock.changes[0].payload.updatedAt + ' vs ' + pending.changes[0].payload.updatedAt);
  var clockBehind = settleIt(pending, 'paid', undefined, NOW - 86400000);
  assert.ok(clockBehind.changes[0].payload.updatedAt > pending.changes[0].payload.updatedAt, 'even an iPad clock set back must not make the update look older');
});

test('only a pending online sale can be settled, and only as paid or cancelled', function () {
  var s = scenarios.paystack_pending_then_paid;
  var w = productNamed(s, 'Widget').id;
  var cash = sell(s, { cart: [{ productId: w, name: 'Widget', unitPriceCents: 10000, quantity: 1 }] });
  assert.strictEqual(settleIt(cash, 'paid').ok, false);
  var pending = pendingOnline(s, [{ productId: w, name: 'Widget', unitPriceCents: 10000, quantity: 1 }]);
  assert.strictEqual(settleIt(pending, 'refunded').ok, false);
  var paid = settleIt(pending, 'paid');
  assert.ok(paid.ok);
  // The settled records (a paid sale) cannot be settled again.
  assert.strictEqual(Sale.settle({ original: paid.changes, outcome: 'paid', deviceId: DEVICE_ID, now: function () { return NOW; }, nextRev: 99, randomHex: randomHex }).ok, false);
});

test('an online sale needs a valid sale number, a total to charge, and never takes cash', function () {
  var s = scenarios.paystack_pending_then_paid;
  var w = productNamed(s, 'Widget').id;
  var cart = [{ productId: w, name: 'Widget', unitPriceCents: 10000, quantity: 1 }];
  assert.strictEqual(sell(s, { cart: cart, paymentMethod: 'paystack', saleNumber: 'not a number' }).ok, false);
  assert.strictEqual(sell(s, { cart: cart, paymentMethod: 'paystack', discountCents: 99999 }).ok, false, 'nothing to charge');
  var online = sell(s, { cart: cart, paymentMethod: 'paystack', cashReceivedCents: 5000, customerPhone: '0712345678' });
  assert.ok(online.ok);
  assert.strictEqual(online.changes[0].payload.cashReceivedCents, null);
  assert.strictEqual(online.changes[0].payload.customerPhone, '0712345678', 'the phone is kept, as the app does for an online sale');
  assert.ok(/^[0-9A-Z]{6}-\d{14}-[0-9A-Z]{4}$/.test(online.changes[0].payload.saleNumber), 'a number is made when none is given');
});
test('wholesale pricing: the wholesale price when set, else retail', function () {
  assert.strictEqual(Sale.priceFor({ retailPriceCents: 10000, wholesalePriceCents: 8000 }, 'wholesale'), 8000);
  assert.strictEqual(Sale.priceFor({ retailPriceCents: 10000, wholesalePriceCents: 0 }, 'wholesale'), 10000);
  assert.strictEqual(Sale.priceFor({ retailPriceCents: 10000, wholesalePriceCents: 8000 }, 'retail'), 10000);
});

var failed = 0;
tests.forEach(function (t) {
  try { t.fn(); } catch (error) { failed++; console.error('FAIL ' + t.name + '\n  ' + (error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n  ') : error)); }
});
if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
console.log('Lite sale builder tests passed: ' + tests.length + ' tests (5 sales match the real app field for field).');
