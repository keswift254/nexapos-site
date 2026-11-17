/*
 * Selling with "M-Pesa Till/Paybill" in the Lite core: the customer paid the shop's own till or paybill, and the till asks the
 * shop to use the M-Pesa code on THIS sale (payment_inbox_claim) before it saves anything. A pretend shop server records what
 * the till sends and answers as the real one does.
 *
 * Run: node tests/lite/tillsale.test.js
 */
'use strict';

process.env.TZ = 'Africa/Nairobi';

var assert = require('assert');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var BASE = 'https://sync.test/index.php';
var PASSWORD = fixtures[0].password;
var SODA = '11111111-1111-4111-8111-111111111111';
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function fakeStorage() {
  var data = {};
  return {
    data: data,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}
function catalogBody() {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-11-18T10:00:00Z', cursor: 5,
    license: { state: 'active', valid_until: null, never_expires: true },
    business: { businessName: 'Mama Mboga', currency: 'KES' },
    categories: [],
    products: [{ id: SODA, sku: 'S1', name: 'Soda', barcode: null, categoryId: null, retailPriceCents: 6000, wholesalePriceCents: 5000, costPriceCents: 4000, reorderLevel: 5, status: 'active', stockQty: 10 }],
    users: [
      { id: '33333333-3333-4333-8333-333333333333', roleId: '00000000-0000-4000-8000-000000000003', name: 'Wanjiru', username: 'wanjiru', passwordHash: fixtures[0].hash, status: 'active' },
      { id: '44444444-4444-4444-8444-444444444444', roleId: '00000000-0000-4000-8000-000000000003', name: 'Otieno', username: 'otieno', passwordHash: fixtures[0].hash, status: 'active' }
    ],
    roles: []
  };
}

/** A joined till with the cashier logged in. answer(request) -> {status, body} | 'offline' | 'hold' (t.release(result) later). */
function till(answer, done) {
  var sent = [];
  var held = [];
  var storage = fakeStorage();
  var clock = { now: Date.parse('2026-11-18T10:00:00Z') };
  var http = function (request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    var result;
    if (action === 'register_device') { result = { status: 201, body: { success: true, api_key: 'key-1' } }; }
    else if (action === 'join_shop') { result = { status: 200, body: { success: true } }; }
    else if (action === 'lite_catalog') { result = { status: 200, body: catalogBody() }; }
    else if (action === 'push_changes') { result = { status: 200, body: { success: true } }; sent.push({ action: action, body: JSON.parse(request.body) }); }
    else {
      var seen = { method: request.method, url: request.url, action: action, body: request.body ? JSON.parse(request.body) : null, auth: request.headers.Authorization };
      sent.push(seen);
      result = answer(seen);
    }
    function reply(r) {
      setImmediate(function () {
        if (r === 'offline') { cb(new Error('network')); return; }
        cb(null, { status: r.status, text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) });
      });
    }
    if (result === 'hold') { held.push(reply); } else { reply(result); }
  };
  var core = Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, now: function () { return clock.now; }, randomHex: Core.randomHex });
  core.join('INV', 'Till', function (error) {
    assert.ifError(error);
    core.login('wanjiru', PASSWORD, function (loginError) {
      assert.ifError(loginError);
      done({ core: core, sent: sent, storage: storage, clock: clock, release: function (r) { held.shift()(r); },
        claims: function () { return sent.filter(function (s) { return s.action === 'payment_inbox_claim'; }); },
        releases: function () { return sent.filter(function (s) { return s.action === 'payment_inbox_release'; }); } });
    });
  });
}
/** The shop's answer when the code is used on the sale it was asked for. */
function usedOn(paidCents) {
  return function (request) {
    if (request.action === 'payment_inbox_release') { return { status: 200, body: { success: true, released: true } }; }
    return { status: 200, body: { success: true, confirmed: true, payment: {
      code: request.body.code, message_received: true, amount_cents: paidCents === undefined ? request.body.amount_cents : paidCents,
      payer_name: 'JOHN DOE', payer_phone: '254712345678', account_ref: null, paid_at_text: '18/11/26 1:05 PM', message: '...',
      received_at: '2026-11-18T10:05:00Z', phone_label: 'iPhone 11',
      used: { sale_id: request.body.sale_id, sale_number: request.body.sale_number, amount_cents: request.body.amount_cents, at: '2026-11-18T10:06:00Z' }
    } } };
  };
}
function refusal(status, reason, message, extra) {
  return function (request) {
    if (request.action === 'payment_inbox_release') { return { status: 200, body: { success: true, released: false } }; }
    var body = { success: false, reason: reason, message: message };
    for (var k in (extra || {})) { body[k] = extra[k]; }
    return { status: status, body: body };
  };
}
var TWO_SODAS = { cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 2 }], saleType: 'retail', discountCents: 0 };
function request(extra) {
  var r = { cart: TWO_SODAS.cart, saleType: 'retail', discountCents: 0, code: 'SJK2TILL9X' };
  for (var k in (extra || {})) { r[k] = extra[k]; }
  return r;
}
function outboxSale(t) {
  var entry = JSON.parse(t.storage.data['nexapos-lite-v1']).outbox[0];
  var byTable = {};
  entry.changes.forEach(function (c) { (byTable[c.table_name] = byTable[c.table_name] || []).push(c); });
  return { entry: entry, byTable: byTable };
}

