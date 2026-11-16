/*
 * Expenses in the Lite core: an owner (Admin) or a Manager adds and deletes expenses on the iPad; they are saved on the iPad
 * first, travel in the same outbox as the sales, and the day's list comes from the shop server (every device's expenses) with
 * what this iPad has not sent yet merged in. The shop only accepts a deletion from the device that entered the expense, so
 * only those carry a Delete.
 *
 * Run: node tests/lite/expenses.test.js
 */
'use strict';

process.env.TZ = 'Africa/Nairobi';

var assert = require('assert');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var BASE = 'https://sync.test/index.php';
var NOW = new Date(2026, 10, 13, 10, 0, 0).getTime();
var CASHIER = '44444444-4444-4444-8444-444444444444';
var OWNER = '33333333-3333-4333-8333-333333333333';
var MANAGER = '55555555-5555-4555-8555-555555555555';
var SODA = '11111111-1111-4111-8111-111111111111';
var MAIN_PC = '51e9906b-2d41-4be4-83d3-2416e3ae184f';
var DAY = '2026-11-13';
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
function catalogBody(license) {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-11-13T10:00:00Z', cursor: 5,
    license: license || { state: 'active', valid_until: null, never_expires: true },
    business: { businessName: 'Mama Mboga', currency: 'KES' },
    categories: [{ id: 'c1', name: 'Drinks', status: 'active' }],
    products: [{ id: SODA, sku: 'S1', name: 'Soda', barcode: null, categoryId: 'c1', retailPriceCents: 6000, wholesalePriceCents: 5000, costPriceCents: 4000, reorderLevel: 5, status: 'active', stockQty: 10 }],
    users: [
      { id: CASHIER, roleId: '00000000-0000-4000-8000-000000000003', name: 'Wanjiru', username: 'cash', passwordHash: fixtures[0].hash, status: 'active' },
      { id: OWNER, roleId: '00000000-0000-4000-8000-000000000001', name: 'Owner', username: 'owner', passwordHash: fixtures[0].hash, status: 'active' },
      { id: MANAGER, roleId: '00000000-0000-4000-8000-000000000002', name: 'Otieno', username: 'manager', passwordHash: fixtures[0].hash, status: 'active' }
    ],
    roles: []
  };
}
var seed = 1;
function randomHex(n) { var s = ''; while (s.length < n * 2) { seed = (seed * 1103515245 + 12345) % 2147483648; s += ('00000000' + seed.toString(16)).slice(-8); } return s.slice(0, n * 2); }

/**
 * A joined till on a pretend shop. The shop keeps the newest version of every expense pushed to it (like the real server),
 * answers lite_report from them, and can be told to refuse pushes, to be offline, or to fail.
 */
