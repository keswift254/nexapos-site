/*
 * The Lite dashboard: the same cards as the apps' dashboard (Sales Today and Net Profit Today with their change since
 * yesterday, Low Stock, Stock Value, the last 7 days) for the whole shop. The sales and profit figures come from the shop
 * server; Low Stock and Stock Value come from the catalog already on the iPad.
 *
 * Run: node tests/lite/dashboard.test.js
 */
'use strict';

process.env.TZ = 'Africa/Nairobi';

var assert = require('assert');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var BASE = 'https://sync.test/index.php';
var NOW = Date.UTC(2026, 10, 12, 10, 0, 0); // 12 Nov 2026, 13:00 in Nairobi
var CASHIER = '44444444-4444-4444-8444-444444444444';
var NAIROBI = new Date(2026, 10, 12).getTimezoneOffset() === -180;
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---- the apps' "change since yesterday" ---------------------------------------------------------------------------------
test('change since yesterday: the apps\' rule, including the nothing-to-compare cases and rounding half away from zero', function () {
  var p = Core.percentChange;
  assert.deepStrictEqual(p(0, 0), { percent: 0, direction: 'flat' });
  assert.deepStrictEqual(p(5000, 0), { percent: 100, direction: 'up' }, 'yesterday was nothing: +100%');
  assert.deepStrictEqual(p(-5000, 0), { percent: 100, direction: 'up' }, 'the apps treat any non-zero today as +100% too');
  assert.deepStrictEqual(p(150, 100), { percent: 50, direction: 'up' });
  assert.deepStrictEqual(p(50, 100), { percent: -50, direction: 'down' });
  assert.deepStrictEqual(p(100, 100), { percent: 0, direction: 'flat' });
  assert.deepStrictEqual(p(0, 100), { percent: -100, direction: 'down' });
  assert.deepStrictEqual(p(200, 100), { percent: 100, direction: 'up' });
  assert.deepStrictEqual(p(1000, 100), { percent: 900, direction: 'up' });
  assert.deepStrictEqual(p(100.4, 100), { percent: 0, direction: 'flat' }, '0.4% rounds to 0, which is flat');
  assert.deepStrictEqual(p(205, 200), { percent: 3, direction: 'up' }, '2.5 rounds up to 3');
  assert.deepStrictEqual(p(195, 200), { percent: -3, direction: 'down' }, '-2.5 rounds away from zero to -3 (not toward zero)');
  assert.deepStrictEqual(p(-50, -100), { percent: 50, direction: 'up' }, 'a smaller loss is an improvement');
  assert.deepStrictEqual(p(-150, -100), { percent: -50, direction: 'down' }, 'a bigger loss is down');
  assert.deepStrictEqual(p(100, -100), { percent: 200, direction: 'up' }, 'from a loss to a profit');
});

