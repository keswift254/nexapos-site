/*
 * Reports in the Lite till: which period is meant (worked out in the iPad's own local time, as UTC instants and plain
 * dates for the shop server) and the call that fetches the shop's report (added up across every device by the server).
 *
 * Run: node tests/lite/reports.test.js
 */
'use strict';

// The shop is in Nairobi (UTC+3, no daylight saving). Setting this lets the period maths be checked against exact strings;
// when the platform ignores it the same checks are made against the local clock instead.
process.env.TZ = 'Africa/Nairobi';

var assert = require('assert');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var BASE = 'https://sync.test/index.php';
var NOW = Date.UTC(2026, 10, 12, 10, 0, 0);
var CASHIER = '44444444-4444-4444-8444-444444444444';
var SODA = '11111111-1111-4111-8111-111111111111';
var NAIROBI = new Date(2026, 10, 12).getTimezoneOffset() === -180;
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function localMidnight(y, m, d) { return new Date(y, m - 1, d).toISOString(); }

// ---- the period -------------------------------------------------------------------------------------------------------
test('a day runs from local midnight to the next local midnight, and the expenses use plain dates', function () {
  var r = Core.reportRange('day', { date: '2026-11-12' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.title, 'Daily Sales Report');
  assert.strictEqual(r.period, '12TH NOVEMBER');
  assert.strictEqual(r.fromUtc, localMidnight(2026, 11, 12));
  assert.strictEqual(r.toUtc, localMidnight(2026, 11, 13));
  assert.strictEqual(r.fromDate, '2026-11-12');
  assert.strictEqual(r.toDate, '2026-11-13');
  assert.strictEqual(r.days, 1);
  if (NAIROBI) {
    assert.strictEqual(r.fromUtc, '2026-11-11T21:00:00.000Z', 'Nairobi midnight is 21:00 UTC the evening before');
    assert.strictEqual(r.toUtc, '2026-11-12T21:00:00.000Z');
  }
});

test('the Expenses report is one day, titled as such', function () {
  var r = Core.reportRange('expenses', { date: '2026-01-01' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.title, 'Expenses Report');
  assert.strictEqual(r.period, '1ST JANUARY');
  assert.strictEqual(r.fromDate, '2026-01-01');
  assert.strictEqual(r.toDate, '2026-01-02');
});

test('a month runs from the 1st to the 1st of the next, including December into January', function () {
  var nov = Core.reportRange('month', { year: 2026, month: 11 });
  assert.strictEqual(nov.ok, true);
  assert.strictEqual(nov.title, 'Monthly Sales Report');
  assert.strictEqual(nov.period, 'NOVEMBER 2026');
  assert.strictEqual(nov.fromDate, '2026-11-01');
  assert.strictEqual(nov.toDate, '2026-12-01');
  assert.strictEqual(nov.days, 30);
  var dec = Core.reportRange('month', { year: 2026, month: 12 });
  assert.strictEqual(dec.toDate, '2027-01-01');
  assert.strictEqual(dec.fromUtc, localMidnight(2026, 12, 1));
  assert.strictEqual(dec.toUtc, localMidnight(2027, 1, 1));
  assert.strictEqual(Core.reportRange('month', { year: 2028, month: 2 }).days, 29, 'a leap February');
  assert.strictEqual(Core.reportRange('month', { year: '2026', month: '3' }).ok, true, 'numbers typed in a form are fine');
});

test('a selected period includes both end days, in either order, and is labelled like the apps', function () {
  var r = Core.reportRange('range', { since: '2026-11-07', until: '2026-11-13' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.title, 'Selected Period Sales Report');
  assert.strictEqual(r.period, '7TH NOV 2026 - 13TH NOV 2026');
  assert.strictEqual(r.fromDate, '2026-11-07');
  assert.strictEqual(r.toDate, '2026-11-14', 'the last day is included, so the end is the day after');
  assert.strictEqual(r.days, 7);
  var swapped = Core.reportRange('range', { since: '2026-11-13', until: '2026-11-07' });
  assert.deepStrictEqual([swapped.fromDate, swapped.toDate, swapped.period], [r.fromDate, r.toDate, r.period], 'the order does not matter');
  var one = Core.reportRange('range', { since: '2026-11-07', until: '2026-11-07' });
  assert.strictEqual(one.days, 1, 'one day is a period of one day');
});

test('days are written 1st 2nd 3rd 4th ... 11th 12th 13th ... 21st 22nd 23rd 31st', function () {
  function label(day) { return Core.reportRange('day', { date: '2026-01-' + (day < 10 ? '0' : '') + day }).period.split(' ')[0]; }
  assert.deepStrictEqual([1, 2, 3, 4, 10, 11, 12, 13, 14, 21, 22, 23, 24, 30, 31].map(label),
    ['1ST', '2ND', '3RD', '4TH', '10TH', '11TH', '12TH', '13TH', '14TH', '21ST', '22ND', '23RD', '24TH', '30TH', '31ST']);
});

test('a bad choice is refused in plain words, never guessed at', function () {
  ['', null, undefined, 'today', '2026-13-01', '2026-02-30', '2026-11-31', '26-11-12', '2026/11/12', '1999-12-31', '2101-01-01', '2026-11-12T00:00', ' 2026-11-12'].forEach(function (text) {
    var r = Core.reportRange('day', { date: text });
    assert.strictEqual(r.ok, false, JSON.stringify(text));
    assert.strictEqual(r.message, 'Choose a real date.');
  });
  assert.strictEqual(Core.reportRange('day', null).ok, false);
  assert.strictEqual(Core.reportRange('range', { since: '2026-11-07', until: 'x' }).ok, false);
  assert.strictEqual(Core.reportRange('range', { since: 'x', until: '2026-11-07' }).ok, false);
  [{}, { year: 2026 }, { month: 11 }, { year: 2026, month: 0 }, { year: 2026, month: 13 }, { year: 1999, month: 5 }, { year: 2026, month: 5.5 }, { year: 'abc', month: 1 }].forEach(function (input) {
    var r = Core.reportRange('month', input);
    assert.strictEqual(r.ok, false, JSON.stringify(input));
    assert.strictEqual(r.message, 'Choose a month and a year.');
  });
  assert.strictEqual(Core.reportRange('weekly', { date: '2026-11-12' }).ok, false);
  assert.strictEqual(Core.reportRange(undefined, {}).ok, false);
});

test('a period of more than 400 days is refused, exactly 400 is allowed', function () {
  var long = Core.reportRange('range', { since: '2025-01-01', until: '2026-12-31' });
  assert.strictEqual(long.ok, false);
  assert.strictEqual(long.message, 'Choose a period of up to 400 days.');
  var edge = Core.reportRange('range', { since: '2026-01-01', until: '2027-02-04' }); // 400 days
  assert.strictEqual(edge.ok, true);
  assert.strictEqual(edge.days, 400);
  assert.strictEqual(Core.reportRange('range', { since: '2026-01-01', until: '2027-02-05' }).ok, false, '401 days');
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
function catalogBody() {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-11-12T10:00:00Z', cursor: 5,
    license: { state: 'active', valid_until: null, never_expires: true },
    business: { businessName: 'Mama Mboga', currency: 'KES' },
    categories: [{ id: 'c1', name: 'Drinks', status: 'active' }],
    products: [{ id: SODA, sku: 'S1', name: 'Soda', barcode: null, categoryId: 'c1', retailPriceCents: 6000, wholesalePriceCents: 5000, costPriceCents: 4000, reorderLevel: 5, status: 'active', stockQty: 50 }],
    users: [{ id: CASHIER, roleId: '00000000-0000-4000-8000-000000000003', name: 'Wanjiru', username: 'cash', passwordHash: fixtures[0].hash, status: 'active' }],
    roles: []
  };
}
function goodReport(extra) {
  var report = {
    salesTotalCents: 28000, transactionCount: 3, cashReceivedCents: 20000, mpesaCents: 8000, expensesTotalCents: 2900,
    grossProfitCents: 10000, netProfitCents: 7100, grandTotalCents: 25100,
    sales: [{ id: 's2', saleNumber: 'S-2', cashierName: 'Otieno', saleType: 'retail', paymentMethod: 'paystack', status: 'paid', totalCents: 8000, createdAt: '2026-11-12T11:00:00.000000Z', itemNames: 'Bread x1' }],
    expenses: [{ id: 'e1', title: 'Rent', note: null, amountCents: 2500, createdAt: '2026-11-12T08:00:00.000000Z', enteredByName: 'Wanjiru', expenseDate: '2026-11-12' }],
    salesTruncated: false, expensesTruncated: false
  };
  for (var k in extra) { report[k] = extra[k]; }
  return report;
}
/** A joined, logged-in till whose server answers lite_report with `answer(request)`. */
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
    else if (action === 'lite_report') { result = answer(request); }
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
      done({ core: core, calls: calls, storage: storage });
    });
  });
}
function reportCalls(t) { return t.calls.filter(function (c) { return /action=lite_report/.test(c.url); }); }

