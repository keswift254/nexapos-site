/*
 * Online (Paystack) sales through the Lite core: Paystack is asked first, the sale is saved as pending with its
 * stock reserved, and it is settled as paid or cancelled only when Paystack's answer (or the cashier, after one
 * last check) says so. Paystack and the server are faked here; the real server is exercised by
 * sale-integration.js, and the sale records themselves are compared with the real app in sale.test.js.
 *
 * Run: node tests/lite/online.test.js
 */
'use strict';

var assert = require('assert');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var BASE = 'https://sync.test/index.php';
var NOW = Date.UTC(2026, 10, 8, 10, 0, 0);
var CASHIER = '44444444-4444-4444-8444-444444444444';
var SODA = '11111111-1111-4111-8111-111111111111';
var BREAD = '22222222-2222-4222-8222-222222222222';
var REFERENCE = /^[0-9A-Z]{6}-\d{14}-[0-9A-Z]{4}$/;
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
  var calls = [];
  function http(request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    var body = request.body ? JSON.parse(request.body) : null;
    calls.push({ action: action, headers: request.headers, body: body, url: request.url });
    var handler = routes[request.method + ' ' + action];
    var result = handler ? handler(request, body, calls.length) : { status: 404, body: { success: false, message: 'No such route.' } };
    setImmediate(function () {
      if (result === 'offline') { cb(new Error('down')); } else { cb(null, { status: result.status, text: JSON.stringify(result.body) }); }
    });
  }
  http.calls = calls;
  return http;
}

function catalogBody() {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-11-08T10:00:00Z', cursor: 5,
    license: { state: 'active', valid_until: null, never_expires: true },
    business: { businessName: 'Mama Mboga', currency: 'KES' },
    categories: [{ id: 'c1', name: 'Drinks', status: 'active' }],
    products: [
      { id: SODA, sku: 'S1', name: 'Soda', barcode: null, categoryId: 'c1', retailPriceCents: 6000, wholesalePriceCents: 5000, costPriceCents: 4000, reorderLevel: 5, status: 'active', stockQty: 10 },
      { id: BREAD, sku: 'S2', name: 'Bread', barcode: null, categoryId: 'c1', retailPriceCents: 7500, wholesalePriceCents: 0, costPriceCents: 6000, reorderLevel: 1, status: 'active', stockQty: 3 }
    ],
    users: [
      { id: CASHIER, roleId: '00000000-0000-4000-8000-000000000003', name: 'Cashier', username: 'cash', passwordHash: fixtures[0].hash, status: 'active' }
    ],
    roles: []
  };
}

/** A pretend Paystack: remembers what was initialised, and answers verification from `verdicts[reference]`. */
function paystack() {
  var p = { initiated: {}, initCalls: [], verifyCalls: [], verdicts: {}, initAnswer: null, onInit: null };
  p.routes = {
    'POST initialize_transaction': function (request, body) {
      p.initCalls.push(body);
      if (p.onInit) { p.onInit(body); }
      if (p.initAnswer) { return p.initAnswer; }
      p.initiated[body.reference] = body;
      return { status: 200, body: { status: true, message: 'Authorization URL created', data: { authorization_url: 'https://checkout.paystack.com/' + body.reference, access_code: 'ac', reference: body.reference } } };
    },
    'GET verify_transaction': function (request) {
      var reference = decodeURIComponent(/reference=([^&]+)/.exec(request.url)[1]);
      p.verifyCalls.push(reference);
      var verdict = p.verdicts[reference] || { status: 'ongoing' };
      if (verdict === 'offline') { return 'offline'; }
      if (verdict.http) { return { status: verdict.http, body: { status: false, message: verdict.message || 'Transaction not found.' } }; }
      var asked = p.initiated[reference] || {};
      return { status: 200, body: { status: verdict.outer === undefined ? true : verdict.outer, message: 'Verification successful', data: {
        status: verdict.status, reference: reference,
        amount: verdict.amount === undefined ? asked.amount : verdict.amount,
        currency: verdict.currency === undefined ? asked.currency : verdict.currency
      } } };
    }
  };
  return p;
}

var seed = 1;
function randomHex(n) { var s = ''; while (s.length < n * 2) { seed = (seed * 1103515245 + 12345) % 2147483648; s += ('00000000' + seed.toString(16)).slice(-8); } return s.slice(0, n * 2); }