// ---- the periods ------------------------------------------------------------------------------------------------------
test('the last 7 days end with today, as 8 edges: local midnights as UTC instants and as plain dates', function () {
  var p = Core.dashboardPeriods(NOW, 7);
  assert.strictEqual(p.bounds.length, 8);
  assert.deepStrictEqual(p.dates, ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
  assert.deepStrictEqual(p.days, ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
  assert.strictEqual(p.bounds[0], new Date(2026, 10, 6).toISOString());
  assert.strictEqual(p.bounds[7], new Date(2026, 10, 13).toISOString(), 'the last edge is the end of today');
  if (NAIROBI) {
    assert.strictEqual(p.bounds[0], '2026-11-05T21:00:00.000Z');
    assert.strictEqual(p.bounds[6], '2026-11-11T21:00:00.000Z', 'the start of today in Nairobi');
    assert.strictEqual(p.bounds[7], '2026-11-12T21:00:00.000Z');
  }
  for (var i = 1; i < p.bounds.length; i++) {
    assert.ok(p.bounds[i] > p.bounds[i - 1], 'increasing');
  }
});

test('"today" is the iPad\'s local day: just after local midnight it is already the next day', function () {
  var late = Date.UTC(2026, 10, 12, 22, 30, 0); // 01:30 on the 13th in Nairobi
  var p = Core.dashboardPeriods(late, 7);
  if (NAIROBI) {
    assert.strictEqual(p.days[6], '2026-11-13');
    assert.strictEqual(p.dates[7], '2026-11-14');
  } else {
    assert.strictEqual(p.days[6], new Date(late).getFullYear() + '-' + ('0' + (new Date(late).getMonth() + 1)).slice(-2) + '-' + ('0' + new Date(late).getDate()).slice(-2));
  }
});

test('the week crosses month and year ends correctly', function () {
  var p = Core.dashboardPeriods(Date.UTC(2027, 0, 2, 10, 0, 0), 7);
  assert.deepStrictEqual(p.days, ['2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.strictEqual(p.dates[7], '2027-01-03');
  var leap = Core.dashboardPeriods(Date.UTC(2028, 2, 2, 10, 0, 0), 7);
  assert.deepStrictEqual(leap.days.slice(0, 3), ['2028-02-25', '2028-02-26', '2028-02-27'], 'a leap February has the 29th');
  assert.ok(leap.days.indexOf('2028-02-29') >= 0);
});

test('other lengths work too', function () {
  assert.strictEqual(Core.dashboardPeriods(NOW, 1).bounds.length, 2);
  assert.deepStrictEqual(Core.dashboardPeriods(NOW, 1).days, ['2026-11-12']);
  assert.strictEqual(Core.dashboardPeriods(NOW, 14).days[0], '2026-10-30');
});

// ---- the call ---------------------------------------------------------------------------------------------------------
function fakeStorage() {
  var data = {};
  return {
    data: data,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}
function product(id, name, stock, reorder, cost, status) {
  return { id: id, sku: name, name: name, barcode: null, categoryId: 'c1', retailPriceCents: 10000, wholesalePriceCents: 9000, costPriceCents: cost, reorderLevel: reorder, status: status || 'active', stockQty: stock };
}
function catalogBody() {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-11-12T10:00:00Z', cursor: 5,
    license: { state: 'active', valid_until: null, never_expires: true },
    business: { businessName: 'Mama Mboga', currency: 'KES' },
    categories: [{ id: 'c1', name: 'Drinks', status: 'active' }],
    products: [
      product('p1', 'Plenty', 50, 5, 4000),          // not low; value 200000
      product('p2', 'AtLevel', 5, 5, 1000),          // low (at the level counts); value 5000
      product('p3', 'Empty', 0, 2, 3000),            // low; value 0
      product('p4', 'Oversold', -1, 0, 2000),        // low; value -2000
      product('p5', 'Retired', 10, 20, 500, 'inactive') // low (every product counts, active or not); value 5000
    ],
    users: [{ id: CASHIER, roleId: '00000000-0000-4000-8000-000000000003', name: 'Wanjiru', username: 'cash', passwordHash: fixtures[0].hash, status: 'active' }],
    roles: []
  };
}
function days(extra) {
  var list = [];
  for (var i = 0; i < 7; i++) {
    list.push({ fromUtc: 'x', toUtc: 'y', fromDate: 'a', toDate: 'b', salesTotalCents: (i + 1) * 1000, transactionCount: i + 1, grossProfitCents: (i + 1) * 400, expensesTotalCents: i * 100, netProfitCents: (i + 1) * 400 - i * 100 });
  }
  for (var k in extra) { list[Number(k)] = Object.assign(list[Number(k)], extra[k]); }
  return list;
}
function till(answer, done) {
  var storage = fakeStorage();
  var calls = [];
  var http = function (request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    calls.push(request);
    var result;
    if (action === 'register_device') { result = { status: 201, body: { success: true, api_key: 'key-1' } }; }
    else if (action === 'join_shop') { result = { status: 200, body: { success: true } }; }
    else if (action === 'lite_catalog') { result = { status: 200, body: catalogBody() }; }
    else if (action === 'push_changes') { result = { status: 200, body: { success: true } }; }
    else if (action === 'lite_dashboard') { result = answer(request); }
    else { result = { status: 404, body: { success: false } }; }
    setImmediate(function () {
      if (result === 'offline') { cb(new Error('network')); return; }
      cb(null, { status: result.status, text: typeof result.body === 'string' ? result.body : JSON.stringify(result.body) });
    });
  };
  var seed = 1;
  var core = Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, now: function () { return NOW; },
    randomHex: function (n) { var s = ''; while (s.length < n * 2) { seed = (seed * 1103515245 + 12345) % 2147483648; s += ('00000000' + seed.toString(16)).slice(-8); } return s.slice(0, n * 2); } });
  core.join('INV', 'Till', function (error) {
    assert.ifError(error);
    core.login('cash', 'Passw0rd!', function (loginError) {
      assert.ifError(loginError);
      done({ core: core, calls: calls });
    });
  });
}

test('the dashboard asks for the 7 local days, exactly, with this device\'s key only', function (done) {
  till(function () { return { status: 200, body: { success: true, days: days() } }; }, function (t) {
    t.core.loadDashboard(function (error) {
      assert.ifError(error);
      var sent = t.calls.filter(function (c) { return /action=lite_dashboard/.test(c.url); });
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].method, 'GET');
      assert.strictEqual(sent[0].headers.Authorization, 'Bearer key-1');
      var parts = {};
      sent[0].url.split('?')[1].split('&').forEach(function (pair) { var kv = pair.split('='); parts[kv[0]] = decodeURIComponent(kv[1]); });
      var expected = Core.dashboardPeriods(NOW, 7);
      assert.strictEqual(parts.bounds, expected.bounds.join(','));
      assert.strictEqual(parts.dates, expected.dates.join(','));
      assert.strictEqual(parts.bounds.split(',').length, 8);
      done();
    });
  });
});