test('the report is asked for with the exact period, and only with this device\'s key', function (done) {
  till(function () { return { status: 200, body: { success: true, report: goodReport() } }; }, function (t) {
    var range = Core.reportRange('day', { date: '2026-11-12' });
    t.core.loadReport(range, function (error, report) {
      assert.ifError(error);
      var sent = reportCalls(t);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].method, 'GET');
      assert.strictEqual(sent[0].headers.Authorization, 'Bearer key-1');
      assert.strictEqual(sent[0].body, null);
      var query = sent[0].url.split('?')[1];
      var parts = {};
      query.split('&').forEach(function (pair) { var kv = pair.split('='); parts[kv[0]] = decodeURIComponent(kv[1]); });
      assert.deepStrictEqual(parts, { action: 'lite_report', from_utc: range.fromUtc, to_utc: range.toUtc, from_date: '2026-11-12', to_date: '2026-11-13' });
      assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parts.from_utc), 'an instant the server accepts');
      assert.strictEqual(report.salesTotalCents, 28000);
      done();
    });
  });
});

test('everything the screen draws comes back: money, lists, truncation flags, the period', function (done) {
  till(function () { return { status: 200, body: { success: true, report: goodReport({ salesTruncated: true, expensesTruncated: true }) } }; }, function (t) {
    var range = Core.reportRange('month', { year: 2026, month: 11 });
    t.core.loadReport(range, function (error, report) {
      assert.ifError(error);
      ['salesTotalCents', 'transactionCount', 'cashReceivedCents', 'mpesaCents', 'expensesTotalCents', 'grossProfitCents', 'netProfitCents', 'grandTotalCents'].forEach(function (k) {
        assert.strictEqual(report[k], goodReport()[k], k);
      });
      assert.strictEqual(report.sales[0].saleNumber, 'S-2');
      assert.strictEqual(report.expenses[0].title, 'Rent');
      assert.strictEqual(report.salesTruncated, true);
      assert.strictEqual(report.expensesTruncated, true);
      assert.strictEqual(report.range, range);
      done();
    });
  });
});