function newCore(storage, http, clock) {
  return Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, now: function () { return clock.now; }, randomHex: randomHex });
}

/** A joined, logged-in cashier till with a pretend Paystack. */
function till(pushHandler) {
  return function (done) {
    var p = paystack();
    var routes = {
      'POST register_device': function () { return { status: 201, body: { success: true, api_key: 'key-1' } }; },
      'POST join_shop': function () { return { status: 200, body: { success: true } }; },
      'GET lite_catalog': function () { return { status: 200, body: catalogBody() }; },
      'POST push_changes': pushHandler || function () { return { status: 200, body: { success: true } }; }
    };
    for (var k in p.routes) { routes[k] = p.routes[k]; }
    var storage = fakeStorage();
    var clock = { now: NOW };
    var http = fakeServer(routes);
    var core = newCore(storage, http, clock);
    core.join('INV', 'Till', function (error) {
      assert.ifError(error);
      core.login('cash', 'Passw0rd!', function (loginError) {
        assert.ifError(loginError);
        done({ core: core, storage: storage, clock: clock, http: http, calls: http.calls, paystack: p });
      });
    });
  };
}

function onlineSale(qty, extra) {
  var request = { cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: qty || 1 }], saleType: 'retail' };
  for (var k in extra) { request[k] = extra[k]; }
  return request;
}
function cashSale(qty) { return { cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: qty || 1 }], saleType: 'retail', paymentMethod: 'cash' }; }
function stockOf(core, id) { return core.searchProducts('', null, true).filter(function (p) { return p.id === id; })[0].stockQty; }
function savedState(t) { return JSON.parse(t.storage.data['nexapos-lite-v1']); }
function pushes(calls) { return calls.filter(function (c) { return c.action === 'push_changes'; }); }
function kinds(t) { return savedState(t).outbox.map(function (e) { return e.kind; }); }
function rowOf(changes, table) { return changes.filter(function (c) { return c.table_name === table; })[0].payload; }

/** Starts an online sale and hands back {result, reference}. */
function start(t, qty, extra, then) {
  t.core.startOnline(onlineSale(qty, extra), function (error, result) {
    assert.ifError(error);
    then(result, result.reference);
  });
}

// ---- starting -------------------------------------------------------------------------------------------------
test('Paystack is asked first; then the sale is saved as pending with its stock reserved', function (done) {
  till()(function (t) {
    t.core.startOnline(onlineSale(2), function (error, result) {
      assert.ifError(error);
      assert.ok(REFERENCE.test(result.reference), result.reference);
      assert.strictEqual(result.authorizationUrl, 'https://checkout.paystack.com/' + result.reference);
      assert.deepStrictEqual(t.paystack.initCalls, [{ email: 'till@nexapos.cc', amount: 12000, currency: 'KES', reference: result.reference, return_to: 'lite' }]);
      assert.strictEqual(t.calls.filter(function (c) { return c.action === 'initialize_transaction'; })[0].headers.Authorization, 'Bearer key-1');
      assert.strictEqual(stockOf(t.core, SODA), 8, 'the two sodas are reserved');
      assert.strictEqual(t.core.getStatus().pendingSales, 1);
      assert.strictEqual(t.core.getStatus().onlineWaiting, 1);
      var sale = savedState(t).outbox[0];
      assert.strictEqual(sale.kind, 'sale');
      assert.strictEqual(rowOf(sale.changes, 'sales').status, 'pending');
      assert.strictEqual(rowOf(sale.changes, 'sales').paymentMethod, 'paystack');
      assert.strictEqual(rowOf(sale.changes, 'sales').saleNumber, result.reference, 'the sale number is the payment reference');
      assert.strictEqual(rowOf(sale.changes, 'payment_records').status, 'initiated');
      assert.strictEqual(rowOf(sale.changes, 'payment_records').referenceNote, result.reference);
      assert.strictEqual(t.core.history()[0].payment, 'awaiting');
      assert.strictEqual(t.core.online().length, 1);
      assert.strictEqual(t.core.online()[0].authorizationUrl, result.authorizationUrl, 'the payment link is kept to show again');
      assert.strictEqual(pushes(t.calls).length, 0, 'starting does not send the sale itself');
      done();
    });
  });
});

