/*
 * The Lite refund builder must produce exactly what the real NexaPOS app records for the same refund.
 * fixtures/refund_scenarios.json is written by the app's own tests (test/tool/refund_contract_fixtures_test.dart: real sales
 * refunded through the real RefundService, with the sync records captured). Here every refund of those scenarios is rebuilt from
 * what the app had recorded BEFORE it (the sale and the earlier refunds), the choices the person made are read off the app's own
 * refund, and the records this builds are compared with the app's, field for field. Only things that legitimately differ between
 * runs (ids, times, revisions, the refund's number) are masked. The money (discount share, cash share, rounding) is never copied:
 * it is worked out again from the sale.
 *
 * Run: node tests/lite/refund.test.js
 */
'use strict';

var assert = require('assert');
var Sale = require('../../lite/lite-sale.js');
var fixture = require('./fixtures/refund_scenarios.json');

var scenarios = {};
fixture.scenarios.forEach(function (s) { scenarios[s.name] = s; });

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

var NOW = new Date(2026, 10, 16, 9, 30, 5, 123).getTime();
var DEVICE_ID = 'lite-9f3a2c1d5e6b7a8c9d0e1f2a';
function randomHex(bytes) { return require('crypto').randomBytes(bytes).toString('hex'); }

/** What may differ between two runs of the same refund. */
function mask(change) {
  var p = JSON.parse(JSON.stringify(change.payload));
  ['id', 'saleId'].forEach(function (k) { if (k in p) { p[k] = '<id>'; } });
  ['createdAt', 'updatedAt'].forEach(function (k) { p[k] = '<time>'; });
  p.localRev = '<rev>';
  p.createdByDeviceId = '<device>';
  if (p.saleType === 'refund') { p.saleNumber = '<refundNumber>'; }
  if (typeof p.note === 'string') { p.note = p.note.replace(/[0-9A-Z]{6}-\d{14}-[0-9A-Z]{4}/, '<refundNumber>'); }
  return { table_name: change.table_name, payload: p };
}
function sorted(value) {
  if (Array.isArray(value)) { return value.map(sorted); }
  if (value && typeof value === 'object') { var o = {}; Object.keys(value).sort().forEach(function (k) { o[k] = sorted(value[k]); }); return o; }
  return value;
}

function productsOf(scenario) {
  var map = {};
  scenario.context.products.forEach(function (p) { map[p.id] = { id: p.id, name: p.name, status: p.status, costPriceCents: p.costPriceCents }; });
  return map;
}

function copy(value) { return JSON.parse(JSON.stringify(value)); }

/** What the shop's lite_sale would say about the sale after the stages BEFORE [stageNumber] (1 = the sale itself). */
function sourceBefore(scenario, stageNumber) {
  var sale = null;
  var items = [];
  var refunds = [];
  var refundLines = [];
  scenario.stages.forEach(function (stage) {
    if (stage.stage >= stageNumber) { return; }
    stage.changes.forEach(function (c) {
      if (c.table_name === 'sales') {
        if (copy(c.payload).saleType === 'refund') { refunds.push(copy(c.payload)); } else { sale = copy(c.payload); }
      }
      if (c.table_name === 'sale_items') {
        if (copy(c.payload).refundOfItemId) { refundLines.push(copy(c.payload)); } else { items.push(copy(c.payload)); }
      }
    });
  });
  var given = {};
  refundLines.forEach(function (l) { given[l.refundOfItemId] = (given[l.refundOfItemId] || 0) - l.quantity; });
  var sum = function (key) { return refunds.reduce(function (t, r) { return t - (r[key] || 0); }, 0); };
  return {
    sale: sale,
    items: items,
    lines: items.map(function (i) { return { itemId: i.id, quantity: i.quantity, refunded: given[i.id] || 0, remaining: i.quantity - (given[i.id] || 0) }; }),
    refundCount: refunds.length,
    refunded: { subtotalCents: sum('subtotalCents'), discountCents: sum('discountCents'), totalCents: sum('totalCents'), cashCents: sum('cashReceivedCents') }
  };
}