test('a full list says nothing is cut off', function (done) {
  till(function () { return { status: 200, body: { success: true, report: goodReport() } }; }, function (t) {
    t.core.loadReport(Core.reportRange('day', { date: '2026-11-12' }), function (error, report) {
      assert.ifError(error);
      assert.strictEqual(report.salesTruncated, false);
      assert.strictEqual(report.expensesTruncated, false);
      done();
    });
  });
});

test('sales on this iPad that have not reached the shop are counted, so the screen can say they are missing', function (done) {
  till(function () { return { status: 200, body: { success: true, report: goodReport() } }; }, function (t) {
    t.core.loadReport(Core.reportRange('day', { date: '2026-11-12' }), function (error, report) {
      assert.ifError(error);
      assert.strictEqual(report.waitingHere, 0);
      var sold = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: null });
      assert.ok(sold.ok);
      t.core.loadReport(Core.reportRange('day', { date: '2026-11-12' }), function (error2, again) {
        assert.ifError(error2);
        assert.strictEqual(again.waitingHere, 1);
        done();
      });
    });
  });
});

test('no connection, a refused key, a server without reports, and an unreadable answer each say what is wrong', function (done) {
  var cases = [
    ['offline', 'offline', /Could not reach the server/],
    [{ status: 401, body: { success: false, message: 'Invalid or missing API key.' } }, 'unauthorized', /not allowed to see the shop reports/],
    [{ status: 403, body: { success: false, message: 'The shop report view is only for lite tills.' } }, 'forbidden', /not allowed to see the shop reports/],
    [{ status: 404, body: { success: false, message: 'Unknown action' } }, 'unavailable', /cannot give reports yet/],
    [{ status: 422, body: { success: false, message: 'The period must end after it starts and be at most 400 days.' } }, 'server', /at most 400 days/],
    [{ status: 200, body: 'not json at all' }, 'server', /could not do that/],
    [{ status: 200, body: { success: true } }, 'server', /cannot read/],
    [{ status: 200, body: { success: true, report: { salesTotalCents: 'lots' } } }, 'server', /cannot read/],
    [{ status: 200, body: { success: true, report: goodReport({ sales: 'x' }) } }, 'server', /cannot read/],
    [{ status: 200, body: { success: true, report: goodReport({ netProfitCents: 1.5 }) } }, 'server', /cannot read/],
    [{ status: 200, body: { success: true, report: goodReport({ expenses: null }) } }, 'server', /cannot read/]
  ];
  (function next(i) {
    if (i >= cases.length) { done(); return; }
    till(function () { return cases[i][0]; }, function (t) {
      t.core.loadReport(Core.reportRange('day', { date: '2026-11-12' }), function (error, report) {
        assert.ok(error, 'case ' + i + ' should fail');
        assert.strictEqual(error.code, cases[i][1], 'case ' + i + ': ' + error.message);
        assert.ok(cases[i][2].test(error.message), 'case ' + i + ': ' + error.message);
        assert.strictEqual(report, undefined, 'case ' + i + ' hands back nothing');
        next(i + 1);
      });
    });
  }(0));
});