test('today, yesterday, the changes and the 7-day list are laid out for the cards and the chart', function (done) {
  var answer = days({ 5: { salesTotalCents: 20000, netProfitCents: 5000, transactionCount: 4 }, 6: { salesTotalCents: 30000, netProfitCents: 4000, grossProfitCents: 6000, expensesTotalCents: 2000, transactionCount: 9 } });
  till(function () { return { status: 200, body: { success: true, days: answer } }; }, function (t) {
    t.core.loadDashboard(function (error, d) {
      assert.ifError(error);
      assert.strictEqual(d.today.salesTotalCents, 30000);
      assert.strictEqual(d.today.transactionCount, 9);
      assert.strictEqual(d.today.grossProfitCents, 6000);
      assert.strictEqual(d.today.netProfitCents, 4000);
      assert.strictEqual(d.today.expensesTotalCents, 2000);
      assert.strictEqual(d.today.date, '2026-11-12');
      assert.strictEqual(d.yesterday.salesTotalCents, 20000);
      assert.strictEqual(d.yesterday.date, '2026-11-11');
      assert.deepStrictEqual(d.salesChange, { percent: 50, direction: 'up' }, '30000 against 20000');
      assert.deepStrictEqual(d.netProfitChange, { percent: -20, direction: 'down' }, '4000 against 5000');
      assert.strictEqual(d.last7.length, 7);
      assert.strictEqual(d.last7[0].date, '2026-11-06');
      assert.strictEqual(d.last7[6].date, '2026-11-12');
      assert.strictEqual(d.last7[0].salesTotalCents, 1000, 'the oldest day first, today last');
      assert.strictEqual(d.last7[6], d.today);
      assert.strictEqual(d.last7[5], d.yesterday);
      done();
    });
  });
});

test('Low Stock counts every product at or below its reorder level, and Stock Value is cost times stock', function (done) {
  till(function () { return { status: 200, body: { success: true, days: days() } }; }, function (t) {
    t.core.loadDashboard(function (error, d) {
      assert.ifError(error);
      assert.strictEqual(d.lowStockCount, 4, 'AtLevel, Empty, Oversold and the inactive one; not Plenty');
      assert.strictEqual(d.stockValueCents, 4000 * 50 + 1000 * 5 + 3000 * 0 + 2000 * -1 + 500 * 10, 'every product counts, even oversold and inactive');
      assert.strictEqual(d.stockValueCents, 200000 + 5000 + 0 - 2000 + 5000);
      done();
    });
  });
});