/** The choices the person made in the app's refund of this stage, read off what the app recorded. */
function choicesOf(stage) {
  var refund = stage.changes.filter(function (c) { return c.table_name === 'sales'; })[0].payload;
  var returned = {};
  stage.changes.forEach(function (c) { if (c.table_name === 'stock_movements') { returned[c.payload.productId] = true; } });
  var choices = stage.changes.filter(function (c) { return c.table_name === 'sale_items'; }).map(function (c) {
    return { itemId: c.payload.refundOfItemId, quantity: 0 - c.payload.quantity, restock: !!(c.payload.productId && returned[c.payload.productId]) };
  });
  return { refund: refund, choices: choices };
}

function rebuild(scenario, stage, overrides) {
  var made = choicesOf(stage);
  var input = {
    source: sourceBefore(scenario, stage.stage), choices: made.choices, reason: made.refund.refundReason, products: productsOf(scenario),
    userId: made.refund.userId, deviceId: DEVICE_ID, now: function () { return NOW; }, nextRev: 1, randomHex: randomHex
  };
  for (var k in overrides) { input[k] = overrides[k]; }
  return Sale.buildRefund(input);
}

function sameAsApp(name, stageNumber) {
  var scenario = scenarios[name];
  var stage = scenario.stages.filter(function (s) { return s.stage === stageNumber; })[0];
  var built = rebuild(scenario, stage);
  assert.ok(built.ok, name + ' stage ' + stageNumber + ': ' + built.message);
  assert.strictEqual(built.changes.length, stage.changes.length, name + ' stage ' + stageNumber + ': number of records');
  for (var i = 0; i < stage.changes.length; i++) {
    assert.deepStrictEqual(sorted(mask(built.changes[i])), sorted(mask(stage.changes[i])),
      name + ' stage ' + stageNumber + ': record #' + (i + 1) + ' (' + stage.changes[i].table_name + ') differs from what the app writes');
  }
  return built;
}

// ---- the same refunds as the app's own tests ----------------------------------------------------------------------
test('the whole of a cash sale, put back on the shelf = what the app records', function () { sameAsApp('refund_whole_cash_sale', 2); });
test('part of an M-Pesa sale put back, then the rest thrown away = what the app records', function () {
  sameAsApp('refund_partial_mpesa_sale_in_two_parts', 2);
  sameAsApp('refund_partial_mpesa_sale_in_two_parts', 3);
});
test('a discounted sale refunded one widget at a time (the last takes the rounding) = what the app records', function () {
  [2, 3, 4].forEach(function (n) { sameAsApp('refund_discounted_sale_in_three_parts', n); });
});
test('a split cash + M-Pesa sale with a discount, in two parts (cash share to the cent) = what the app records', function () {
  sameAsApp('refund_split_cash_and_mpesa_sale_with_discount', 2);
  sameAsApp('refund_split_cash_and_mpesa_sale_with_discount', 3);
});
test('a manual item moves no stock = what the app records', function () { sameAsApp('refund_manual_item', 2); });

test('every refund of every scenario is replayed (none is skipped by accident)', function () {
  var replayed = 0;
  fixture.scenarios.forEach(function (s) {
    s.stages.forEach(function (stage) {
      if (stage.stage > 1) {
        sameAsApp(s.name, stage.stage);
        replayed += 1;
      }
    });
  });
  assert.strictEqual(replayed, 11);
});

// ---- the quote ------------------------------------------------------------------------------------------------------
function discountedSource() { return sourceBefore(scenarios.refund_discounted_sale_in_three_parts, 2); }
function widgetLine(source) { return source.items[0].id; }

test('the quote: whole sale, in parts, and the last part takes the rounding so the refunds add up to what was paid', function () {
  var s = scenarios.refund_discounted_sale_in_three_parts;
  var paid = 0;
  [2, 3, 4].forEach(function (n) {
    var source = sourceBefore(s, n);
    var q = Sale.quoteRefund(source, [{ itemId: widgetLine(source), quantity: 1, restock: true }]);
    assert.ok(q.ok, q.message);
    paid += q.totalCents;
  });
  assert.strictEqual(paid, s.stages[0].changes[0].payload.totalCents, 'the three refunds give back exactly what was paid');
});

