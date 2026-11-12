/*
 * "Today on this iPad": what the till sold since midnight, split by how it was paid, from the sales it remembers.
 * Finished sales only; unpaid/cancelled online payments and sales the shop refused or the owner removed are left out;
 * the figures say when the iPad may already have forgotten some of today's sales (it keeps the latest 100).
 *
 * Run: node tests/lite/today.test.js
 */
'use strict';

var assert = require('assert');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var BASE = 'https://sync.test/index.php';
var CASHIER = '44444444-4444-4444-8444-444444444444';
var OWNER = '33333333-3333-4333-8333-333333333333';
var SODA = '11111111-1111-4111-8111-111111111111';
// 7 March 2026, 15:30 on the iPad's own clock (the till counts from the iPad's midnight)
var AFTERNOON = new Date(2026, 2, 7, 15, 30, 0).getTime();
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
function fakeServer(routes) {
  function http(request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    var body = request.body ? JSON.parse(request.body) : null;
    var handler = routes[request.method + ' ' + action];
    var result = handler ? handler(request, body) : { status: 404, body: { success: false } };
    setImmediate(function () {
      if (result === 'offline') { cb(new Error('network')); return; }
      cb(null, { status: result.status, text: JSON.stringify(result.body) });
    });
  }
  return http;
}
function catalogBody() {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-03-07T10:00:00Z', cursor: 5,
    license: { state: 'active', valid_until: null, never_expires: true },
    business: { businessName: 'Mama Mboga', currency: 'KES' },
    categories: [{ id: 'c1', name: 'Drinks', status: 'active' }],
    products: [{ id: SODA, sku: 'S1', name: 'Soda', barcode: null, categoryId: 'c1', retailPriceCents: 6000, wholesalePriceCents: 5000, costPriceCents: 4000, reorderLevel: 5, status: 'active', stockQty: 5000 }],
    users: [
      { id: CASHIER, roleId: '00000000-0000-4000-8000-000000000003', name: 'Wanjiru', username: 'cash', passwordHash: fixtures[0].hash, status: 'active' },
      { id: OWNER, roleId: '00000000-0000-4000-8000-000000000001', name: 'Owner', username: 'owner', passwordHash: fixtures[0].hash, status: 'active' }
    ],
    roles: []
  };
}
var seed = 1;
function randomHex(n) { var s = ''; while (s.length < n * 2) { seed = (seed * 1103515245 + 12345) % 2147483648; s += ('00000000' + seed.toString(16)).slice(-8); } return s.slice(0, n * 2); }

function till(done) {
  var storage = fakeStorage();
  var clock = { now: AFTERNOON };
  var mode = { push: 'ok', verify: 'ongoing' };
  var http = fakeServer({
    'POST register_device': function () { return { status: 201, body: { success: true, api_key: 'key-1' } }; },
    'POST join_shop': function () { return { status: 200, body: { success: true } }; },
    'GET lite_catalog': function () { return { status: 200, body: catalogBody() }; },
    'POST push_changes': function () {
      if (mode.push === 'refuse') { return { status: 422, body: { success: false, message: 'Could not record changes: nope' } }; }
      return { status: 200, body: { success: true } };
    },
    'POST charge_mobile_money': function (request, body) {
      return { status: 200, body: { status: true, message: 'Charge attempted', data: { reference: body.reference, status: 'pay_offline' } } };
    },
    'GET verify_transaction': function (request) {
      var reference = decodeURIComponent(/reference=([^&]+)/.exec(request.url)[1]);
      return { status: 200, body: { status: true, message: 'ok', data: { status: mode.verify, reference: reference, amount: 6000, currency: 'KES' } } };
    }
  });
  var core = Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, now: function () { return clock.now; }, randomHex: randomHex });
  core.join('INV', 'Till', function (error) {
    assert.ifError(error);
    core.login('cash', 'Passw0rd!', function (loginError) {
      assert.ifError(loginError);
      done({ core: core, clock: clock, mode: mode, storage: storage, http: http });
    });
  });
}
function sell(t, qty, method) {
  var result = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: qty }], saleType: 'retail', paymentMethod: method || 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: null });
  assert.ok(result.ok, result.message);
  return result.receipt;
}

test('a day with no sales is all zeros, and complete', function (done) {
  till(function (t) {
    assert.deepStrictEqual(t.core.todaySummary(), { sales: 0, items: 0, totalCents: 0, cashCents: 0, mpesaCents: 0, onlineCents: 0, complete: true });
    done();
  });
});

test('sales are added up by how they were paid, with the item count', function (done) {
  till(function (t) {
    sell(t, 2, 'cash');
    sell(t, 1, 'cash');
    sell(t, 3, 'mpesa_manual');
    sell(t, 1, 'mpesa_manual');
    assert.deepStrictEqual(t.core.todaySummary(), { sales: 4, items: 7, totalCents: 42000, cashCents: 18000, mpesaCents: 24000, onlineCents: 0, complete: true });
    done();
  });
});

test('a discount counts as the money actually taken', function (done) {
  till(function (t) {
    var result = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 2 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 1500, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: null });
    assert.ok(result.ok);
    assert.strictEqual(t.core.todaySummary().totalCents, 10500);
    assert.strictEqual(t.core.todaySummary().cashCents, 10500);
    done();
  });
});

test('yesterday is not today: the day starts at the iPad\'s midnight', function (done) {
  till(function (t) {
    t.clock.now = new Date(2026, 2, 6, 23, 59, 59).getTime();
    sell(t, 5, 'cash'); // one second before midnight
    t.clock.now = new Date(2026, 2, 7, 0, 0, 0).getTime();
    sell(t, 1, 'cash'); // exactly midnight
    t.clock.now = AFTERNOON;
    sell(t, 2, 'mpesa_manual');
    assert.deepStrictEqual(t.core.todaySummary(), { sales: 2, items: 3, totalCents: 18000, cashCents: 6000, mpesaCents: 12000, onlineCents: 0, complete: true });
    t.clock.now = new Date(2026, 2, 8, 9, 0, 0).getTime(); // next morning: all of it is yesterday
    assert.strictEqual(t.core.todaySummary().sales, 0);
    done();
  });
});