test('the customer phone, when given, goes to Paystack (digits only)', function (done) {
  till()(function (t) {
    start(t, 1, { customerPhone: '0712 345-678' }, function () {
      assert.strictEqual(t.paystack.initCalls[0].customer_phone, '0712345678');
      var noPhone = t.paystack.initCalls[0];
      assert.ok(noPhone.amount === 6000);
      done();
    });
  });
});

test('no phone given: none is sent', function (done) {
  till()(function (t) {
    start(t, 1, {}, function () {
      assert.ok(!('customer_phone' in t.paystack.initCalls[0]));
      done();
    });
  });
});

test('nothing is recorded when Paystack does not accept the payment', function (done) {
  var answers = [
    ['offline', 'offline', /internet/],
    [{ status: 422, body: { status: false, message: 'Complete payment settings before accepting Paystack payments.' } }, 'server', /Complete payment settings/],
    [{ status: 502, body: { status: false, message: 'Could not reach Paystack: timeout' } }, 'server', /Could not reach Paystack/],
    [{ status: 200, body: { status: false, message: 'Invalid key' } }, 'server', /Nothing was charged/],
    [{ status: 200, body: { status: true, data: {} } }, 'server', /Nothing was charged/],
    [{ status: 200, body: { status: false, message: 'Invalid key', data: { authorization_url: 'https://checkout.paystack.com/x' } } }, 'server', /Nothing was charged/]
  ];
  till()(function (t) {
    var revBefore = savedState(t).nextRev;
    (function next(i) {
      if (i >= answers.length) { done(); return; }
      t.paystack.initAnswer = answers[i][0];
      t.core.startOnline(onlineSale(2), function (error, result) {
        assert.ok(error, 'answer ' + i + ' must fail');
        assert.ok(!result);
        assert.strictEqual(error.code, answers[i][1], 'answer ' + i);
        assert.ok(answers[i][2].test(error.message), error.message);
        assert.strictEqual(stockOf(t.core, SODA), 10, 'no stock reserved');
        assert.strictEqual(savedState(t).outbox.length, 0);
        assert.strictEqual(t.core.online().length, 0);
        assert.strictEqual(t.core.history().length, 0);
        assert.strictEqual(savedState(t).nextRev, revBefore, 'no revision numbers used');
        next(i + 1);
      });
    }(0));
  });
});

test('an invalid online sale never reaches Paystack', function (done) {
  till()(function (t) {
    t.core.startOnline(onlineSale(5, { cart: [{ productId: BREAD, name: 'Bread', unitPriceCents: 7500, quantity: 5 }] }), function (error) {
      assert.strictEqual(error.message, 'Only 3 Bread in stock.');
      t.core.startOnline(onlineSale(1, { discountCents: 999999 }), function (error2) {
        assert.ok(error2);
        t.core.startOnline({ cart: [], saleType: 'retail' }, function (error3) {
          assert.ok(error3);
          t.core.logout();
          t.core.startOnline(onlineSale(1), function (error4) {
            assert.strictEqual(error4.message, 'Log in first.');
            assert.strictEqual(t.paystack.initCalls.length, 0);
            done();
          });
        });
      });
    });
  });
});

test('selling is blocked for a lapsed licence before Paystack is asked', function (done) {
  till()(function (t) {
    t.clock.now = Date.UTC(2099, 0, 1);
    var state = savedState(t);
    state.catalog.license = { state: 'active', valid_until: '2026-01-01T00:00:00Z', never_expires: false };
    t.storage.data['nexapos-lite-v1'] = JSON.stringify(state);
    var reloaded = newCore(t.storage, t.http, t.clock);
    reloaded.login('cash', 'Passw0rd!', function () {
      reloaded.startOnline(onlineSale(1), function (error) {
        assert.ok(error && /expired/.test(error.message), error && error.message);
        assert.strictEqual(t.paystack.initCalls.length, 0);
        done();
      });
    });
  });
});

// ---- checking ---------------------------------------------------------------------------------------------------
test('a payment not made yet keeps waiting, whatever Paystack calls it, and nothing is settled', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      var statuses = ['ongoing', 'pending', 'abandoned', 'failed', 'reversed', 'queued', ''];
      (function next(i) {
        if (i >= statuses.length) { done(); return; }
        t.paystack.verdicts[reference] = { status: statuses[i] };
        t.core.checkOnline(function (error, outcome) {
          assert.ifError(error);
          assert.deepStrictEqual(outcome, { paid: 0, waiting: 1 }, statuses[i]);
          assert.deepStrictEqual(kinds(t), ['sale'], 'no settle for ' + statuses[i]);
          assert.strictEqual(stockOf(t.core, SODA), 8);
          assert.strictEqual(t.core.notices().length, 0);
          next(i + 1);
        });
      }(0));
    });
  });
});