test('the quote: the discount share and the cash share of a split sale', function () {
  var s = scenarios.refund_split_cash_and_mpesa_sale_with_discount;
  var first = Sale.quoteRefund(sourceBefore(s, 2), [{ itemId: sourceBefore(s, 2).items[0].id, quantity: 1 }]);
  assert.deepStrictEqual(first, { ok: true, subtotalCents: 10000, discountCents: 1000, totalCents: 9000, cashCents: 2500 });
  var second = Sale.quoteRefund(sourceBefore(s, 3), [{ itemId: sourceBefore(s, 3).items[0].id, quantity: 3 }]);
  assert.deepStrictEqual(second, { ok: true, subtotalCents: 30000, discountCents: 3000, totalCents: 27000, cashCents: 7500 });
});

test('the quote: a sale that was not split has no cash share, whatever the payment method', function () {
  var cash = scenarios.refund_whole_cash_sale;
  var source = sourceBefore(cash, 2);
  var q = Sale.quoteRefund(source, source.items.map(function (i) { return { itemId: i.id, quantity: i.quantity }; }));
  assert.ok(q.ok);
  assert.strictEqual(q.cashCents, null);
  var mpesa = scenarios.refund_partial_mpesa_sale_in_two_parts;
  assert.strictEqual(Sale.quoteRefund(sourceBefore(mpesa, 2), [{ itemId: sourceBefore(mpesa, 2).items[0].id, quantity: 1 }]).cashCents, null);
});

test('a cash sale (even one with cash received recorded) has no cash share: only an M-Pesa prompt or till sale can be split', function () {
  var source = sourceBefore(scenarios.refund_whole_cash_sale, 2);
  source.sale.cashReceivedCents = 50000;
  var q = Sale.quoteRefund(source, [{ itemId: source.items[0].id, quantity: 1 }]);
  assert.ok(q.ok);
  assert.strictEqual(q.cashCents, null);
  var built = Sale.buildRefund({ source: source, choices: [{ itemId: source.items[0].id, quantity: 1 }], reason: 'x', products: productsOf(scenarios.refund_whole_cash_sale), userId: 'u', deviceId: DEVICE_ID, now: function () { return NOW; }, nextRev: 1, randomHex: randomHex });
  assert.strictEqual(built.changes[0].payload.cashReceivedCents, null);
  source.sale.paymentMethod = 'mpesa';
  assert.strictEqual(Sale.quoteRefund(source, [{ itemId: source.items[0].id, quantity: 1 }]).cashCents, null, 'an M-Pesa sale of another kind is never split');
  source.sale.paymentMethod = 'mpesa_manual';
  assert.notStrictEqual(Sale.quoteRefund(source, [{ itemId: source.items[0].id, quantity: 1 }]).cashCents, null, 'a till sale with a cash part is split (Sale.isSplitPayment in the app)');
  source.sale.cashReceivedCents = null;
  assert.strictEqual(Sale.quoteRefund(source, [{ itemId: source.items[0].id, quantity: 1 }]).cashCents, null, 'a till sale without a cash part is not');
});

test('the quote refuses what the app refuses, in the same words', function () {
  var source = discountedSource();
  var line = widgetLine(source);
  function why(choices) { var q = Sale.quoteRefund(source, choices); assert.strictEqual(q.ok, false); return q.message; }
  assert.strictEqual(why([]), 'Choose at least one item to refund.');
  assert.strictEqual(why([{ itemId: 'nope', quantity: 1 }]), 'That item is not part of this sale.');
  assert.strictEqual(why([{ itemId: line, quantity: 1 }, { itemId: line, quantity: 1 }]), 'An item is listed twice.');
  assert.strictEqual(why([{ itemId: line, quantity: 0 }]), 'Enter a quantity of 1 or more.');
  assert.strictEqual(why([{ itemId: line, quantity: -1 }]), 'Enter a quantity of 1 or more.');
  assert.strictEqual(why([{ itemId: line, quantity: 1.5 }]), 'Enter a quantity of 1 or more.');
  assert.strictEqual(why([{ itemId: line, quantity: NaN }]), 'Enter a quantity of 1 or more.');
  assert.strictEqual(why([{ itemId: line, quantity: 4 }]), 'Only 3 of Widget can still be refunded.');
});

