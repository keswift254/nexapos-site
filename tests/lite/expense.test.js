/*
 * The Lite expense builder must produce exactly what the real NexaPOS app records for the same expense.
 * fixtures/expense_scenarios.json is written by the app's own tests (the app's real ExpenseService creates and deletes the
 * expenses and the sync records are captured; the platform's sync guard is tested against the very same file). Here the same
 * expenses are made through lite/lite-sale.js and compared field for field; only what legitimately differs between runs (ids,
 * times, revisions, the device) is masked.
 *
 * Run: node tests/lite/expense.test.js
 */
'use strict';

var assert = require('assert');
var Sale = require('../../lite/lite-sale.js');
var fixture = require('./fixtures/expense_scenarios.json');

var scenarios = {};
fixture.scenarios.forEach(function (s) { scenarios[s.name] = s; });

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

var NOW = new Date(2026, 10, 13, 14, 30, 5, 123).getTime(); // 13 Nov 2026, local time
var DEVICE_ID = 'lite-9f3a2c1d5e6b7a8c9d0e1f2a';
var USER_ID = fixture.scenarios[0].context.userId;
function randomHex(bytes) { return require('crypto').randomBytes(bytes).toString('hex'); }

function make(overrides) {
  var input = { title: 'Transport', amountCents: 250050, expenseDate: '2026-11-05', note: 'Delivery to Kisumu', userId: USER_ID, deviceId: DEVICE_ID, now: function () { return NOW; }, nextRev: 1, randomHex: randomHex };
  for (var k in overrides) { input[k] = overrides[k]; }
  return Sale.buildExpense(input);
}

function mask(change) {
  var p = JSON.parse(JSON.stringify(change.payload));
  p.id = '<id>';
  p.createdAt = '<time>';
  p.updatedAt = '<time>';
  if (p.deletedAt !== null) { p.deletedAt = '<time>'; }
  p.localRev = '<rev>';
  p.createdByDeviceId = '<device>';
  return { table_name: change.table_name, payload: p };
}
function sorted(value) {
  if (Array.isArray(value)) { return value.map(sorted); }
  if (value && typeof value === 'object') { var o = {}; Object.keys(value).sort().forEach(function (k) { o[k] = sorted(value[k]); }); return o; }
  return value;
}
function sameAsApp(name, built, stage) {
  var expected = scenarios[name].stages[stage || 0].changes;
  assert.ok(built.ok, built.message);
  assert.strictEqual(built.changes.length, expected.length, name + ': number of records');
  assert.deepStrictEqual(sorted(mask(built.changes[0])), sorted(mask(expected[0])), name + ': the record differs from what the app writes');
  assert.strictEqual(built.changes[0].table_name, 'expenses');
  assert.strictEqual(built.changes[0].row_id, built.changes[0].payload.id, 'the change is filed under the expense id');
  assert.strictEqual(built.changes[0].local_rev, built.changes[0].payload.localRev, 'the change carries the record\'s revision');
  assert.strictEqual(built.changes[0].updated_at, built.changes[0].payload.updatedAt, 'the change carries the record\'s time');
}

// ---- the same expenses as the app's own tests ----------------------------------------------------------------------
test('an expense with a user and a note = what the app records', function () {
  sameAsApp('expense_with_user_and_note', make({}));
});
test('an expense without a note, for no user = what the app records', function () {
  sameAsApp('expense_without_user_or_note', make({ title: 'Water', amountCents: 15000, note: '', userId: null }));
});
test('a name with spaces round it and a blank note = what the app records', function () {
  sameAsApp('expense_with_trimmed_name', make({ title: '  Packaging  ', amountCents: 99, expenseDate: '2026-01-31', note: '   ' }));
});
test('deleting an expense = what the app records', function () {
  var added = make({ title: 'Wrong entry', amountCents: 7500, note: 'typo' });
  assert.ok(added.ok);
  var removed = Sale.deleteExpense({ original: added.expense, deviceId: DEVICE_ID, now: function () { return NOW + 4; }, nextRev: added.nextRev });
  sameAsApp('expense_created_then_deleted', removed, 1);
  var p = removed.changes[0].payload;
  assert.strictEqual(p.deletedAt, p.updatedAt, 'deleted and updated at the same moment');
  assert.ok(p.updatedAt > added.expense.updatedAt, 'the deletion is newer than the expense');
  assert.strictEqual(p.localRev, added.nextRev, 'the next revision');
  assert.strictEqual(removed.nextRev, added.nextRev + 1);
  assert.strictEqual(added.expense.deletedAt, null, 'the original record is not changed');
});