test('a confirmed payment settles the sale as paid, queued after the sale itself', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'success' };
      t.core.checkOnline(function (error, outcome) {
        assert.ifError(error);
        assert.deepStrictEqual(outcome, { paid: 1, waiting: 0 });
        assert.strictEqual(t.core.online().length, 0);
        assert.deepStrictEqual(kinds(t), ['sale', 'settle-paid']);
        assert.strictEqual(stockOf(t.core, SODA), 8, 'a paid sale keeps its stock out');
        assert.strictEqual(t.core.history()[0].payment, 'paid');
        var notices = t.core.notices();
        assert.strictEqual(notices.length, 1);
        assert.strictEqual(notices[0].kind, 'ok');
        assert.ok(notices[0].text.indexOf(reference) >= 0 && notices[0].text.indexOf('120.00') >= 0, notices[0].text);
        t.core.flush(function (flushError, flushed) {
          assert.ifError(flushError);
          assert.strictEqual(flushed.sent, 2);
          var sent = pushes(t.calls);
          assert.strictEqual(sent.length, 2);
          assert.strictEqual(rowOf(sent[0].body.changes, 'sales').status, 'pending', 'the sale goes first, pending');
          assert.deepStrictEqual(sent[1].body.changes.map(function (c) { return c.table_name; }), ['sales', 'payment_records']);
          assert.strictEqual(rowOf(sent[1].body.changes, 'sales').status, 'paid');
          assert.strictEqual(rowOf(sent[1].body.changes, 'payment_records').status, 'paid');
          assert.ok(sent[1].body.changes[0].local_rev > sent[0].body.changes[sent[0].body.changes.length - 1].local_rev, 'newer revisions');
          assert.strictEqual(t.core.history()[0].status, 'sent');
          done();
        });
      });
    });
  });
});

test('a payment whose amount or currency does not match is never accepted', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      var wrong = [{ status: 'success', amount: 100 }, { status: 'success', amount: 12001 }, { status: 'success', currency: 'USD' }, { status: 'success', currency: '' }, { status: 'success', amount: undefined, currency: undefined, outer: false }];
      t.paystack.verdicts[reference] = wrong[0];
      (function next(i) {
        if (i >= wrong.length) { done(); return; }
        t.paystack.verdicts[reference] = wrong[i];
        if (i === 4) { t.paystack.verdicts[reference] = { status: 'success', outer: false }; }
        t.core.checkOnline(function (error, outcome) {
          assert.ifError(error);
          assert.strictEqual(outcome.paid, 0, 'case ' + i);
          assert.deepStrictEqual(kinds(t), ['sale'], 'case ' + i);
          assert.strictEqual(t.core.online().length, 1);
          next(i + 1);
        });
      }(0));
    });
  });
});

test('a mismatching payment leaves a loud notice telling the owner', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'success', amount: 100 };
      t.core.checkOnline(function () {
        var notices = t.core.notices();
        assert.strictEqual(notices.length, 1);
        assert.strictEqual(notices[0].kind, 'bad');
        assert.ok(notices[0].text.indexOf(reference) >= 0);
        done();
      });
    });
  });
});

test('a mismatch is reported once per payment, not on every check', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'success', amount: 100 };
      t.core.checkOnline(function () {
        t.core.checkOnline(function () {
          t.core.checkOnline(function () {
            assert.strictEqual(t.core.notices().length, 1);
            done();
          });
        });
      });
    });
  });
});

test('a payment that does not match its amount cannot be cancelled by the cashier', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'success', amount: 100 };
      t.core.cancelOnline(result.receipt.saleId, function (error) {
        assert.ok(error && /does not match/.test(error.message), error && error.message);
        assert.strictEqual(t.core.online().length, 1);
        assert.deepStrictEqual(kinds(t), ['sale']);
        assert.strictEqual(stockOf(t.core, SODA), 8);
        done();
      });
    });
  });
});