test('the quote knows what the earlier refunds took (the shop\'s and the ones still waiting on this iPad)', function () {
  var source = discountedSource();
  var line = widgetLine(source);
  source.lines[0].refunded = 2;
  source.refunded = { subtotalCents: 20000, discountCents: 6667, totalCents: 13333, cashCents: 0 };
  assert.strictEqual(Sale.quoteRefund(source, [{ itemId: line, quantity: 2 }]).message, 'Only 1 of Widget can still be refunded.');
  var last = Sale.quoteRefund(source, [{ itemId: line, quantity: 1 }]);
  assert.ok(last.ok);
  assert.strictEqual(last.discountCents, 3333, 'the last part takes the rounding (10000 - 6667)');
  source.lines[0].refunded = 3;
  assert.strictEqual(Sale.quoteRefund(source, [{ itemId: line, quantity: 1 }]).message, 'This sale has already been refunded in full.');
});

test('a refund, an unpaid sale and a sale refunded in full cannot be refunded', function () {
  var source = discountedSource();
  var line = widgetLine(source);
  var refundOfRefund = JSON.parse(JSON.stringify(source)); refundOfRefund.sale.saleType = 'refund';
  assert.strictEqual(Sale.quoteRefund(refundOfRefund, [{ itemId: line, quantity: 1 }]).message, 'A refund cannot be refunded.');
  ['pending', 'cancelled', 'refunded', 'failed'].forEach(function (status) {
    var unpaid = JSON.parse(JSON.stringify(source)); unpaid.sale.status = status;
    assert.strictEqual(Sale.quoteRefund(unpaid, [{ itemId: line, quantity: 1 }]).message, 'Only a paid sale can be refunded.', status);
    assert.strictEqual(Sale.whyNotRefundable(unpaid), 'Only a paid sale can be refunded.');
  });
  assert.strictEqual(Sale.whyNotRefundable(source), null);
});

test('a refund that would give back nothing is refused', function () {
  var source = discountedSource();
  source.items[0].unitPriceCents = 0;
  source.sale.subtotalCents = 0; source.sale.discountCents = 0; source.sale.totalCents = 0;
  assert.strictEqual(Sale.quoteRefund(source, [{ itemId: widgetLine(source), quantity: 1 }]).message, 'There is nothing to refund on those items.');
});

test('roundedShare is exact: it agrees with big-integer arithmetic over thousands of random cases', function () {
  if (typeof BigInt === 'undefined') { return; }
  var seed = 12345;
  function next(max) { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % (max + 1); }
  var exact = 0;
  for (var i = 0; i < 20000; i++) {
    var c = 1 + next(i % 5 === 0 ? 50000000 : 9999);
    var a = next(c);
    var b = next(i % 3 === 0 ? 90000000 : 999999);
    var got = Sale.roundedShare(a, b, c);
    var want = Number((BigInt(a) * BigInt(b) * 2n + BigInt(c)) / (2n * BigInt(c)));
    if (got !== null) { assert.strictEqual(got, want, 'roundedShare(' + a + ',' + b + ',' + c + ')'); exact += 1; }
  }
  assert.ok(exact > 19000, 'nearly all realistic amounts are computed (' + exact + ')');
});

test('roundedShare: halves round up, whole shares, zero and silly input', function () {
  assert.strictEqual(Sale.roundedShare(1, 1, 2), 1, '0.5 rounds up');
  assert.strictEqual(Sale.roundedShare(1, 1, 3), 0);
  assert.strictEqual(Sale.roundedShare(2, 1, 3), 1);
  assert.strictEqual(Sale.roundedShare(4000, 4, 4), 4000);
  assert.strictEqual(Sale.roundedShare(0, 5, 7), 0);
  assert.strictEqual(Sale.roundedShare(5, 7, 0), 0, 'nothing to share out of a total of nothing');
  assert.strictEqual(Sale.roundedShare(-1, 1, 2), null);
  assert.strictEqual(Sale.roundedShare(1, -1, 2), null);
  assert.strictEqual(Sale.roundedShare(1.5, 1, 2), null);
  assert.strictEqual(Sale.roundedShare(NaN, 1, 2), null);
});