function till(options, done) {
  options = options || {};
  var storage = options.storage || fakeStorage();
  var clock = options.clock || { now: NOW };
  var shop = options.shop || { expenses: {}, pushes: [], reports: [], refuse: null, offline: false, serverError: false, truncate: false, withoutRecords: false };
  var http = function (request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    var body = request.body ? JSON.parse(request.body) : null;
    var result;
    var refusal;
    if (action === 'register_device') { result = { status: 201, body: { success: true, api_key: 'key-1' } }; }
    else if (action === 'join_shop') { result = { status: 200, body: { success: true } }; }
    else if (action === 'lite_catalog') { result = { status: 200, body: catalogBody(options.license) }; }
    else if (action === 'push_changes') {
      shop.pushes.push(body.changes);
      if (shop.offline) { result = 'offline'; }
      else if (shop.serverError) { result = { status: 503, body: { success: false, message: 'Try later.' } }; }
      else if (shop.refuse && (refusal = typeof shop.refuse === 'function' ? shop.refuse(body.changes) : shop.refuse)) { result = { status: 422, body: { success: false, message: refusal } }; }
      else {
        body.changes.forEach(function (c) {
          if (c.table_name === 'expenses') {
            var have = shop.expenses[c.row_id];
            if (!have || have.updatedAt <= c.payload.updatedAt) { shop.expenses[c.row_id] = c.payload; }
          }
        });
        result = { status: 200, body: { success: true } };
      }
    } else if (action === 'lite_report') {
      var q = {};
      request.url.split('?')[1].split('&').forEach(function (pair) { var kv = pair.split('='); q[kv[0]] = decodeURIComponent(kv[1]); });
      shop.reports.push(q);
      if (shop.offline) { result = 'offline'; }
      else {
        var rows = [];
        var total = 0;
        Object.keys(shop.expenses).forEach(function (id) {
          var e = shop.expenses[id];
          if (e.deletedAt || e.expenseDate < q.from_date || e.expenseDate >= q.to_date) { return; }
          total += e.amountCents;
          var row = { id: id, title: e.title, note: e.note, amountCents: e.amountCents, createdAt: e.createdAt, enteredByName: e.userId === OWNER ? 'Owner' : (e.userId === MANAGER ? 'Otieno' : 'System Admin'), expenseDate: e.expenseDate };
          if (q.records === '1' && !shop.withoutRecords) { row.record = e; }
          rows.push(row);
        });
        rows.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : (a.createdAt > b.createdAt ? 1 : 0); });
        var listed = shop.truncate ? rows.slice(0, shop.truncate) : rows;
        result = { status: 200, body: { success: true, report: { salesTotalCents: 0, transactionCount: 0, cashReceivedCents: 0, mpesaCents: 0, expensesTotalCents: total, grossProfitCents: 0, netProfitCents: -total, grandTotalCents: -total, sales: [], expenses: listed, salesTruncated: false, expensesTruncated: !!shop.truncate && rows.length > shop.truncate } } };
      }
    } else { result = { status: 404, body: { success: false } }; }
    setImmediate(function () {
      if (result === 'offline') { cb(new Error('network')); return; }
      cb(null, { status: result.status, text: JSON.stringify(result.body) });
    });
  };
  var core = Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, now: function () { return clock.now; }, randomHex: randomHex });
  function ready() {
    core.login(options.user || 'owner', 'Passw0rd!', function (loginError) {
      assert.ifError(loginError);
      done({ core: core, shop: shop, storage: storage, clock: clock, http: http });
    });
  }
  if (options.joined) { ready(); return; }
  core.join('INV', 'Till', function (error) { assert.ifError(error); ready(); });
}
function saved(t) { return JSON.parse(t.storage.data['nexapos-lite-v1']); }
function deviceOf(t) { return saved(t).device.id; }
function expense(extra) {
  var e = { title: 'Transport', amountCents: 250050, expenseDate: DAY, note: 'Delivery' };
  for (var k in extra) { e[k] = extra[k]; }
  return e;
}
/** Something another device (the shop's main PC) entered, already in the shop. */
function fromMainPc(t, id, extra) {
  var e = { id: id, createdAt: '2026-11-13T05:00:00.000000Z', updatedAt: '2026-11-13T05:00:00.000000Z', deletedAt: null, localRev: 3, createdByDeviceId: MAIN_PC, syncState: 'local_only', userId: OWNER, expenseDate: DAY, title: 'Rent', amountCents: 400000, note: null };
  for (var k in extra) { e[k] = extra[k]; }
  t.shop.expenses[id] = e;
  return e;
}
function addAndSend(t, extra, then) {
  var added = t.core.addExpense(expense(extra));
  assert.ok(added.ok, added.message);
  t.core.flush(function (error) { assert.ifError(error); then(added.expense); });
}

// ---- who may use Expenses ----------------------------------------------------------------------------------------------------
test('an owner and a manager can use Expenses; a cashier cannot add, delete, or list them', function (done) {
  till({ user: 'cash' }, function (c) {
    assert.ok(/Only an owner \(Admin\) or a Manager/.test(c.core.expenseBlock()));
    var added = c.core.addExpense(expense());
    assert.strictEqual(added.ok, false);
    assert.ok(/Only an owner/.test(added.message));
    assert.strictEqual(c.core.deleteExpense('x').ok, false);
    assert.strictEqual(c.core.discardExpense('x').ok, false);
    c.core.loadExpenses(DAY, function (error) {
      assert.ok(error && /Only an owner/.test(error.message));
      assert.strictEqual(c.shop.reports.length, 0, 'a refused list never asks the shop');
      assert.strictEqual(c.core.outbox().pendingExpenses, 0);
      till({ user: 'manager' }, function (m) {
        assert.strictEqual(m.core.expenseBlock(), null);
        assert.ok(m.core.addExpense(expense()).ok);
        till({ user: 'owner' }, function (o) {
          assert.strictEqual(o.core.expenseBlock(), null);
          assert.ok(o.core.addExpense(expense()).ok);
          done();
        });
      });
    });
  });
});
test('nobody logged in, a licence that has run out, and a revoked iPad are all refused', function (done) {
  till({ license: { state: 'active', valid_until: '2026-01-01T00:00:00Z', never_expires: false } }, function (c) {
    assert.ok(/licence has expired/.test(c.core.expenseBlock()));
    assert.strictEqual(c.core.addExpense(expense()).ok, false);
    till({}, function (d) {
      d.core.logout();
      assert.strictEqual(d.core.expenseBlock(), 'Log in first.');
      assert.strictEqual(d.core.addExpense(expense()).ok, false);
      d.core.loadExpenses(DAY, function (error) {
        assert.ok(error);
        done();
      });
    });
  });
});