test('the two stock figures are also available without the server (the screen shows them offline)', function (done) {
  till(function () { return 'offline'; }, function (t) {
    assert.deepStrictEqual(t.core.stockFigures(), { lowStockCount: 4, stockValueCents: 200000 + 5000 - 2000 + 5000 });
    done();
  });
});

test('sales on this iPad that have not reached the shop are counted, so the screen can say they are missing', function (done) {
  till(function () { return { status: 200, body: { success: true, days: days() } }; }, function (t) {
    t.core.loadDashboard(function (error, d) {
      assert.ifError(error);
      assert.strictEqual(d.waitingHere, 0);
      var sold = t.core.sell({ cart: [{ productId: 'p1', name: 'Plenty', unitPriceCents: 10000, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: null });
      assert.ok(sold.ok, sold.message);
      t.core.loadDashboard(function (error2, again) {
        assert.ifError(error2);
        assert.strictEqual(again.waitingHere, 1);
        assert.strictEqual(again.lowStockCount, 4, 'selling one of 50 does not make it low');
        assert.strictEqual(again.stockValueCents, d.stockValueCents - 4000, 'stock value follows the sale at once');
        done();
      });
    });
  });
});

test('no connection, a refused key, a server without a dashboard, and an unreadable answer each say what is wrong', function (done) {
  var wrongFields = days();
  wrongFields[3].salesTotalCents = '3000';
  var cases = [
    ['offline', 'offline', /Could not reach the server/],
    [{ status: 401, body: { success: false } }, 'unauthorized', /not allowed to see the shop figures/],
    [{ status: 403, body: { success: false } }, 'forbidden', /not allowed to see the shop figures/],
    [{ status: 404, body: { success: false } }, 'unavailable', /cannot give the dashboard yet/],
    [{ status: 422, body: { success: false, message: 'The dashboard covers at most 400 days.' } }, 'server', /at most 400 days/],
    [{ status: 200, body: { success: true } }, 'server', /cannot read/],
    [{ status: 200, body: { success: true, days: 'seven' } }, 'server', /cannot read/],
    [{ status: 200, body: { success: true, days: days().slice(0, 6) } }, 'server', /cannot read/],
    [{ status: 200, body: { success: true, days: days().concat([days()[0]]) } }, 'server', /cannot read/],
    [{ status: 200, body: { success: true, days: wrongFields } }, 'server', /cannot read/],
    [{ status: 200, body: { success: true, days: days({ 2: { netProfitCents: 1.5 } }) } }, 'server', /cannot read/],
    [{ status: 200, body: { success: true, days: days().map(function (d, i) { return i === 4 ? null : d; }) } }, 'server', /cannot read/]
  ];
  (function next(i) {
    if (i >= cases.length) { done(); return; }
    till(function () { return cases[i][0]; }, function (t) {
      t.core.loadDashboard(function (error, d) {
        assert.ok(error, 'case ' + i + ' should fail');
        assert.strictEqual(error.code, cases[i][1], 'case ' + i + ': ' + error.message);
        assert.ok(cases[i][2].test(error.message), 'case ' + i + ': ' + error.message);
        assert.strictEqual(d, undefined);
        next(i + 1);
      });
    });
  }(0));
});

test('a till that has not joined a shop cannot ask', function (done) {
  var core = Core.create({ baseUrl: BASE, http: function () { throw new Error('must not call'); }, storage: fakeStorage(), bcrypt: bcrypt, sale: Sale, now: function () { return NOW; } });
  core.loadDashboard(function (error) {
    assert.strictEqual(error.code, 'input');
    assert.ok(/not joined a shop/.test(error.message));
    done();
  });
});

var failed = 0;
(function run(index) {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite dashboard tests passed: ' + tests.length + ' tests' + (NAIROBI ? '.' : ' (the platform ignored TZ, so exact Nairobi strings were not checked).'));
    return;
  }
  var t = tests[index];
  var finished = false;
  var timer = setTimeout(function () { if (!finished) { finished = true; failed++; console.error('FAIL (timeout) ' + t.name); run(index + 1); } }, 60000);
  function after() { if (finished) { return; } finished = true; clearTimeout(timer); run(index + 1); }
  try {
    if (t.fn.length > 0) { t.fn(after); } else { t.fn(); after(); }
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