test('roundedShare: a whole part that is too big for a browser is refused too, not rounded wrongly', function () {
  assert.strictEqual(Sale.roundedShare(10000000000, 10000000000, 1), null);
  assert.strictEqual(Sale.roundedShare(5000000000000000, 3, 2), null);
  assert.strictEqual(Sale.roundedShare(1000000, 1000000, 1), 1000000000000, 'big but exact');
});

test('a line already refunded in full says so, while another line of the sale can still be refunded', function () {
  var scenario = scenarios.refund_manual_item;
  var source = sourceBefore(scenario, 2);
  var widget = source.items.filter(function (i) { return i.productId; })[0];
  var delivery = source.items.filter(function (i) { return !i.productId; })[0];
  source.lines.forEach(function (l) { if (l.itemId === delivery.id) { l.refunded = 1; l.remaining = 0; } });
  source.refunded = { subtotalCents: 5000, discountCents: 0, totalCents: 5000, cashCents: 0 };
  assert.strictEqual(Sale.quoteRefund(source, [{ itemId: delivery.id, quantity: 1 }]).message, 'Delivery has already been refunded.');
  assert.strictEqual(Sale.quoteRefund(source, [{ itemId: delivery.id, quantity: 2 }]).message, 'Delivery has already been refunded.');
  assert.ok(Sale.quoteRefund(source, [{ itemId: widget.id, quantity: 1 }]).ok);
});

test('the discount share never goes below nothing (an earlier refund that took too much) and the cash share stays within the refund', function () {
  var s = scenarios.refund_split_cash_and_mpesa_sale_with_discount;
  var source = sourceBefore(s, 3);
  var line = source.items[0].id;
  // an earlier refund that already took the whole discount for one widget and more
  source.refunded = { subtotalCents: 10000, discountCents: 9000, totalCents: 1000, cashCents: 0 };
  source.lines[0].refunded = 1; source.lines[0].remaining = 3;
  var q = Sale.quoteRefund(source, [{ itemId: line, quantity: 1 }]);
  assert.ok(q.ok, q.message);
  assert.strictEqual(q.discountCents, 0, 'not a negative discount');
  assert.strictEqual(q.totalCents, 10000);
  // an earlier refund that took too little of the cash: this one never gives back more cash than its own total
  source.refunded = { subtotalCents: 10000, discountCents: 1000, totalCents: 9000, cashCents: 0 };
  var big = Sale.quoteRefund(source, [{ itemId: line, quantity: 3 }]);
  assert.ok(big.ok);
  assert.strictEqual(big.cashCents, 10000, 'it makes up the cash that the earlier refund did not give back (all of the cash of the sale by the end)');
  source.refunded = { subtotalCents: 10000, discountCents: 1000, totalCents: 9000, cashCents: 9999999 };
  assert.strictEqual(Sale.quoteRefund(source, [{ itemId: line, quantity: 1 }]).cashCents, 0, 'never a negative cash share');
  source.refunded = { subtotalCents: 0, discountCents: 0, totalCents: 0, cashCents: -50000 };
  var capped = Sale.quoteRefund(source, [{ itemId: line, quantity: 1 }]);
  assert.strictEqual(capped.cashCents, capped.totalCents, 'the cash share never exceeds the refund');
});

test('a free item (price nothing) is refunded as a plain zero, never a negative zero', function () {
  var scenario = scenarios.refund_manual_item;
  var source = sourceBefore(scenario, 2);
  source.items[0].unitPriceCents = 0;
  source.items[0].lineTotalCents = 0;
  source.sale.subtotalCents = 15000 - 10000; source.sale.totalCents = 5000;
  var free = source.items[0];
  var paid = source.items[1];
  var built = Sale.buildRefund({ source: source, choices: [{ itemId: free.id, quantity: 1 }, { itemId: paid.id, quantity: 1 }], reason: 'Both', products: productsOf(scenario), userId: 'u', deviceId: DEVICE_ID, now: function () { return NOW; }, nextRev: 1, randomHex: randomHex });
  assert.ok(built.ok, built.message);
  var freeLine = built.changes.filter(function (c) { return c.table_name === 'sale_items'; })[0].payload;
  assert.strictEqual(freeLine.lineTotalCents, 0);
  assert.strictEqual(Object.is(freeLine.lineTotalCents, -0), false);
});