test('no internet or no record while checking: it keeps waiting and says so', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = 'offline';
      t.core.checkOnline(function (error, outcome) {
        assert.strictEqual(error.code, 'offline');
        assert.strictEqual(outcome.waiting, 1);
        t.paystack.verdicts[reference] = { http: 404, message: 'Transaction not found.' };
        t.core.checkOnline(function (error2, outcome2) {
          assert.ok(error2);
          assert.strictEqual(outcome2.paid, 0);
          assert.strictEqual(t.core.online().length, 1);
          assert.deepStrictEqual(kinds(t), ['sale']);
          t.paystack.verdicts[reference] = { status: 'success' };
          t.core.checkOnline(function (error3, outcome3) {
            assert.ifError(error3);
            assert.strictEqual(outcome3.paid, 1, 'and it still settles when the answer finally comes');
            done();
          });
        });
      });
    });
  });
});

test('checking twice at the same moment checks once and settles once', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'success' };
      var first = null;
      var second = null;
      t.core.checkOnline(function (e, o) {
        first = o;
        assert.strictEqual(first.paid, 1);
        assert.ok(second && second.busy === true, 'the second request was told a check is already running');
        assert.strictEqual(t.paystack.verifyCalls.length, 1);
        assert.deepStrictEqual(kinds(t), ['sale', 'settle-paid']);
        done();
      });
      t.core.checkOnline(function (e, o) { second = o; });
    });
  });
});

test('a check and a cancel running together settle the payment once, never twice', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      start(t, 1, {}, function (other, otherRef) {
        t.paystack.verdicts[reference] = { status: 'success' };
        var finished = 0;
        function oneDone() {
          finished += 1;
          if (finished < 2) { return; }
          assert.deepStrictEqual(kinds(t), ['sale', 'sale', 'settle-paid'], 'one settle only');
          assert.deepStrictEqual(t.core.online().map(function (o) { return o.saleNumber; }), [otherRef], 'the other waiting payment is untouched');
          assert.strictEqual(stockOf(t.core, SODA), 7);
          done();
        }
        t.core.checkOnline(function () { oneDone(); });
        t.core.cancelOnline(result.receipt.saleId, function () { oneDone(); });
      });
    });
  });
});

test('two payments are tracked separately; only the confirmed one settles', function (done) {
  till()(function (t) {
    start(t, 1, {}, function (first, firstRef) {
      t.clock.now += 5000;
      start(t, 2, {}, function (second, secondRef) {
        assert.notStrictEqual(firstRef, secondRef);
        assert.strictEqual(stockOf(t.core, SODA), 7);
        t.paystack.verdicts[secondRef] = { status: 'success' };
        t.core.checkOnline(function (error, outcome) {
          assert.ifError(error);
          assert.deepStrictEqual(outcome, { paid: 1, waiting: 1 });
          assert.deepStrictEqual(t.core.online().map(function (o) { return o.saleNumber; }), [firstRef]);
          assert.deepStrictEqual(kinds(t), ['sale', 'sale', 'settle-paid']);
          assert.strictEqual(savedState(t).outbox[2].receipt.saleNumber, secondRef);
          done();
        });
      });
    });
  });
});

// ---- cancelling -------------------------------------------------------------------------------------------------
test('cancelling checks one last time: a payment that just arrived is kept, not cancelled', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'success' };
      t.core.cancelOnline(result.receipt.saleId, function (error, outcome) {
        assert.ifError(error);
        assert.strictEqual(outcome.outcome, 'paid');
        assert.deepStrictEqual(kinds(t), ['sale', 'settle-paid']);
        assert.strictEqual(stockOf(t.core, SODA), 8);
        assert.strictEqual(t.paystack.verifyCalls.length, 1);
        done();
      });
    });
  });
});