// ---- what is put into the record -----------------------------------------------------------------------------------------
test('the record is stamped like the app stamps one', function () {
  var built = make({ nextRev: 41 });
  var p = built.changes[0].payload;
  assert.strictEqual(p.createdByDeviceId, DEVICE_ID);
  assert.strictEqual(p.syncState, 'local_only');
  assert.strictEqual(p.deletedAt, null);
  assert.strictEqual(p.createdAt, p.updatedAt, 'created and updated at the same moment');
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(p.createdAt), 'time in the app\'s format: ' + p.createdAt);
  assert.strictEqual(p.localRev, 41);
  assert.strictEqual(built.nextRev, 42);
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.id), 'a version 4 id');
  assert.strictEqual(built.expense, p);
  assert.deepStrictEqual(Object.keys(p).sort(), ['amountCents', 'createdAt', 'createdByDeviceId', 'deletedAt', 'expenseDate', 'id', 'localRev', 'note', 'syncState', 'title', 'updatedAt', 'userId']);
});
test('two expenses never share an id', function () {
  assert.notStrictEqual(make({}).changes[0].payload.id, make({}).changes[0].payload.id);
});
test('the name and note are cleaned: control characters out, spaces trimmed, cut to the limits', function () {
  var p = make({ title: '\n Fuel\tfor\u0001van ', note: ' a\u0000b ' }).changes[0].payload;
  assert.strictEqual(p.title, 'Fuel for van');
  assert.strictEqual(p.note, 'a b');
  var long = make({ title: new Array(260).join('x'), note: new Array(600).join('n') }).changes[0].payload;
  assert.strictEqual(long.title.length, 200);
  assert.strictEqual(long.note.length, 500);
  var spaced = make({ title: new Array(199).join('x') + '   yyyy', note: new Array(499).join('n') + '   zzz' }).changes[0].payload;
  assert.ok(spaced.title === spaced.title.replace(/^\s+|\s+$/g, ''), 'a cut that leaves a space at the end is trimmed again');
  assert.ok(spaced.note === spaced.note.replace(/^\s+|\s+$/g, ''));
});
test('a note of only spaces or control characters is no note', function () {
  assert.strictEqual(make({ note: ' \u0001 ' }).changes[0].payload.note, null);
  assert.strictEqual(make({ note: null }).changes[0].payload.note, null);
  assert.strictEqual(make({ note: undefined }).changes[0].payload.note, null);
});
test('no user means null, not an empty text', function () {
  assert.strictEqual(make({ userId: undefined }).changes[0].payload.userId, null);
  assert.strictEqual(make({ userId: '' }).changes[0].payload.userId, null);
});