test('roundedShare says null (and the refund is refused) when the answer could not be exact in a browser', function () {
  assert.strictEqual(Sale.roundedShare(9000000000000, 9000000000000, 9000000000001), null);
  var source = discountedSource();
  source.sale.discountCents = 3000000000000; source.sale.subtotalCents = 9000000000000; source.sale.totalCents = 6000000000000;
  source.items[0].quantity = 3; source.items[0].unitPriceCents = 3000000000000;
  source.lines[0].quantity = 3;
  var q = Sale.quoteRefund(source, [{ itemId: widgetLine(source), quantity: 1 }]);
  assert.strictEqual(q.ok, false);
  assert.ok(/too big/.test(q.message), q.message);
});

// ---- building -----------------------------------------------------------------------------------------------------------
test('the reason: needed, trimmed, control characters turned into spaces, 200 characters at most', function () {
  var scenario = scenarios.refund_whole_cash_sale;
  var stage = scenario.stages[1];
  function reasonResult(text) { return rebuild(scenario, stage, { reason: text }); }
  assert.strictEqual(reasonResult('').message, 'Enter the reason for the refund.');
  assert.strictEqual(reasonResult('   ').message, 'Enter the reason for the refund.');
  assert.strictEqual(reasonResult(null).message, 'Enter the reason for the refund.');
  assert.strictEqual(reasonResult(undefined).message, 'Enter the reason for the refund.');
  assert.strictEqual(reasonResult('\n\t').message, 'Enter the reason for the refund.');
  assert.strictEqual(reasonResult(new Array(202).join('x')).message, 'The reason is too long (200 characters at most).');
  assert.strictEqual(reasonResult(new Array(202).join('x')).ok, false);
  var longest = reasonResult(new Array(201).join('x'));
  assert.ok(longest.ok, '200 characters are fine');
  assert.strictEqual(longest.changes[0].payload.refundReason.length, 200);
  var odd = reasonResult('  Wrong\u0001goods\n  ');
  assert.ok(odd.ok);
  assert.strictEqual(odd.changes[0].payload.refundReason, 'Wrong goods', 'trimmed, a control character becomes a space (the shop refuses control characters)');
  var edges = reasonResult('\u0001Wrong goods\u0007');
  assert.strictEqual(edges.changes[0].payload.refundReason, 'Wrong goods', 'a control character at either end leaves no space at the end');
});

test('the reason is checked before anything else, as the app does (a blank reason on a bad refund says the reason)', function () {
  var scenario = scenarios.refund_whole_cash_sale;
  var built = rebuild(scenario, scenario.stages[1], { reason: '', choices: [] });
  assert.strictEqual(built.message, 'Enter the reason for the refund.');
});

test('stock goes back only for a product the till still knows; the cost comes back only with the goods', function () {
  var scenario = scenarios.refund_whole_cash_sale;
  var stage = scenario.stages[1];
  var known = rebuild(scenario, stage);
  assert.strictEqual(known.changes.filter(function (c) { return c.table_name === 'stock_movements'; }).length, 2);
  var none = rebuild(scenario, stage, { products: {} });
  assert.ok(none.ok);
  assert.strictEqual(none.changes.filter(function (c) { return c.table_name === 'stock_movements'; }).length, 0, 'a product that is gone gets no stock back');
  none.changes.filter(function (c) { return c.table_name === 'sale_items'; }).forEach(function (c) {
    assert.strictEqual(c.payload.costPriceCents, 0, 'thrown-away goods keep their cost with the shop');
  });
  var onlyOne = {};
  var firstId = known.changes.filter(function (c) { return c.table_name === 'stock_movements'; })[0].payload.productId;
  onlyOne[firstId] = { id: firstId };
  var partial = rebuild(scenario, stage, { products: onlyOne });
  assert.strictEqual(partial.changes.filter(function (c) { return c.table_name === 'stock_movements'; }).length, 1);
});