test('an online payment counts only once it is paid, and never if it was cancelled', function (done) {
  till(function (t) {
    t.core.startOnline({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 1 }], saleType: 'retail', mpesaPhone: '0712 345 678', customerPhone: '0712 345 678' }, function (error, started) {
      assert.ifError(error);
      assert.strictEqual(t.core.todaySummary().sales, 0, 'waiting for the customer: not a sale yet');
      t.mode.verify = 'success';
      t.core.checkOnline(function (checkError) {
        assert.ifError(checkError);
        assert.deepStrictEqual(t.core.todaySummary(), { sales: 1, items: 1, totalCents: 6000, cashCents: 0, mpesaCents: 0, onlineCents: 6000, complete: true });
        t.mode.verify = 'ongoing';
        t.core.startOnline({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 1 }], saleType: 'retail', mpesaPhone: '0712 345 678', customerPhone: '0712 345 678' }, function (error2, second) {
          assert.ifError(error2);
          assert.strictEqual(t.core.todaySummary().sales, 1, 'the second one is still waiting');
          t.core.cancelOnline(second.receipt.saleId, function (cancelError) {
            assert.ifError(cancelError);
            assert.strictEqual(t.core.todaySummary().sales, 1, 'cancelled: not a sale');
            assert.strictEqual(t.core.todaySummary().totalCents, 6000);
            done();
          });
        });
      });
    });
  });
});

test('a sale the shop refused is not counted, and neither is one the owner removed', function (done) {
  till(function (t) {
    sell(t, 1, 'cash');
    t.core.flush(function (flushError) {
      assert.ifError(flushError);
      assert.strictEqual(t.core.todaySummary().sales, 1, 'recorded by the shop');
      t.mode.push = 'refuse';
      var refused = sell(t, 2, 'cash');
      assert.strictEqual(t.core.todaySummary().sales, 2, 'saved on the iPad, not sent yet: still a real sale');
      t.core.flush(function () {
        assert.deepStrictEqual(t.core.history().map(function (h) { return h.status; }), ['rejected', 'sent']);
        assert.deepStrictEqual(t.core.todaySummary(), { sales: 1, items: 1, totalCents: 6000, cashCents: 6000, mpesaCents: 0, onlineCents: 0, complete: true });
        t.core.logout();
        t.core.login('owner', 'Passw0rd!', function (error) {
          assert.ifError(error);
          assert.ok(t.core.discardRejected(refused.saleId).ok);
          assert.strictEqual(t.core.history()[0].status, 'discarded');
          assert.strictEqual(t.core.todaySummary().sales, 1, 'removed: still not counted');
          done();
        });
      });
    });
  });
});

test('the figures say when the iPad may have forgotten some of today\'s sales (it keeps the latest 100)', function (done) {
  till(function (t) {
    for (var i = 0; i < 99; i++) { sell(t, 1, 'cash'); }
    assert.strictEqual(t.core.history().length, 99);
    assert.strictEqual(t.core.todaySummary().complete, true, '99 kept: nothing forgotten yet');
    sell(t, 1, 'cash');
    assert.strictEqual(t.core.history().length, 100);
    var full = t.core.todaySummary();
    assert.strictEqual(full.sales, 100);
    assert.strictEqual(full.complete, false, 'the oldest one kept is from today, so earlier ones may be gone');
    done();
  });
});

test('a full memory is still complete when the oldest sale kept is from before today', function (done) {
  till(function (t) {
    t.clock.now = new Date(2026, 2, 6, 12, 0, 0).getTime();
    sell(t, 1, 'cash'); // yesterday
    t.clock.now = AFTERNOON;
    for (var i = 0; i < 99; i++) { sell(t, 1, 'cash'); }
    assert.strictEqual(t.core.history().length, 100);
    var summary = t.core.todaySummary();
    assert.strictEqual(summary.sales, 99, 'yesterday\'s is not counted');
    assert.strictEqual(summary.complete, true, 'everything from today is still remembered');
    done();
  });
});

test('totals survive closing the page, and asking changes nothing', function (done) {
  till(function (t) {
    sell(t, 2, 'cash');
    var before = JSON.stringify(t.storage.data);
    var asked = t.core.todaySummary();
    assert.strictEqual(JSON.stringify(t.storage.data), before, 'nothing written');
    var again = Core.create({ baseUrl: BASE, http: t.http, storage: t.storage, bcrypt: bcrypt, sale: Sale, now: function () { return t.clock.now; }, randomHex: randomHex });
    assert.deepStrictEqual(again.todaySummary(), asked);
    done();
  });
});

var failed = 0;
(function run(index) {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite today-totals tests passed: ' + tests.length + ' tests.');
    return;
  }
  var t = tests[index];
  var finished = false;
  var timer = setTimeout(function () { if (!finished) { finished = true; failed++; console.error('FAIL (timeout) ' + t.name); run(index + 1); } }, 60000);
  try {
    t.fn(function () { if (finished) { return; } finished = true; clearTimeout(timer); run(index + 1); });
  } catch (error) {
    finished = true; clearTimeout(timer); failed++;
    console.error('FAIL ' + t.name + '\n  ' + (error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n  ') : error));
    run(index + 1);
  }
}(0));

process.on('uncaughtException', function (error) {
  console.error('FAIL (uncaught): ' + (error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n  ') : error));
  process.exit(1);
});