// ---- what is refused, in the app's own words ---------------------------------------------------------------------------------
test('an expense needs a name', function () {
  ['', '   ', '\n\t', '\u0001', null, undefined].forEach(function (title) {
    var r = make({ title: title });
    assert.strictEqual(r.ok, false, JSON.stringify(title));
    assert.strictEqual(r.message, 'Enter the expense name.');
  });
});
test('the amount must be above zero and a whole number of cents', function () {
  [0, -1, -50000, 1.5, NaN, Infinity, '500', null, undefined].forEach(function (amount) {
    var r = make({ amountCents: amount });
    assert.strictEqual(r.ok, false, String(amount));
    assert.strictEqual(r.message, 'Enter an expense amount greater than zero.');
  });
  assert.strictEqual(make({ amountCents: 1 }).ok, true, 'one cent is allowed');
});
test('the amount has a ceiling the shop server also holds to', function () {
  assert.strictEqual(make({ amountCents: 100000000 }).ok, true);
  var r = make({ amountCents: 100000001 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.message, 'That amount is too large.');
});
test('the day must be a real calendar day', function () {
  ['', null, undefined, '2026-13-01', '2026-02-30', '2026-11-31', '13/11/2026', '2026-1-5', '2026-11-05T10:00', ' 2026-11-05', '20261105', 'today', 20261105, '0026-11-05'].forEach(function (day) {
    var r = make({ expenseDate: day });
    assert.strictEqual(r.ok, false, JSON.stringify(day));
    assert.strictEqual(r.message, 'Choose the day of the expense.');
  });
  assert.strictEqual(make({ expenseDate: '2028-02-29' }).ok, false, 'a leap day in the future is still the future');
  assert.strictEqual(make({ expenseDate: '2024-02-29' }).ok, true, 'a real leap day');
});
test('the day cannot be before 2020 or after today', function () {
  assert.strictEqual(make({ expenseDate: '2019-12-31' }).ok, false);
  assert.strictEqual(make({ expenseDate: '2019-12-31' }).message, 'An expense cannot be dated before 2020.');
  assert.strictEqual(make({ expenseDate: '2020-01-01' }).ok, true, '1 January 2020 is allowed');
  assert.strictEqual(make({ expenseDate: '2026-11-13' }).ok, true, 'today is allowed');
  var tomorrow = make({ expenseDate: '2026-11-14' });
  assert.strictEqual(tomorrow.ok, false);
  assert.strictEqual(tomorrow.message, 'An expense cannot be dated in the future.');
  assert.strictEqual(make({ expenseDate: '2099-01-01' }).ok, false);
});
test('"today" follows the iPad\'s own clock at the moment of saving, including just after midnight', function () {
  var justAfterMidnight = new Date(2026, 10, 14, 0, 0, 1, 0).getTime();
  assert.strictEqual(make({ expenseDate: '2026-11-14', now: function () { return justAfterMidnight; } }).ok, true);
  var justBeforeMidnight = new Date(2026, 10, 13, 23, 59, 59, 999).getTime();
  assert.strictEqual(make({ expenseDate: '2026-11-14', now: function () { return justBeforeMidnight; } }).ok, false);
  assert.strictEqual(Sale.dayOf(justAfterMidnight), '2026-11-14');
  assert.strictEqual(Sale.dayOf(justBeforeMidnight), '2026-11-13');
});
test('a refused expense hands back no records', function () {
  var r = make({ title: '' });
  assert.strictEqual(r.changes, undefined);
  assert.strictEqual(r.nextRev, undefined);
});

// ---- deleting ----------------------------------------------------------------------------------------------------------------
function stored(overrides) {
  var added = make({ title: 'Wrong entry', amountCents: 7500, note: 'typo' }).expense;
  for (var k in overrides) { added[k] = overrides[k]; }
  return added;
}
function remove(original, overrides) {
  var input = { original: original, deviceId: DEVICE_ID, now: function () { return NOW + 10; }, nextRev: 20 };
  for (var k in overrides) { input[k] = overrides[k]; }
  return Sale.deleteExpense(input);
}
test('only the device that entered an expense can delete it', function () {
  var r = remove(stored({ createdByDeviceId: '51e9906b-2d41-4be4-83d3-2416e3ae184f' }));
  assert.strictEqual(r.ok, false);
  assert.ok(/another device/.test(r.message));
  assert.strictEqual(r.changes, undefined);
});
test('an expense that is already deleted cannot be deleted again', function () {
  var r = remove(stored({ deletedAt: '2026-11-13T10:00:00.000000Z' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.message, 'That expense is already deleted.');
});
test('something that is not an expense record is refused', function () {
  [null, undefined, {}, 'x', 5].forEach(function (original) {
    var r = remove(original);
    assert.strictEqual(r.ok, false, JSON.stringify(original));
    assert.strictEqual(r.message, 'That expense could not be found.');
  });
});
test('the deletion changes nothing but the times and the revision', function () {
  var original = stored({});
  var snapshot = JSON.stringify(original);
  var r = remove(original);
  assert.ok(r.ok);
  var p = r.changes[0].payload;
  Object.keys(original).forEach(function (key) {
    if (['updatedAt', 'deletedAt', 'localRev'].indexOf(key) < 0) {
      assert.deepStrictEqual(p[key], original[key], key + ' must not change');
    }
  });
  assert.strictEqual(JSON.stringify(original), snapshot, 'the record handed in is not changed');
  assert.strictEqual(r.changes[0].local_rev, 20);
  assert.strictEqual(r.nextRev, 21);
});
test('the deletion is always newer than the expense, even when the iPad\'s clock is behind it', function () {
  // the expense was recorded "in the future" as far as this iPad's clock is concerned (another clock, or a clock put back)
  var original = stored({ createdAt: '2026-11-20T10:00:00.123456Z', updatedAt: '2026-11-20T10:00:00.123456Z' });
  var r = remove(original);
  assert.ok(r.ok);
  var p = r.changes[0].payload;
  assert.ok(p.updatedAt > original.updatedAt, p.updatedAt + ' must be later than ' + original.updatedAt);
  assert.strictEqual(p.deletedAt, p.updatedAt);
  // equal to the millisecond
  var same = stored({ createdAt: Sale.isoStamp(NOW + 10), updatedAt: Sale.isoStamp(NOW + 10) });
  var r2 = remove(same);
  assert.ok(r2.changes[0].payload.updatedAt > same.updatedAt);
});
test('a deletion keeps the app\'s time format', function () {
  var p = remove(stored({})).changes[0].payload;
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(p.updatedAt), p.updatedAt);
});

var failed = 0;
tests.forEach(function (t) {
  try { t.fn(); } catch (error) { failed++; console.error('FAIL ' + t.name + '\n  ' + (error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n  ') : error)); }
});
if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
console.log('Lite expense builder tests passed: ' + tests.length + ' tests (4 expenses match the real app field for field).');