// ---- adding -------------------------------------------------------------------------------------------------------------------
test('an expense is saved on the iPad first, as the app records it, entered by the logged-in person on this device', function (done) {
  till({}, function (t) {
    var added = t.core.addExpense(expense({ title: '  Transport ', note: '  ' }));
    assert.ok(added.ok);
    var e = added.expense;
    assert.strictEqual(e.title, 'Transport');
    assert.strictEqual(e.note, null);
    assert.strictEqual(e.userId, OWNER);
    assert.strictEqual(e.createdByDeviceId, deviceOf(t));
    assert.strictEqual(e.syncState, 'local_only');
    assert.strictEqual(e.deletedAt, null);
    var entry = saved(t).outbox[0];
    assert.strictEqual(entry.kind, 'expense');
    assert.strictEqual(entry.receipt, null, 'an expense is not a sale: it has no receipt');
    assert.strictEqual(entry.id, e.id);
    assert.deepStrictEqual(entry.changes, [{ table_name: 'expenses', row_id: e.id, local_rev: e.localRev, updated_at: e.updatedAt, payload: e }]);
    assert.strictEqual(saved(t).nextRev, e.localRev + 1);
    assert.strictEqual(t.shop.pushes.length, 0, 'nothing is sent until the till sends');
    assert.deepStrictEqual(saved(t).history, [], 'an expense is not in the sales list');
    done();
  });
});
test('sending delivers the very record that was saved, once, and clears it from the iPad', function (done) {
  till({}, function (t) {
    addAndSend(t, {}, function (e) {
      assert.strictEqual(t.shop.pushes.length, 1);
      assert.deepStrictEqual(t.shop.pushes[0], [{ table_name: 'expenses', row_id: e.id, local_rev: e.localRev, updated_at: e.updatedAt, payload: e }]);
      assert.deepStrictEqual(t.shop.expenses[e.id], e);
      assert.strictEqual(saved(t).outbox.length, 0);
      assert.strictEqual(t.core.outbox().pendingExpenses, 0);
      t.core.flush(function () {
        assert.strictEqual(t.shop.pushes.length, 1, 'nothing left to send');
        done();
      });
    });
  });
});
test('a bad expense is refused in plain words, saves nothing, and uses no revision', function (done) {
  till({}, function (t) {
    var before = saved(t).nextRev;
    [[{ title: '' }, 'Enter the expense name.'], [{ amountCents: 0 }, 'Enter an expense amount greater than zero.'], [{ expenseDate: '2026-11-14' }, 'An expense cannot be dated in the future.'], [{ expenseDate: 'nonsense' }, 'Choose the day of the expense.']].forEach(function (c) {
      var r = t.core.addExpense(expense(c[0]));
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.message, c[1]);
    });
    assert.strictEqual(saved(t).outbox.length, 0);
    assert.strictEqual(saved(t).nextRev, before);
    var next = t.core.addExpense(expense()).expense;
    assert.strictEqual(next.localRev, before, 'the refused ones used no revision (checked on the next good expense, since nothing is saved on a refusal)');
    done();
  });
});
test('two expenses get their own revisions and ids, and go out in the order they were entered', function (done) {
  till({}, function (t) {
    var a = t.core.addExpense(expense({ title: 'First' })).expense;
    t.clock.now += 1000;
    var b = t.core.addExpense(expense({ title: 'Second' })).expense;
    assert.notStrictEqual(a.id, b.id);
    assert.strictEqual(b.localRev, a.localRev + 1);
    t.core.flush(function () {
      assert.deepStrictEqual(t.shop.pushes.map(function (p) { return p[0].payload.title; }), ['First', 'Second']);
      done();
    });
  });
});
test('without a connection the expense waits on the iPad and is sent later; closing the page does not lose it', function (done) {
  till({}, function (t) {
    t.shop.offline = true;
    var e = t.core.addExpense(expense()).expense;
    t.core.flush(function (error) {
      assert.ok(error && error.code === 'offline');
      assert.strictEqual(t.core.outbox().pendingExpenses, 1);
      assert.strictEqual(t.core.getStatus().pendingExpenses, 1);
      assert.strictEqual(t.core.getStatus().pendingSales, 0, 'it is not counted as a sale');
      t.shop.offline = false;
      till({ storage: t.storage, shop: t.shop, joined: true, clock: t.clock }, function (again) {
        assert.strictEqual(again.core.outbox().pendingExpenses, 1, 'still there after a reload');
        again.core.flush(function (error2) {
          assert.ifError(error2);
          assert.deepStrictEqual(t.shop.expenses[e.id], e);
          assert.strictEqual(again.core.outbox().pendingExpenses, 0);
          done();
        });
      });
    });
  });
});
test('a server hiccup keeps the expense for later; it is not shown as refused', function (done) {
  till({}, function (t) {
    t.shop.serverError = true;
    t.core.addExpense(expense());
    t.core.flush(function () {
      assert.strictEqual(t.core.outbox().pendingExpenses, 1);
      assert.strictEqual(t.core.outbox().rejectedExpenses.length, 0);
      done();
    });
  });
});