test('"do not put back in stock" (restock false) moves no stock and zeroes the cost of that line only', function () {
  var scenario = scenarios.refund_whole_cash_sale;
  var stage = scenario.stages[1];
  var made = choicesOf(stage);
  made.choices[0].restock = false;
  var built = Sale.buildRefund({ source: sourceBefore(scenario, 2), choices: made.choices, reason: 'Damaged', products: productsOf(scenario), userId: made.refund.userId, deviceId: DEVICE_ID, now: function () { return NOW; }, nextRev: 1, randomHex: randomHex });
  assert.ok(built.ok, built.message);
  var lines = built.changes.filter(function (c) { return c.table_name === 'sale_items'; });
  assert.strictEqual(lines[0].payload.costPriceCents, 0);
  assert.ok(lines[1].payload.costPriceCents > 0, 'the other line still gets its cost back');
  assert.strictEqual(built.changes.filter(function (c) { return c.table_name === 'stock_movements'; }).length, 1);
});

test('restock left out means yes (the app\'s default); only false means no', function () {
  var scenario = scenarios.refund_whole_cash_sale;
  var made = choicesOf(scenario.stages[1]);
  made.choices.forEach(function (c) { delete c.restock; });
  var built = Sale.buildRefund({ source: sourceBefore(scenario, 2), choices: made.choices, reason: 'Wrong goods', products: productsOf(scenario), userId: made.refund.userId, deviceId: DEVICE_ID, now: function () { return NOW; }, nextRev: 1, randomHex: randomHex });
  assert.strictEqual(built.changes.filter(function (c) { return c.table_name === 'stock_movements'; }).length, 2);
});

test('the records are well formed: ids, times, revisions, number, relations, signs', function () {
  var scenario = scenarios.refund_partial_mpesa_sale_in_two_parts;
  var made = choicesOf(scenario.stages[1]);
  var built = Sale.buildRefund({ source: sourceBefore(scenario, 2), choices: made.choices, reason: 'Bent', products: productsOf(scenario), userId: made.refund.userId, deviceId: DEVICE_ID, now: function () { return NOW; }, nextRev: 41, randomHex: randomHex });
  assert.ok(built.ok);
  var ids = {};
  built.changes.forEach(function (c, i) {
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c.payload.id), 'v4 uuid: ' + c.payload.id);
    assert.ok(!ids[c.payload.id], 'unique id');
    ids[c.payload.id] = true;
    assert.strictEqual(c.row_id, c.payload.id);
    assert.strictEqual(c.local_rev, 41 + i, 'consecutive revisions in write order');
    assert.strictEqual(c.payload.localRev, c.local_rev);
    assert.strictEqual(c.updated_at, c.payload.updatedAt);
    assert.strictEqual(c.payload.createdAt, c.payload.updatedAt);
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(c.payload.updatedAt), 'app time format: ' + c.payload.updatedAt);
    assert.strictEqual(c.payload.deletedAt, null);
    assert.strictEqual(c.payload.createdByDeviceId, DEVICE_ID);
    assert.strictEqual(c.payload.syncState, 'local_only');
  });
  assert.strictEqual(built.nextRev, 41 + built.changes.length);
  assert.deepStrictEqual(built.changes.map(function (c) { return c.table_name; }), ['sales', 'sale_items', 'stock_movements', 'payment_records']);
  var refund = built.changes[0].payload;
  assert.ok(/^[0-9A-Z]{6}-\d{14}-[0-9A-Z]{4}$/.test(refund.saleNumber), refund.saleNumber);
  assert.strictEqual(refund.saleType, 'refund');
  assert.strictEqual(refund.status, 'paid');
  assert.strictEqual(refund.refundOfSaleId, sourceBefore(scenario, 2).sale.id);
  assert.ok(refund.totalCents < 0 && refund.subtotalCents < 0 && refund.discountCents <= 0);
  assert.strictEqual(Object.is(refund.discountCents, -0), false, 'no negative zero');
  assert.strictEqual(refund.paymentMethod, 'mpesa_manual');
  assert.strictEqual(built.changes[1].payload.saleId, refund.id);
  assert.strictEqual(built.changes[3].payload.saleId, refund.id);
  assert.strictEqual(built.changes[3].payload.amountCents, refund.totalCents);
  assert.strictEqual(built.changes[3].payload.status, 'refunded');
  assert.strictEqual(built.changes[3].payload.referenceNote, 'Refund of ' + sourceBefore(scenario, 2).sale.saleNumber);
  assert.strictEqual(built.changes[2].payload.note, 'Refund ' + refund.saleNumber);
  assert.strictEqual(built.changes[2].payload.userId, made.refund.userId, 'the stock return is by the person who refunded');
});