test('a refused key in a report does not lock the till out (only the catalog refresh does that)', function (done) {
  till(function () { return { status: 401, body: { success: false } }; }, function (t) {
    t.core.loadReport(Core.reportRange('day', { date: '2026-11-12' }), function (error) {
      assert.ok(error);
      assert.strictEqual(t.core.getStatus().revoked, false);
      done();
    });
  });
});

test('a bad period never reaches the server, and a till that has not joined cannot ask', function (done) {
  till(function () { return { status: 200, body: { success: true, report: goodReport() } }; }, function (t) {
    t.core.loadReport(Core.reportRange('day', { date: 'nope' }), function (error) {
      assert.strictEqual(error.code, 'input');
      assert.strictEqual(error.message, 'Choose a real date.');
      t.core.loadReport(null, function (error2) {
        assert.strictEqual(error2.code, 'input');
        assert.strictEqual(reportCalls(t).length, 0, 'nothing was sent');
        var fresh = Core.create({ baseUrl: BASE, http: function () { throw new Error('must not call'); }, storage: fakeStorage(), bcrypt: bcrypt, sale: Sale, now: function () { return NOW; } });
        fresh.loadReport(Core.reportRange('day', { date: '2026-11-12' }), function (error3) {
          assert.strictEqual(error3.code, 'input');
          assert.ok(/not joined a shop/.test(error3.message));
          done();
        });
      });
    });
  });
});

var failed = 0;
(function run(index) {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite reports tests passed: ' + tests.length + ' tests' + (NAIROBI ? '.' : ' (the platform ignored TZ, so exact Nairobi strings were not checked).'));
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