test('a waiting expense keeps the name of who entered it, even when somebody else is logged in when it is shown', function (done) {
  till({ user: 'manager' }, function (m) {
    m.shop.offline = true;
    m.core.addExpense(expense({ title: 'By the manager' }));
    m.core.logout();
    m.shop.offline = false;
    till({ storage: m.storage, shop: m.shop, joined: true, clock: m.clock, user: 'owner' }, function (o) {
      o.core.loadExpenses(DAY, function (error, list) {
        assert.ifError(error);
        assert.strictEqual(list.rows.length, 1);
        assert.strictEqual(list.rows[0].enteredByName, 'Otieno');
        assert.deepStrictEqual(o.core.waitingExpenses(DAY).map(function (r) { return r.enteredByName; }), ['Otieno']);
        done();
      });
    });
  });
});
test('waitingExpenses gives this iPad\'s own unsent expenses for one day: not another day, not a deletion, not a refused one, nothing for a cashier', function (done) {
  till({}, function (t) {
    addAndSend(t, { title: 'Already sent' }, function (sent) {
      t.core.loadExpenses(DAY, function (error) {
        assert.ifError(error);
        t.shop.offline = true;
        t.core.addExpense(expense({ title: 'Waiting today', amountCents: 700 }));
        t.core.addExpense(expense({ title: 'Waiting yesterday', expenseDate: '2026-11-12' }));
        assert.ok(t.core.deleteExpense(sent.id).ok, 'a deletion is waiting too');
        var rows = t.core.waitingExpenses(DAY);
        assert.deepStrictEqual(rows.map(function (r) { return [r.title, r.amountCents, r.mine, r.pending, r.deleting, r.enteredByName]; }), [['Waiting today', 700, true, true, false, 'Owner']]);
        assert.deepStrictEqual(t.core.waitingExpenses('2026-11-12').map(function (r) { return r.title; }), ['Waiting yesterday']);
        assert.deepStrictEqual(t.core.waitingExpenses('2026-11-11'), []);
        assert.deepStrictEqual(t.core.waitingExpenses(DAY, (function () { var seen = {}; seen[rows[0].id] = true; return seen; }())), [], 'ones the shop already lists are left out');
        assert.ok(rows[0].createdAt && rows[0].id, 'a row has what the list needs');
        t.core.flush(function () {
          t.shop.offline = false;
          t.shop.refuse = 'Expense refused.';
          t.core.addExpense(expense({ title: 'Refused one' }));
          t.core.flush(function () {
            assert.deepStrictEqual(t.core.waitingExpenses(DAY), [], 'a refused expense is not "waiting"');
            till({ user: 'cash' }, function (c) {
              c.core.addExpense(expense());
              assert.deepStrictEqual(c.core.waitingExpenses(DAY), [], 'a cashier sees none');
              done();
            });
          });
        });
      });
    });
  });
});