test('cancelling an unpaid sale puts the stock back and queues the cancellation behind the sale', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'abandoned' };
      t.core.cancelOnline(result.receipt.saleId, function (error, outcome) {
        assert.ifError(error);
        assert.strictEqual(outcome.outcome, 'cancelled');
        assert.strictEqual(stockOf(t.core, SODA), 10, 'stock is back');
        assert.strictEqual(t.core.online().length, 0);
        assert.deepStrictEqual(kinds(t), ['sale', 'settle-cancelled']);
        assert.strictEqual(t.core.history()[0].payment, 'cancelled');
        assert.strictEqual(t.core.notices()[0].kind, 'warn');
        t.core.flush(function (flushError, flushed) {
          assert.ifError(flushError);
          assert.strictEqual(flushed.sent, 2);
          var second = pushes(t.calls)[1].body.changes;
          assert.deepStrictEqual(second.map(function (c) { return c.table_name; }), ['stock_movements', 'sales', 'payment_records']);
          assert.strictEqual(second[0].payload.quantity, 2);
          assert.strictEqual(second[0].payload.movementType, 'return');
          assert.strictEqual(rowOf(second, 'sales').status, 'cancelled');
          assert.strictEqual(rowOf(second, 'payment_records').status, 'failed');
          done();
        });
      });
    });
  });
});

test('cancelling needs the internet (it cannot be sure otherwise) and changes nothing without it', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = 'offline';
      t.core.cancelOnline(result.receipt.saleId, function (error) {
        assert.strictEqual(error.code, 'offline');
        assert.ok(/Cannot cancel/.test(error.message), error.message);
        assert.strictEqual(t.core.online().length, 1);
        assert.deepStrictEqual(kinds(t), ['sale']);
        assert.strictEqual(stockOf(t.core, SODA), 8);
        t.paystack.verdicts[reference] = { http: 404 };
        t.core.cancelOnline(result.receipt.saleId, function (error2) {
          assert.ok(error2, 'a record Paystack cannot find is not proof of no payment');
          assert.strictEqual(t.core.online().length, 1);
          done();
        });
      });
    });
  });
});

test('cancelling a payment that is not waiting is refused', function (done) {
  till()(function (t) {
    t.core.cancelOnline('nope', function (error) {
      assert.ok(error);
      assert.strictEqual(t.paystack.verifyCalls.length, 0);
      start(t, 1, {}, function (result, reference) {
        t.paystack.verdicts[reference] = { status: 'abandoned' };
        t.core.cancelOnline(result.receipt.saleId, function (first) {
          assert.ifError(first);
          t.core.cancelOnline(result.receipt.saleId, function (again) {
            assert.ok(again, 'a second cancel does nothing');
            assert.strictEqual(stockOf(t.core, SODA), 10, 'stock is not returned twice');
            assert.deepStrictEqual(kinds(t), ['sale', 'settle-cancelled']);
            done();
          });
        });
      });
    });
  });
});

// ---- keeping them safe ---------------------------------------------------------------------------------------------
test('waiting payments survive closing the page, and a fresh page can settle them', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      var again = newCore(t.storage, t.http, t.clock);
      assert.strictEqual(again.getStatus().onlineWaiting, 1);
      assert.strictEqual(again.online()[0].saleNumber, reference);
      assert.strictEqual(again.online()[0].authorizationUrl, result.authorizationUrl);
      again.login('cash', 'Passw0rd!', function (loginError) {
        assert.ifError(loginError);
        t.paystack.verdicts[reference] = { status: 'success' };
        again.checkOnline(function (error, outcome) {
          assert.ifError(error);
          assert.strictEqual(outcome.paid, 1);
          var state = JSON.parse(t.storage.data['nexapos-lite-v1']);
          assert.deepStrictEqual(state.outbox.map(function (e) { return e.kind; }), ['sale', 'settle-paid']);
          assert.strictEqual(state.online.length, 0);
          done();
        });
      });
    });
  });
});

test('a till saved before online payments existed still opens', function (done) {
  till()(function (t) {
    var state = savedState(t);
    delete state.online;
    delete state.notices;
    t.storage.data['nexapos-lite-v1'] = JSON.stringify(state);
    var reloaded = newCore(t.storage, t.http, t.clock);
    assert.deepStrictEqual(reloaded.online(), []);
    assert.deepStrictEqual(reloaded.notices(), []);
    assert.strictEqual(reloaded.getStatus().onlineWaiting, 0);
    done();
  });
});

test('revision numbers are never reused after a settle, so later sales cannot clash with it', function (done) {
  till()(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'abandoned' };
      t.core.cancelOnline(result.receipt.saleId, function (error) {
        assert.ifError(error);
        assert.ok(t.core.sell(cashSale(1)).ok);
        var state = savedState(t);
        var used = {};
        var highest = 0;
        state.outbox.forEach(function (entry) {
          entry.changes.forEach(function (change) {
            assert.ok(!used[change.local_rev], 'revision ' + change.local_rev + ' was used twice');
            used[change.local_rev] = true;
            highest = Math.max(highest, change.local_rev);
          });
        });
        assert.strictEqual(state.outbox.length, 3);
        assert.ok(state.nextRev > highest);
        done();
      });
    });
  });
});