// ---- a sale paid to the till -----------------------------------------------------------------------------------------------------
test('the shop is asked to use the code on THIS sale (its id, number and total; the message must be there), then the sale is saved', function (done) {
  till(usedOn(), function (t) {
    t.core.sellTill(request({ code: ' sjk2 till-9x ' }), function (result) {
      assert.strictEqual(result.ok, true, JSON.stringify(result));
      var claims = t.claims();
      assert.strictEqual(claims.length, 1);
      assert.strictEqual(claims[0].method, 'POST');
      assert.ok(/\?action=payment_inbox_claim$/.test(claims[0].url));
      assert.strictEqual(claims[0].auth, 'Bearer key-1');
      assert.deepStrictEqual(claims[0].body, {
        code: 'SJK2TILL9X', sale_id: result.receipt.saleId, sale_number: result.receipt.saleNumber, amount_cents: 12000,
        require_message: true, accept_amount: false
      });
      assert.strictEqual(result.receipt.paymentMethod, 'mpesa_manual');
      assert.strictEqual(result.receipt.referenceNote, 'SJK2TILL9X');
      assert.strictEqual(result.receipt.totalCents, 12000);
      assert.strictEqual(result.receipt.cashierName, 'Wanjiru');
      assert.strictEqual(result.payment.payerName, 'JOHN DOE');
      done();
    });
  });
});

test('the saved sale is the apps\' "M-Pesa (Manual)" sale: paid, one paid payment record for the total with the code as its reference', function (done) {
  till(usedOn(), function (t) {
    t.core.sellTill(request(), function (result) {
      assert.strictEqual(result.ok, true);
      var saved = outboxSale(t);
      var sale = saved.byTable.sales[0].payload;
      assert.strictEqual(sale.id, result.receipt.saleId, 'the very sale the code was used on');
      assert.strictEqual(sale.saleNumber, result.receipt.saleNumber);
      assert.strictEqual(sale.paymentMethod, 'mpesa_manual');
      assert.strictEqual(sale.status, 'paid');
      assert.strictEqual(sale.totalCents, 12000);
      assert.strictEqual(sale.cashReceivedCents, null, 'cash received never goes with an M-Pesa sale');
      assert.strictEqual(saved.byTable.payment_records.length, 1);
      var payment = saved.byTable.payment_records[0].payload;
      assert.deepStrictEqual([payment.saleId, payment.method, payment.amountCents, payment.referenceNote, payment.status], [sale.id, 'mpesa_manual', 12000, 'SJK2TILL9X', 'paid']);
      assert.strictEqual(saved.byTable.stock_movements[0].payload.quantity, -2, 'the stock goes out as for any sale');
      assert.strictEqual(t.core.todaySummary().mpesaCents, 12000, 'today\'s totals count it as M-Pesa');
      done();
    });
  });
});

test('the receipt says M-Pesa (Manual) with the code, as the apps print it', function (done) {
  till(usedOn(), function (t) {
    t.core.sellTill(request(), function (result) {
      var sheet = JSON.stringify(t.core.receiptSheet(result.receipt, false));
      assert.ok(sheet.indexOf('M-Pesa (Manual)') >= 0, sheet);
      assert.ok(sheet.indexOf('SJK2TILL9X') >= 0);
      done();
    });
  });
});

// ---- nothing is sold when the shop says no ---------------------------------------------------------------------------------------
function nothingSold(t) {
  assert.strictEqual(JSON.parse(t.storage.data['nexapos-lite-v1']).outbox.length, 0, 'nothing waits to be sent');
  assert.strictEqual(t.core.history().length, 0, 'no sale in the history');
  assert.strictEqual(t.core.todaySummary().sales, 0);
}