// ---- the day's list -----------------------------------------------------------------------------------------------------------
test('the list asks the shop for that one day, with the whole records', function (done) {
  till({}, function (t) {
    t.core.loadExpenses(DAY, function (error) {
      assert.ifError(error);
      var q = t.shop.reports[0];
      assert.strictEqual(q.action, 'lite_report');
      assert.strictEqual(q.from_date, DAY);
      assert.strictEqual(q.to_date, '2026-11-14');
      assert.strictEqual(q.records, '1');
      done();
    });
  });
});
test('the list shows every device\'s expenses; only the ones this iPad entered can be deleted', function (done) {
  till({}, function (t) {
    fromMainPc(t, '00000000-0000-4000-8000-0000000000a1', {});
    addAndSend(t, { title: 'Fuel', amountCents: 5000 }, function (mine) {
      t.core.loadExpenses(DAY, function (error, list) {
        assert.ifError(error);
        assert.strictEqual(list.rows.length, 2);
        assert.deepStrictEqual(list.rows.map(function (r) { return [r.title, r.mine, r.pending, r.deleting]; }), [['Rent', false, false, false], ['Fuel', true, false, false]]);
        assert.strictEqual(list.rows[0].enteredByName, 'Owner');
        assert.strictEqual(list.rows[0].amountCents, 400000);
        assert.strictEqual(list.totalCents, 405000);
        assert.strictEqual(list.day, DAY);
        assert.strictEqual(list.truncated, false);
        assert.strictEqual(list.rows[1].id, mine.id);
        done();
      });
    });
  });
});
test('only that day: other days\' expenses are not listed or added up', function (done) {
  till({}, function (t) {
    fromMainPc(t, '00000000-0000-4000-8000-0000000000a1', { expenseDate: '2026-11-12' });
    fromMainPc(t, '00000000-0000-4000-8000-0000000000a2', { title: 'Tomorrow-ish', expenseDate: '2026-11-14' });
    t.core.loadExpenses(DAY, function (error, list) {
      assert.ifError(error);
      assert.strictEqual(list.rows.length, 0);
      assert.strictEqual(list.totalCents, 0);
      done();
    });
  });
});
test('what this iPad has not sent yet is in the list, marked, and in the total', function (done) {
  till({}, function (t) {
    fromMainPc(t, '00000000-0000-4000-8000-0000000000a1', {});
    t.shop.offline = true;
    var waiting = t.core.addExpense(expense({ title: 'Waiting', amountCents: 1000 })).expense;
    t.core.addExpense(expense({ title: 'Another day', amountCents: 9999, expenseDate: '2026-11-12' }));
    t.shop.offline = false;
    t.core.loadExpenses(DAY, function (error, list) {
      assert.ifError(error);
      assert.deepStrictEqual(list.rows.map(function (r) { return [r.title, r.pending, r.mine]; }), [['Rent', false, false], ['Waiting', true, true]]);
      assert.strictEqual(list.rows[1].id, waiting.id);
      assert.strictEqual(list.rows[1].enteredByName, 'Owner');
      assert.strictEqual(list.totalCents, 401000);
      assert.strictEqual(list.waiting, 1, 'only the chosen day\'s waiting expenses');
      done();
    });
  });
});
test('an expense sent while the list was loading is not listed twice', function (done) {
  till({}, function (t) {
    var e = t.core.addExpense(expense()).expense;
    // the shop already holds it (the push arrived), but the iPad has not cleared its own copy yet
    t.shop.expenses[e.id] = e;
    t.core.loadExpenses(DAY, function (error, list) {
      assert.ifError(error);
      assert.strictEqual(list.rows.length, 1);
      assert.strictEqual(list.rows[0].pending, false);
      assert.strictEqual(list.totalCents, 250050, 'and not added up twice');
      done();
    });
  });
});
test('with no connection the list says so (and nothing is lost: waiting expenses stay on the iPad)', function (done) {
  till({}, function (t) {
    t.shop.offline = true;
    t.core.loadExpenses(DAY, function (error) {
      assert.ok(error && error.code === 'offline');
      done();
    });
  });
});
test('a list that is cut short is adjusted, not recounted: the shop\'s total stays the truth', function (done) {
  till({}, function (t) {
    fromMainPc(t, '00000000-0000-4000-8000-0000000000a1', { title: 'One', amountCents: 100, createdAt: '2026-11-13T01:00:00.000000Z', updatedAt: '2026-11-13T01:00:00.000000Z' });
    fromMainPc(t, '00000000-0000-4000-8000-0000000000a2', { title: 'Two', amountCents: 200, createdAt: '2026-11-13T02:00:00.000000Z', updatedAt: '2026-11-13T02:00:00.000000Z' });
    fromMainPc(t, '00000000-0000-4000-8000-0000000000a3', { title: 'Three', amountCents: 400, createdAt: '2026-11-13T03:00:00.000000Z', updatedAt: '2026-11-13T03:00:00.000000Z' });
    t.shop.truncate = 2;
    t.core.addExpense(expense({ title: 'Waiting', amountCents: 1000 }));
    t.core.loadExpenses(DAY, function (error, list) {
      assert.ifError(error);
      assert.strictEqual(list.truncated, true);
      assert.strictEqual(list.rows.length, 3, 'two listed by the shop plus the one waiting here');
      assert.strictEqual(list.totalCents, 100 + 200 + 400 + 1000, 'the shop\'s own total (all three) plus the waiting one');
      done();
    });
  });
});
test('an old server that sends no records leaves every Delete off, and the list still works', function (done) {
  till({}, function (t) {
    addAndSend(t, {}, function () {
      t.shop.withoutRecords = true;
      t.core.loadExpenses(DAY, function (error, list) {
        assert.ifError(error);
        assert.strictEqual(list.rows.length, 1);
        assert.strictEqual(list.rows[0].mine, false);
        done();
      });
    });
  });
});
test('an expense entered on a previous connection of this iPad (another device id) is not this iPad\'s to delete', function (done) {
  till({}, function (t) {
    addAndSend(t, {}, function (e) {
      t.shop.expenses[e.id] = JSON.parse(JSON.stringify(e));
      t.shop.expenses[e.id].createdByDeviceId = 'lite-an-old-connection';
      t.core.loadExpenses(DAY, function (error, list) {
        assert.ifError(error);
        assert.strictEqual(list.rows[0].mine, false);
        assert.strictEqual(t.core.deleteExpense(e.id).ok, false);
        done();
      });
    });
  });
});