test('a cash sale made while Paystack is answering cannot clash with the online sale', function (done) {
  till()(function (t) {
    t.paystack.onInit = function () { assert.ok(t.core.sell(cashSale(1)).ok); };
    t.core.startOnline(onlineSale(2), function (error, result) {
      assert.ifError(error);
      var state = savedState(t);
      assert.strictEqual(state.outbox.length, 2);
      var used = {};
      state.outbox.forEach(function (entry) {
        entry.changes.forEach(function (change) {
          assert.ok(!used[change.local_rev], 'revision ' + change.local_rev + ' used twice');
          used[change.local_rev] = true;
        });
      });
      assert.strictEqual(stockOf(t.core, SODA), 7, 'both sales took their stock');
      assert.strictEqual(state.online[0].saleId, result.receipt.saleId);
      done();
    });
  });
});

test('stock used up while Paystack was answering: the online sale is not recorded', function (done) {
  till()(function (t) {
    t.paystack.onInit = function () { assert.ok(t.core.sell(cashSale(10)).ok); };
    t.core.startOnline(onlineSale(2), function (error) {
      assert.ok(error && error.message === 'Soda is out of stock.', error && error.message);
      assert.strictEqual(t.core.online().length, 0);
      assert.deepStrictEqual(kinds(t), ['sale'], 'only the cash sale');
      assert.strictEqual(stockOf(t.core, SODA), 0);
      done();
    });
  });
});

test('the sale stays the cashier\'s even if the page logged them out while Paystack answered', function (done) {
  till()(function (t) {
    t.paystack.onInit = function () { assert.ok(t.core.sell(cashSale(1)).ok); t.core.logout(); };
    t.core.startOnline(onlineSale(2), function (error, result) {
      assert.ifError(error);
      var online = savedState(t).outbox[1];
      assert.strictEqual(rowOf(online.changes, 'sales').userId, CASHIER);
      assert.strictEqual(online.receipt.saleId, result.receipt.saleId);
      done();
    });
  });
});

// ---- sending the settle ------------------------------------------------------------------------------------------
test('a settle that another device already recorded is done, not a refusal', function (done) {
  var refuse = false;
  till(function (request, body) {
    var sales = body.changes.filter(function (c) { return c.table_name === 'sales'; })[0].payload;
    if (refuse && sales.status === 'paid') { return { status: 422, body: { success: false, message: "Could not record changes: Sale X: a sale cannot go from 'paid' to 'paid'." } }; }
    return { status: 200, body: { success: true } };
  })(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'success' };
      t.core.checkOnline(function () {
        refuse = true;
        t.core.flush(function (error, flushed) {
          assert.ifError(error);
          assert.strictEqual(flushed.refused, 0);
          assert.strictEqual(flushed.sent, 2, 'the sale, and the settle that was already done elsewhere');
          assert.strictEqual(flushed.pending, 0);
          assert.deepStrictEqual(flushed.rejected, []);
          assert.strictEqual(t.core.history()[0].status, 'sent');
          done();
        });
      });
    });
  });
});

test('a settle the server refuses for a real reason stays on the iPad, listed as not recorded', function (done) {
  till(function (request, body) {
    var sales = body.changes.filter(function (c) { return c.table_name === 'sales'; })[0].payload;
    if (sales.status === 'paid') { return { status: 422, body: { success: false, message: "Could not record changes: Sale X: a sale cannot go from 'cancelled' to 'paid'." } }; }
    return { status: 200, body: { success: true } };
  })(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'success' };
      t.core.checkOnline(function () {
        t.core.flush(function (error, flushed) {
          assert.ifError(error);
          assert.strictEqual(flushed.refused, 1);
          assert.strictEqual(flushed.rejected.length, 1);
          assert.ok(/'cancelled' to 'paid'/.test(flushed.rejected[0].message));
          assert.strictEqual(t.core.history()[0].status, 'rejected');
          done();
        });
      });
    });
  });
});