test('no payment with that code has arrived: nothing is sold, and the cashier is told to check the code or wait', function (done) {
  till(refusal(404, 'not_received', 'No M-Pesa message with this code has arrived yet.'), function (t) {
    t.core.sellTill(request(), function (result) {
      assert.deepStrictEqual([result.ok, result.code], [false, 'not_received']);
      assert.strictEqual(result.message, 'No M-Pesa payment with this code has reached the shop yet. Check the code, or wait a few seconds after the customer pays and try again.');
      nothingSold(t);
      done();
    });
  });
});

test('a code already used on another sale is refused with the shop\'s words (which sale), and nothing is sold', function (done) {
  till(refusal(409, 'used', 'This M-Pesa code was already used on sale ABC-1.', { sale_number: 'ABC-1' }), function (t) {
    t.core.sellTill(request(), function (result) {
      assert.deepStrictEqual([result.ok, result.code, result.message], [false, 'used', 'This M-Pesa code was already used on sale ABC-1.']);
      nothingSold(t);
      done();
    });
  });
});

test('a payment SMALLER than the sale is refused outright: there is no going ahead', function (done) {
  till(refusal(409, 'amount_differs', 'The customer paid a different amount from this sale.', { amount_cents: 10000 }), function (t) {
    t.core.sellTill(request(), function (result) {
      assert.deepStrictEqual([result.ok, result.code, result.paidCents, result.totalCents], [false, 'short', 10000, 12000]);
      assert.strictEqual(result.message, 'The customer paid KES 100.00, which is KES 20.00 less than this sale (KES 120.00). Use a payment that covers the whole sale.');
      nothingSold(t);
      done();
    });
  });
});

test('a payment BIGGER than the sale: the cashier is asked, and going ahead sends accept_amount and saves the sale', function (done) {
  var first = true;
  till(function (r) {
    if (first && r.action === 'payment_inbox_claim') { first = false; return refusal(409, 'amount_differs', 'x', { amount_cents: 15000 })(r); }
    return usedOn(15000)(r);
  }, function (t) {
    t.core.sellTill(request(), function (asked) {
      assert.deepStrictEqual([asked.ok, asked.code, asked.paidCents, asked.totalCents], [false, 'amount_differs', 15000, 12000]);
      nothingSold(t);
      t.core.sellTill(request({ acceptAmount: true }), function (result) {
        assert.strictEqual(result.ok, true);
        assert.strictEqual(t.claims()[1].body.accept_amount, true);
        assert.strictEqual(result.payment.amountCents, 15000, 'the page works out the KES 30 to give back from this');
        assert.strictEqual(outboxSale(t).byTable.payment_records[0].payload.amountCents, 12000, 'the record is for the sale\'s total, as the apps write it');
        done();
      });
    });
  });
});

test('accept_amount is only ever sent when asked for (true, not just anything)', function (done) {
  till(usedOn(), function (t) {
    t.core.sellTill(request({ acceptAmount: 'yes' }), function () {
      assert.strictEqual(t.claims()[0].body.accept_amount, false);
      done();
    });
  });
});

test('an amount the shop could not read is said as such (the cashier may go ahead after checking the phone)', function (done) {
  till(refusal(409, 'amount_unknown', 'x'), function (t) {
    t.core.sellTill(request(), function (result) {
      assert.deepStrictEqual([result.ok, result.code, result.totalCents], [false, 'amount_unknown', 12000]);
      nothingSold(t);
      done();
    });
  });
});

test('no internet, an old shop server, a device that is not allowed: nothing is sold and it is said plainly', function (done) {
  var cases = [
    ['offline', 'offline', 'Checking an M-Pesa payment needs the internet. Nothing was sold. Try again when this iPad is online, or take Cash.'],
    [{ status: 404, body: { success: false, status: false, message: 'Unknown action.' } }, 'unavailable', 'The shop server cannot check M-Pesa payments yet. Ask the owner to update it.'],
    [{ status: 401, body: { status: false, message: 'Invalid or missing API key.' } }, 'unauthorized', 'This iPad is not allowed to do this. Ask the owner to check Connected devices.'],
    [{ status: 500, body: { success: false, message: 'Server error.' } }, 'server', 'Server error.']
  ];
  var index = 0;
  (function next() {
    if (index >= cases.length) { done(); return; }
    var c = cases[index++];
    till(function () { return c[0]; }, function (t) {
      t.core.sellTill(request(), function (result) {
        assert.deepStrictEqual([result.ok, result.code, result.message], [false, c[1], c[2]], 'case ' + index);
        nothingSold(t);
        next();
      });
    });
  }());
});