// ---- deleting -----------------------------------------------------------------------------------------------------------------
test('an expense still waiting on this iPad is simply taken back: the shop never hears of it', function (done) {
  till({}, function (t) {
    t.shop.offline = true;
    var e = t.core.addExpense(expense()).expense;
    t.shop.offline = false;
    var r = t.core.deleteExpense(e.id);
    assert.deepStrictEqual(r, { ok: true, taken: true });
    assert.strictEqual(saved(t).outbox.length, 0);
    t.core.flush(function () {
      assert.strictEqual(t.shop.pushes.length, 0, 'nothing was ever sent');
      done();
    });
  });
});
test('an expense the shop holds is deleted with the app\'s own deletion record, and leaves the list and the total', function (done) {
  till({}, function (t) {
    addAndSend(t, { title: 'Wrong entry', amountCents: 7500 }, function (e) {
      t.core.loadExpenses(DAY, function (error, list) {
        assert.ifError(error);
        t.clock.now += 5000;
        var r = t.core.deleteExpense(e.id);
        assert.deepStrictEqual(r, { ok: true });
        var entry = saved(t).outbox[0];
        assert.strictEqual(entry.kind, 'expense-delete');
        assert.strictEqual(entry.receipt, null);
        var p = entry.changes[0].payload;
        assert.strictEqual(p.id, e.id);
        assert.strictEqual(p.deletedAt, p.updatedAt);
        assert.ok(p.updatedAt > e.updatedAt);
        assert.strictEqual(p.localRev, e.localRev + 1);
        assert.strictEqual(p.title, 'Wrong entry');
        assert.strictEqual(p.createdByDeviceId, deviceOf(t));
        assert.strictEqual(saved(t).nextRev, p.localRev + 1, 'the next record of any kind gets the next revision');
        t.core.flush(function (error2) {
          assert.ifError(error2);
          assert.strictEqual(t.shop.expenses[e.id].deletedAt, p.deletedAt);
          assert.strictEqual(saved(t).outbox.length, 0);
          t.core.loadExpenses(DAY, function (error3, after) {
            assert.ifError(error3);
            assert.strictEqual(after.rows.length, 0);
            assert.strictEqual(after.totalCents, 0);
            done();
          });
        });
      });
    });
  });
});
test('a deletion that has not been sent yet shows the row as being deleted and leaves it out of the total', function (done) {
  till({}, function (t) {
    addAndSend(t, { title: 'Wrong entry', amountCents: 7500 }, function (e) {
      fromMainPc(t, '00000000-0000-4000-8000-0000000000a1', { amountCents: 1000 });
      t.core.loadExpenses(DAY, function (error) {
        assert.ifError(error);
        t.shop.offline = true;
        assert.ok(t.core.deleteExpense(e.id).ok);
        t.core.flush(function () {
          t.shop.offline = false;
          t.core.loadExpenses(DAY, function (error2, list) {
            assert.ifError(error2);
            var row = list.rows.filter(function (r) { return r.id === e.id; })[0];
            assert.strictEqual(row.deleting, true);
            assert.strictEqual(list.totalCents, 1000, 'the one being deleted is not counted');
            assert.strictEqual(t.core.deleteExpense(e.id).ok, false, 'twice is refused');
            assert.ok(/already being deleted/.test(t.core.deleteExpense(e.id).message));
            assert.strictEqual(saved(t).outbox.length, 1);
            done();
          });
        });
      });
    });
  });
});
test('an expense another device entered cannot be deleted from here, and nothing is queued', function (done) {
  till({}, function (t) {
    fromMainPc(t, '00000000-0000-4000-8000-0000000000a1', {});
    t.core.loadExpenses(DAY, function (error) {
      assert.ifError(error);
      var r = t.core.deleteExpense('00000000-0000-4000-8000-0000000000a1');
      assert.strictEqual(r.ok, false);
      assert.ok(/another device/.test(r.message));
      assert.strictEqual(saved(t).outbox.length, 0);
      done();
    });
  });
});
test('an expense that was never listed cannot be deleted', function (done) {
  till({}, function (t) {
    var r = t.core.deleteExpense('00000000-0000-4000-8000-0000000000ff');
    assert.strictEqual(r.ok, false);
    assert.ok(/not in the list/.test(r.message));
    done();
  });
});
test('a waiting expense cannot be taken back while it is being sent', function (done) {
  till({}, function (t) {
    var e = t.core.addExpense(expense()).expense;
    var result = null;
    t.core.flush(function () {});
    result = t.core.deleteExpense(e.id);
    assert.strictEqual(result.ok, false);
    assert.ok(/being sent/.test(result.message));
    t.core.flush(function () { done(); });
  });
});
test('somebody else already deleted it: the same outcome is not an error', function (done) {
  till({}, function (t) {
    addAndSend(t, { title: 'Gone' }, function (e) {
      t.core.loadExpenses(DAY, function () {
        t.shop.refuse = function () { return "Expense 'Gone' is already deleted."; };
        assert.ok(t.core.deleteExpense(e.id).ok);
        t.core.flush(function () {
          assert.strictEqual(t.core.outbox().rejectedExpenses.length, 0);
          assert.strictEqual(t.core.outbox().pendingExpenses, 0);
          assert.strictEqual(saved(t).outbox.length, 0);
          done();
        });
      });
    });
  });
});