test('a cancellation is not forgiven because the sale is already PAID elsewhere', function (done) {
  till(function (request, body) {
    var sales = body.changes.filter(function (c) { return c.table_name === 'sales'; })[0].payload;
    if (sales.status === 'cancelled') { return { status: 422, body: { success: false, message: "Could not record changes: Sale X: a sale cannot go from 'paid' to 'cancelled'." } }; }
    return { status: 200, body: { success: true } };
  })(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'abandoned' };
      t.core.cancelOnline(result.receipt.saleId, function () {
        t.core.flush(function (error, flushed) {
          assert.ifError(error);
          assert.strictEqual(flushed.refused, 1, 'a cancel refused because the sale is paid is a real problem');
          assert.strictEqual(flushed.rejected.length, 1);
          done();
        });
      });
    });
  });
});

test('a paid settle is only forgiven for paid-to-paid, and a cancel only for cancelled-to-cancelled', function (done) {
  till(function (request, body) {
    var sales = body.changes.filter(function (c) { return c.table_name === 'sales'; })[0].payload;
    if (sales.status === 'paid') { return { status: 422, body: { success: false, message: "Could not record changes: Sale X: a sale cannot go from 'cancelled' to 'cancelled'." } }; }
    return { status: 200, body: { success: true } };
  })(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'success' };
      t.core.checkOnline(function () {
        t.core.flush(function (error, flushed) {
          assert.ifError(error);
          assert.strictEqual(flushed.refused, 1);
          done();
        });
      });
    });
  });
});

test('a cancellation refused with a paid-to-paid message is still a refusal (the pairing matters)', function (done) {
  till(function (request, body) {
    var sales = body.changes.filter(function (c) { return c.table_name === 'sales'; })[0].payload;
    if (sales.status === 'cancelled') { return { status: 422, body: { success: false, message: "Could not record changes: Sale X: a sale cannot go from 'paid' to 'paid'." } }; }
    return { status: 200, body: { success: true } };
  })(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'abandoned' };
      t.core.cancelOnline(result.receipt.saleId, function () {
        t.core.flush(function (error, flushed) {
          assert.ifError(error);
          assert.strictEqual(flushed.refused, 1);
          done();
        });
      });
    });
  });
});

test('no internet while sending: the sale and its settle wait, and go in order later', function (done) {
  var online = false;
  till(function () { return online ? { status: 200, body: { success: true } } : 'offline'; })(function (t) {
    start(t, 2, {}, function (result, reference) {
      t.paystack.verdicts[reference] = { status: 'success' };
      t.core.checkOnline(function () {
        t.core.flush(function (error) {
          assert.strictEqual(error.code, 'offline');
          assert.strictEqual(t.core.outbox().pending, 2);
          online = true;
          t.core.flush(function (error2, flushed) {
            assert.ifError(error2);
            assert.strictEqual(flushed.sent, 2);
            var sent = pushes(t.calls);
            assert.strictEqual(rowOf(sent[sent.length - 2].body.changes, 'sales').status, 'pending');
            assert.strictEqual(rowOf(sent[sent.length - 1].body.changes, 'sales').status, 'paid');
            done();
          });
        });
      });
    });
  });
});

// ---- notices ------------------------------------------------------------------------------------------------------------
test('notices can be dismissed one by one, and only the latest 20 are kept', function (done) {
  till()(function (t) {
    var n = 0;
    (function make() {
      if (n === 22) {
        assert.strictEqual(t.core.notices().length, 20);
        var first = t.core.notices()[0].id;
        t.core.dismissNotice(first);
        assert.strictEqual(t.core.notices().length, 19);
        assert.ok(t.core.notices().every(function (x) { return x.id !== first; }));
        t.core.dismissNotice('does-not-exist');
        assert.strictEqual(t.core.notices().length, 19);
        assert.strictEqual(savedState(t).notices.length, 19, 'saved');
        done();
        return;
      }
      n += 1;
      t.clock.now += 1000;
      start(t, 0 + 1, {}, function (result, reference) {
        t.paystack.verdicts[reference] = { status: 'abandoned' };
        // 10 sodas only: cancel each so the stock comes back and there is always room.
        t.core.cancelOnline(result.receipt.saleId, function (error) { assert.ifError(error); make(); });
      });
    }());
  });
});

var failed = 0;
(function run(index) {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite online-payment tests passed: ' + tests.length + ' tests.');
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