test('an answer the till cannot read: nothing is sold and the code is given back', function (done) {
  var bodies = [{ success: true }, { success: true, payment: { code: 'OTHER1CODE', message_received: true } }, { success: false, payment: {} }, 'not json'];
  var index = 0;
  (function next() {
    if (index >= bodies.length) { done(); return; }
    var body = bodies[index++];
    till(function (r) { return r.action === 'payment_inbox_release' ? { status: 200, body: { success: true, released: true } } : { status: 200, body: body }; }, function (t) {
      t.core.sellTill(request(), function (result) {
        if (body === 'not json') {
          assert.strictEqual(result.code, 'server', 'an answer that is not JSON at all is a server problem');
        } else {
          assert.deepStrictEqual([result.ok, result.code], [false, 'server'], 'case ' + index);
          setTimeout(function () {
            assert.strictEqual(t.releases().length, 1, 'case ' + index + ': the code is given back');
            assert.deepStrictEqual(t.releases()[0].body, { code: 'SJK2TILL9X', sale_id: t.claims()[0].body.sale_id });
            nothingSold(t);
            next();
          }, 20);
          return;
        }
        nothingSold(t);
        next();
      });
    });
  }());
});

// ---- before anything is sent ------------------------------------------------------------------------------------------------------
test('a code that cannot be one is refused on the iPad: nothing is sent', function (done) {
  till(usedOn(), function (t) {
    var bad = ['', '   ', 'short', 'ABCDEFGHIJ', '1234567890', 'SJK2TILL9X123', 'SJK2TILL!X', null, undefined];
    var index = 0;
    (function next() {
      if (index >= bad.length) {
        assert.strictEqual(t.claims().length, 0);
        nothingSold(t);
        done();
        return;
      }
      t.core.sellTill(request({ code: bad[index++] }), function (result) {
        assert.strictEqual(result.code, 'input', 'case ' + index);
        assert.ok(/M-Pesa code/.test(result.message));
        next();
      });
    }());
  });
});

test('a sale that cannot be built (empty cart, too many) is refused before the shop is asked', function (done) {
  till(usedOn(), function (t) {
    t.core.sellTill(request({ cart: [] }), function (a) {
      assert.deepStrictEqual([a.ok, a.code, a.message], [false, 'input', 'Add at least one product to the sale.']);
      t.core.sellTill(request({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 11 }] }), function (b) {
        assert.deepStrictEqual([b.ok, b.code, b.message], [false, 'input', 'Only 10 Soda in stock.']);
        assert.strictEqual(t.claims().length, 0);
        done();
      });
    });
  });
});

test('when the till may not sell (logged out), nothing is sent', function (done) {
  till(usedOn(), function (t) {
    t.core.logout();
    t.core.sellTill(request(), function (result) {
      assert.deepStrictEqual([result.ok, result.code, result.message], [false, 'input', 'Log in first.']);
      assert.strictEqual(t.claims().length, 0);
      done();
    });
  });
});

test('one at a time: a second tap while the shop is checking waits', function (done) {
  till(function () { return 'hold'; }, function (t) {
    var first = null;
    t.core.sellTill(request(), function (r) { first = r; });
    t.core.sellTill(request(), function (second) {
      assert.deepStrictEqual([second.ok, second.code], [false, 'busy']);
      assert.strictEqual(t.claims().length, 1);
      t.release(usedOn()(t.claims()[0]));
      setTimeout(function () {
        assert.strictEqual(first.ok, true);
        assert.strictEqual(JSON.parse(t.storage.data['nexapos-lite-v1']).outbox.length, 1, 'one sale, not two');
        done();
      }, 20);
    });
  });
});

test('logged out while the shop was answering: nothing is sold and the code is given back for the next try', function (done) {
  till(function (r) { return r.action === 'payment_inbox_release' ? { status: 200, body: { success: true, released: true } } : 'hold'; }, function (t) {
    t.core.sellTill(request(), function (result) {
      assert.deepStrictEqual([result.ok, result.code], [false, 'logged_out']);
      setTimeout(function () {
        assert.deepStrictEqual(t.releases().map(function (r) { return r.body; }), [{ code: 'SJK2TILL9X', sale_id: t.claims()[0].body.sale_id }]);
        nothingSold(t);
        done();
      }, 20);
    });
    t.core.logout();
    t.core.login('otieno', PASSWORD, function (error) {
      assert.ifError(error);
      t.release(usedOn()(t.claims()[0]));
    });
  });
});