test('a cash refund has no payment record; an M-Pesa one has exactly one', function () {
  var cash = sameAsApp('refund_whole_cash_sale', 2);
  assert.strictEqual(cash.changes.filter(function (c) { return c.table_name === 'payment_records'; }).length, 0);
  var mpesa = sameAsApp('refund_partial_mpesa_sale_in_two_parts', 2);
  assert.strictEqual(mpesa.changes.filter(function (c) { return c.table_name === 'payment_records'; }).length, 1);
});

test('the receipt says what went back to the customer, as positive money', function () {
  var built = sameAsApp('refund_split_cash_and_mpesa_sale_with_discount', 2);
  var r = built.receipt;
  assert.strictEqual(r.isRefund, true);
  assert.strictEqual(r.saleId, built.changes[0].payload.id);
  assert.strictEqual(r.saleNumber, built.changes[0].payload.saleNumber);
  assert.strictEqual(r.refundOfSaleNumber, sourceBefore(scenarios.refund_split_cash_and_mpesa_sale_with_discount, 2).sale.saleNumber);
  assert.strictEqual(r.reason, 'one');
  assert.strictEqual(r.subtotalCents, 10000);
  assert.strictEqual(r.discountCents, 1000);
  assert.strictEqual(r.totalCents, 9000);
  assert.strictEqual(r.cashBackCents, 2500);
  assert.deepStrictEqual(r.lines, [{ name: 'Widget', quantity: 1, unitPriceCents: 10000, lineTotalCents: 10000, restocked: true }]);
  assert.strictEqual(r.createdAt, NOW);
});

test('nothing is built from a refused refund, and building never changes what it was given', function () {
  var scenario = scenarios.refund_whole_cash_sale;
  var made = choicesOf(scenario.stages[1]);
  var source = sourceBefore(scenario, 2);
  var copyOfSource = JSON.stringify(source);
  var copyOfChoices = JSON.stringify(made.choices);
  var ok = Sale.buildRefund({ source: source, choices: made.choices, reason: 'x', products: productsOf(scenario), userId: made.refund.userId, deviceId: DEVICE_ID, now: function () { return NOW; }, nextRev: 1, randomHex: randomHex });
  assert.ok(ok.ok);
  assert.strictEqual(JSON.stringify(source), copyOfSource);
  assert.strictEqual(JSON.stringify(made.choices), copyOfChoices);
  var bad = Sale.buildRefund({ source: source, choices: [{ itemId: 'nope', quantity: 1 }], reason: 'x', products: {}, userId: 'u', deviceId: DEVICE_ID, now: function () { return NOW; }, nextRev: 1, randomHex: randomHex });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.changes, undefined);
});

test('a sale whose customer is missing is refunded as a walk-in, a phone that is missing as none (as the shop checks it)', function () {
  var scenario = scenarios.refund_whole_cash_sale;
  var source = sourceBefore(scenario, 2);
  delete source.sale.customerName;
  delete source.sale.customerPhone;
  var made = choicesOf(scenario.stages[1]);
  var built = Sale.buildRefund({ source: source, choices: made.choices, reason: 'x', products: productsOf(scenario), userId: made.refund.userId, deviceId: DEVICE_ID, now: function () { return NOW; }, nextRev: 1, randomHex: randomHex });
  assert.ok(built.ok);
  assert.strictEqual(built.changes[0].payload.customerName, 'Walk-in customer');
  assert.strictEqual(built.changes[0].payload.customerPhone, null);
});

var failed = 0;
tests.forEach(function (t) {
  try { t.fn(); } catch (error) { failed++; console.error('FAIL ' + t.name + '\n  ' + (error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n  ') : error)); }
});
if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
console.log('Lite refund builder tests passed: ' + tests.length + ' tests (11 refunds in 6 scenarios match the real app field for field).');