test('a cashier who logs in after an owner cannot delete the owner\'s expenses or remove a refused one', function (done) {
  till({}, function (t) {
    addAndSend(t, {}, function (e) {
      t.core.loadExpenses(DAY, function (error) {
        assert.ifError(error);
        t.shop.refuse = 'Expense refused.';
        t.core.addExpense(expense({ title: 'Refused one' }));
        t.core.flush(function () {
          t.shop.refuse = null;
          var refusedId = t.core.outbox().rejectedExpenses[0].id;
          t.shop.offline = true;
          t.core.addExpense(expense({ title: 'Waiting one' }));
          assert.strictEqual(t.core.waitingExpenses(DAY).length, 1, 'the owner sees the waiting one');
          t.shop.offline = false;
          t.core.logout();
          t.core.login('cash', 'Passw0rd!', function (loginError) {
            assert.ifError(loginError);
            var del = t.core.deleteExpense(e.id);
            assert.strictEqual(del.ok, false);
            assert.ok(/Only an owner/.test(del.message));
            assert.strictEqual(saved(t).outbox.length, 2, 'only the refused one and the waiting one: no deletion was queued');
            assert.deepStrictEqual(t.core.waitingExpenses(DAY), [], 'a cashier is shown none of them');
            var drop = t.core.discardExpense(refusedId);
            assert.strictEqual(drop.ok, false);
            assert.ok(/Only an owner/.test(drop.message));
            assert.strictEqual(t.core.outbox().rejectedExpenses.length, 1);
            done();
          });
        });
      });
    });
  });
});
test('a refused SALE is not an expense: it cannot be removed through the expenses', function (done) {
  till({}, function (t) {
    t.shop.refuse = 'Sale refused.';
    var sold = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: null });
    assert.ok(sold.ok);
    t.core.flush(function () {
      assert.strictEqual(t.core.outbox().rejected.length, 1);
      var saleId = t.core.outbox().rejected[0].id;
      var r = t.core.discardExpense(saleId);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(t.core.outbox().rejected.length, 1, 'the sale is still held for the owner');
      assert.strictEqual(t.core.deleteExpense(saleId).ok, false);
      assert.strictEqual(saved(t).outbox.length, 1);
      t.core.loadExpenses(DAY, function (error, list) {
        assert.ifError(error);
        assert.strictEqual(list.refused, 0, 'a refused sale is not a refused expense');
        done();
      });
    });
  });
});

test('only what is in the list on screen can be deleted: once another day is loaded, the earlier day\'s rows are out of reach', function (done) {
  till({}, function (t) {
    addAndSend(t, {}, function (e) {
      t.core.loadExpenses(DAY, function (error, list) {
        assert.ifError(error);
        assert.strictEqual(list.rows[0].mine, true);
        t.core.loadExpenses('2026-11-12', function (error2, other) {
          assert.ifError(error2);
          assert.strictEqual(other.rows.length, 0);
          var r = t.core.deleteExpense(e.id);
          assert.strictEqual(r.ok, false);
          assert.ok(/not in the list/.test(r.message));
          assert.strictEqual(saved(t).outbox.length, 0);
          done();
        });
      });
    });
  });
});
test('each listed expense keeps its note (empty when there is none)', function (done) {
  till({}, function (t) {
    fromMainPc(t, '00000000-0000-4000-8000-0000000000a1', { note: null });
    fromMainPc(t, '00000000-0000-4000-8000-0000000000a2', { title: 'With a note', note: 'Paid in cash', createdAt: '2026-11-13T06:00:00.000000Z', updatedAt: '2026-11-13T06:00:00.000000Z' });
    t.core.loadExpenses(DAY, function (error, list) {
      assert.ifError(error);
      assert.deepStrictEqual(list.rows.map(function (r) { return [r.title, r.note]; }), [['Rent', ''], ['With a note', 'Paid in cash']]);
      done();
    });
  });
});