test('a cash sale saved while the shop was answering: both sales keep their own revisions, none twice', function (done) {
  till(function () { return 'hold'; }, function (t) {
    t.core.sellTill(request(), function (result) {
      assert.strictEqual(result.ok, true);
      var outbox = JSON.parse(t.storage.data['nexapos-lite-v1']).outbox;
      assert.strictEqual(outbox.length, 2);
      var revs = [];
      outbox.forEach(function (entry) { entry.changes.forEach(function (c) { revs.push(c.local_rev); assert.strictEqual(c.local_rev, c.payload.localRev); }); });
      var sorted = revs.slice().sort(function (a, b) { return a - b; });
      for (var i = 1; i < sorted.length; i++) { assert.ok(sorted[i] > sorted[i - 1], 'revision ' + sorted[i] + ' used twice'); }
      assert.strictEqual(JSON.parse(t.storage.data['nexapos-lite-v1']).nextRev, sorted[sorted.length - 1] + 1, 'the next free revision follows the last one used');
      assert.strictEqual(outbox[1].receipt.saleId, t.claims()[0].body.sale_id, 'the till sale is still the sale the code was used on');
      done();
    });
    var cash = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: null });
    assert.strictEqual(cash.ok, true);
    t.release(usedOn()(t.claims()[0]));
  });
});

// ---- the payments to pick from ---------------------------------------------------------------------------------------------------
test('the list to pick from is the payments that arrived and no sale has used, newest first, with how many phones the shop has', function (done) {
  till(function () {
    return { status: 200, body: { success: true, phones: 1, payments: [
      { code: 'NEW1PAYM3N', message_received: true, amount_cents: 61000, payer_name: 'JACINTA', used: null },
      { code: 'USED1PAYM3', message_received: true, amount_cents: 50000, payer_name: 'HENRY', used: { sale_id: 's', sale_number: 'N-1', amount_cents: 50000, at: null } },
      { code: 'TYP3DCODE1', message_received: false, amount_cents: null, used: { sale_id: 's2', sale_number: 'N-2', amount_cents: 100, at: null } },
      { code: 'N0MESSAGE1', message_received: false, amount_cents: null, payer_name: null, used: null },
      { code: 'OLD1PAYM3N', message_received: true, amount_cents: 8000, payer_name: 'MWANCHANI', used: null }
    ] } };
  }, function (t) {
    t.core.unusedTillPayments(6, function (error, list, phones) {
      assert.ifError(error);
      assert.ok(/action=payment_inbox_list&hours=6$/.test(t.sent[t.sent.length - 1].url));
      assert.deepStrictEqual(list.map(function (p) { return p.code; }), ['NEW1PAYM3N', 'OLD1PAYM3N']);
      assert.strictEqual(phones, 1);
      done();
    });
  });
});

test('the M-Pesa code rule is the shop\'s: capitals, no spaces or dashes, 8 to 12 letters AND numbers', function () {
  var core = Core.create({ baseUrl: BASE, http: function () {}, storage: fakeStorage(), bcrypt: bcrypt, sale: Sale, now: function () { return 1; }, randomHex: Core.randomHex });
  assert.strictEqual(core.mpesaCode(' ukh3 r3nl-tu '), 'UKH3R3NLTU');
  assert.strictEqual(core.mpesaCode('UKH3R3N1'), 'UKH3R3N1', '8 is enough');
  assert.strictEqual(core.mpesaCode('UKH3R3NLTU12'), 'UKH3R3NLTU12', '12 is the most');
  ['UKH3R3N', 'UKH3R3NLTU123', 'ABCDEFGHIJ', '1234567890', 'UKH3R3NL!U', '', null, undefined].forEach(function (bad) {
    assert.strictEqual(core.mpesaCode(bad), null, String(bad));
  });
});

var failed = 0;
var index = 0;
(function next() {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite till sale tests passed: ' + tests.length + ' tests.');
    return;
  }
  var t = tests[index++];
  var finished = false;
  var timer = setTimeout(function () { if (!finished) { finished = true; failed++; console.error('FAIL ' + t.name + '\n  timed out'); next(); } }, 15000);
  try {
    if (t.fn.length === 0) { t.fn(); finished = true; clearTimeout(timer); next(); return; }
    t.fn(function () { if (!finished) { finished = true; clearTimeout(timer); next(); } });
  } catch (error) {
    if (!finished) { finished = true; clearTimeout(timer); failed++; console.error('FAIL ' + t.name + '\n  ' + (error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n  ') : error)); next(); }
  }
}());
process.on('uncaughtException', function (error) {
  console.error('FAIL (uncaught): ' + (error && error.stack ? error.stack.split('\n').slice(0, 8).join('\n  ') : error));
  process.exit(1);
});