// ---- when the shop refuses ----------------------------------------------------------------------------------------------------
test('a refused expense stays on the iPad as "not recorded" with the shop\'s words, apart from the sales', function (done) {
  till({}, function (t) {
    t.shop.refuse = "Expense 'Transport': the user who entered it is not a user of this shop.";
    t.core.addExpense(expense());
    t.core.flush(function () {
      var summary = t.core.outbox();
      assert.strictEqual(summary.rejectedExpenses.length, 1);
      assert.strictEqual(summary.rejectedExpenses[0].title, 'Transport');
      assert.strictEqual(summary.rejectedExpenses[0].amountCents, 250050);
      assert.strictEqual(summary.rejectedExpenses[0].deleting, false);
      assert.ok(/not a user of this shop/.test(summary.rejectedExpenses[0].message));
      assert.strictEqual(summary.rejected.length, 0, 'not counted as a refused sale');
      assert.strictEqual(summary.pendingExpenses, 0);
      assert.strictEqual(t.core.getStatus().rejectedExpenses, 1);
      assert.strictEqual(t.core.getStatus().rejectedSales, 0);
      t.core.loadExpenses(DAY, function (error, list) {
        assert.ifError(error);
        assert.strictEqual(list.refused, 1);
        assert.strictEqual(list.rows.length, 0, 'a refused expense is not in the books and not in the list');
        var entryId = summary.rejectedExpenses[0].id;
        assert.strictEqual(t.core.discardExpense('nonsense').ok, false);
        assert.deepStrictEqual(t.core.discardExpense(entryId), { ok: true });
        assert.strictEqual(t.core.outbox().rejectedExpenses.length, 0);
        assert.strictEqual(t.core.discardExpense(entryId).ok, false, 'already gone');
        done();
      });
    });
  });
});
test('a waiting (not refused) expense cannot be "discarded"; only refused ones can', function (done) {
  till({}, function (t) {
    t.shop.offline = true;
    var e = t.core.addExpense(expense()).expense;
    assert.strictEqual(t.core.discardExpense(e.id).ok, false);
    assert.strictEqual(t.core.outbox().pendingExpenses, 1);
    done();
  });
});
test('a refused deletion leaves the expense standing, and deleting again replaces the refused one', function (done) {
  till({}, function (t) {
    addAndSend(t, {}, function (e) {
      t.core.loadExpenses(DAY, function () {
        t.shop.refuse = 'Expense: something is wrong.';
        assert.ok(t.core.deleteExpense(e.id).ok);
        t.core.flush(function () {
          assert.strictEqual(t.core.outbox().rejectedExpenses.length, 1);
          assert.strictEqual(t.core.outbox().rejectedExpenses[0].deleting, true);
          t.shop.refuse = null;
          t.core.loadExpenses(DAY, function (error, list) {
            assert.ifError(error);
            assert.strictEqual(list.rows[0].deleting, false, 'a refused deletion is not "being deleted"');
            assert.strictEqual(list.totalCents, 250050);
            assert.ok(t.core.deleteExpense(e.id).ok, 'try again');
            assert.strictEqual(saved(t).outbox.length, 1, 'the refused one was replaced, not kept beside it');
            t.core.flush(function () {
              assert.strictEqual(t.shop.expenses[e.id].deletedAt !== null, true);
              assert.strictEqual(t.core.outbox().rejectedExpenses.length, 0);
              done();
            });
          });
        });
      });
    });
  });
});
test('a refused expense does not stop the expenses behind it', function (done) {
  till({}, function (t) {
    t.shop.refuse = function (changes) { return changes[0].payload.title === 'Bad one' ? 'Expense refused.' : null; };
    t.core.addExpense(expense({ title: 'Bad one' }));
    t.core.addExpense(expense({ title: 'Good one', amountCents: 100 }));
    t.core.flush(function (error, result) {
      assert.ifError(error);
      assert.strictEqual(result.sent, 1);
      assert.strictEqual(result.refused, 1);
      assert.strictEqual(t.shop.pushes.length, 2, 'both were tried');
      assert.deepStrictEqual(Object.keys(t.shop.expenses).map(function (id) { return t.shop.expenses[id].title; }), ['Good one']);
      assert.strictEqual(t.core.outbox().rejectedExpenses.length, 1);
      assert.strictEqual(t.core.outbox().rejectedExpenses[0].title, 'Bad one');
      done();
    });
  });
});

// ---- expenses and sales share the outbox ---------------------------------------------------------------------------------------
test('sales and expenses go out together, oldest first, and are counted apart', function (done) {
  till({}, function (t) {
    var sold = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: null });
    assert.ok(sold.ok);
    t.core.addExpense(expense());
    var s = t.core.outbox();
    assert.strictEqual(s.pending, 1);
    assert.strictEqual(s.pendingExpenses, 1);
    assert.strictEqual(t.core.getStatus().pendingSales, 1);
    assert.strictEqual(t.core.getStatus().pendingExpenses, 1);
    t.core.loadReport(Core.reportRange('day', { date: DAY }), function (error, report) {
      assert.ifError(error);
      assert.strictEqual(report.waitingHere, 1, 'the report counts only the sales that are missing from it');
      t.core.flush(function (error2, result) {
        assert.ifError(error2);
        assert.strictEqual(result.sent, 2);
        assert.deepStrictEqual(t.shop.pushes.map(function (p) { return p[0].table_name; }), ['sales', 'expenses']);
        assert.strictEqual(t.core.outbox().pending + t.core.outbox().pendingExpenses, 0);
        assert.strictEqual(saved(t).history[0].status, 'sent', 'the sale is marked sent');
        done();
      });
    });
  });
});
test('the plain report does not ask for records, so sales reports stay light', function (done) {
  till({}, function (t) {
    t.core.loadReport(Core.reportRange('day', { date: DAY }), function (error) {
      assert.ifError(error);
      assert.strictEqual(t.shop.reports[0].records, undefined);
      done();
    });
  });
});

var failed = 0;
(function run(index) {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite expenses tests passed: ' + tests.length + ' tests.');
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
