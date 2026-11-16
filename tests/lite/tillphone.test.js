/*
 * "M-Pesa Till Phone" in the Lite core: the phones that pass the shop's M-Pesa payment messages on, and what they passed on.
 * A pretend shop server records exactly what the till sends (method, address, body, the device key) and answers as the real
 * one does (the platform's payment_inbox_* actions).
 *
 * Run: node tests/lite/tillphone.test.js
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
var ADMIN = '33333333-3333-4333-8333-333333333333';
var MANAGER = '44444444-4444-4444-8444-444444444444';
var CASHIER = '55555555-5555-4555-8555-555555555555';
var KEY = 'npk_0123456789abcdef0123456789abcdef0123456789abcdef';
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
function person(id, role, name) {
  return { id: id, roleId: '00000000-0000-4000-8000-00000000000' + role, name: name, username: name.toLowerCase(), passwordHash: fixtures[0].hash, status: 'active' };
}
function catalogBody() {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-11-17T10:00:00Z', cursor: 5,
    license: { state: 'active', valid_until: null, never_expires: true },
    business: { businessName: 'Mama Mboga', currency: 'KES' },
    categories: [], products: [],
    users: [person(ADMIN, 1, 'Owner'), person(MANAGER, 2, 'Manager'), person(CASHIER, 3, 'Cashier')],
    roles: []
  };
}

/**
 * A joined till with [user] logged in (null: nobody). `answer(request)` returns {status, body}, 'offline', or 'hold' (answered
 * later through t.release(result)); every payment-inbox request is kept in t.sent.
 */
function till(user, answer, done) {
  var sent = [];
  var held = [];
  var storage = fakeStorage();
  var http = function (request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    var result;
    if (action === 'register_device') { result = { status: 201, body: { success: true, api_key: 'key-1' } }; }
    else if (action === 'join_shop') { result = { status: 200, body: { success: true } }; }
    else if (action === 'lite_catalog') { result = { status: 200, body: catalogBody() }; }
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
  var core = Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, now: function () { return 1000; }, randomHex: Core.randomHex });
  core.join('INV', 'Till', function (error) {
    assert.ifError(error);
    var t = { core: core, sent: sent, storage: storage, release: function (result) { held.shift()(result); } };
    if (!user) { done(t); return; }
    core.login(user, PASSWORD, function (loginError) { assert.ifError(loginError); done(t); });
  });
}
function notJoined() {
  return Core.create({ baseUrl: BASE, http: function (r, cb) { setImmediate(function () { cb(new Error('network')); }); }, storage: fakeStorage(), bcrypt: bcrypt, sale: Sale, now: function () { return 1000; }, randomHex: Core.randomHex });
}
function phoneRow(id, label, last) {
  return { id: id, label: label, added_by: 'owner', added_at: '2026-11-17T06:00:00Z', last_message_at: last === undefined ? null : last };
}
var REFUSALS = {
  wrong: { status: 403, body: { success: false, reason: 'wrong_password', message: 'That password is not right.' } },
  locked: { status: 429, body: { success: false, reason: 'locked', message: 'Too many wrong passwords. Wait 10 minutes and try again.' } },
  notAdmin: { status: 403, body: { success: false, reason: 'not_admin', message: 'Only an administrator of the shop can do this.' } },
  tooMany: { status: 409, body: { success: false, reason: 'too_many', message: 'This shop already has 5 phones set up. Remove one first.' } },
  oldServer: { status: 404, body: { success: false, status: false, message: 'Unknown action.' } },
  noKey: { status: 401, body: { status: false, message: 'Invalid or missing API key.' } },
  disabled: { status: 403, body: { status: false, message: 'This device has been disabled.' } }
};

// ---- who may set a phone up -------------------------------------------------------------------------------------------------------
test('only a logged-in administrator of a joined till may set up or remove a phone', function (done) {
  assert.strictEqual(notJoined().tillPhoneBlock(), 'This device has not joined a shop yet.');
  till(null, function () { return { status: 200, body: {} }; }, function (nobody) {
    assert.strictEqual(nobody.core.tillPhoneBlock(), 'Log in first.');
    till('cashier', function () { return { status: 200, body: {} }; }, function (cashier) {
      assert.strictEqual(cashier.core.tillPhoneBlock(), 'Only an administrator of the shop can set up or remove a phone.');
      till('manager', function () { return { status: 200, body: {} }; }, function (manager) {
        assert.strictEqual(manager.core.tillPhoneBlock(), 'Only an administrator of the shop can set up or remove a phone.');
        till('owner', function () { return { status: 200, body: {} }; }, function (owner) {
          assert.strictEqual(owner.core.tillPhoneBlock(), null);
          done();
        });
      });
    });
  });
});

test('a cashier or a manager is refused on this iPad: nothing is even sent to the shop', function (done) {
  till('cashier', function () { return { status: 201, body: { success: true, key: KEY, phone: phoneRow(1, 'x') } }; }, function (t) {
    t.core.addTillPhone({ label: 'Mine', password: PASSWORD }, function (added) {
      assert.deepStrictEqual(added, { ok: false, message: 'Only an administrator of the shop can set up or remove a phone.', code: 'input' });
      t.core.removeTillPhone({ phoneId: 1, password: PASSWORD }, function (removed) {
        assert.strictEqual(removed.ok, false);
        assert.strictEqual(t.sent.length, 0, 'no request left the iPad');
        done();
      });
    });
  });
});

// ---- the phones --------------------------------------------------------------------------------------------------------------------
test('the phones are asked for with the device key and read into plain rows (times are the shop\'s UTC instants)', function (done) {
  till('cashier', function () {
    return { status: 200, body: { success: true, max_phones: 5, phones: [
      phoneRow(3, "Mama's iPhone", '2026-11-17T09:30:15Z'),
      phoneRow(4, 'Spare'),
      { id: '5', label: 'an id as text is not trusted' },
      { id: 0, label: 'no id' },
      null,
      { id: 6 }
    ] } };
  }, function (t) {
    t.core.tillPhones(function (error, result) {
      assert.ifError(error);
      assert.strictEqual(t.sent[0].method, 'GET');
      assert.ok(/\?action=payment_inbox_sources$/.test(t.sent[0].url), t.sent[0].url);
      assert.strictEqual(t.sent[0].auth, 'Bearer key-1');
      assert.strictEqual(t.sent[0].body, null);
      assert.deepStrictEqual(result, { max: 5, phones: [
        { id: 3, label: "Mama's iPhone", addedBy: 'owner', addedAt: Date.parse('2026-11-17T06:00:00Z'), lastMessageAt: Date.parse('2026-11-17T09:30:15Z') },
        { id: 4, label: 'Spare', addedBy: 'owner', addedAt: Date.parse('2026-11-17T06:00:00Z'), lastMessageAt: null },
        { id: 6, label: '', addedBy: '', addedAt: null, lastMessageAt: null }
      ] }, 'anyone logged in may look; rows without a real id are left out');
      done();
    });
  });
});

test('the most phones a shop may have comes from the shop (5 when it does not say)', function (done) {
  till('owner', function () { return { status: 200, body: { success: true, phones: [], max_phones: 3 } }; }, function (a) {
    a.core.tillPhones(function (error, result) {
      assert.ifError(error);
      assert.strictEqual(result.max, 3);
      till('owner', function () { return { status: 200, body: { success: true, phones: [], max_phones: 0 } }; }, function (b) {
        b.core.tillPhones(function (error2, result2) {
          assert.ifError(error2);
          assert.strictEqual(result2.max, 5);
          done();
        });
      });
    });
  });
});

test('a shop server that is not updated yet, a device that is not allowed, no internet and an unreadable answer are each said plainly', function (done) {
  var cases = [
    [REFUSALS.oldServer, 'unavailable', 'The shop server cannot do this yet. Ask the owner to update it.'],
    [REFUSALS.noKey, 'unauthorized', 'This iPad is not allowed to do this. Ask the owner to check Connected devices.'],
    [REFUSALS.disabled, 'forbidden', 'This iPad is not allowed to do this. Ask the owner to check Connected devices.'],
    ['offline', 'offline', 'Could not reach the server. Check the internet connection and try again.'],
    [{ status: 200, body: { success: true, phones: 'none' } }, 'server', 'The shop server sent a list of phones this till cannot read. Try again later.'],
    [{ status: 500, body: { success: false, message: 'Server error.' } }, 'server', 'Server error.']
  ];
  var index = 0;
  (function next() {
    if (index >= cases.length) { done(); return; }
    var c = cases[index++];
    till('owner', function () { return c[0]; }, function (t) {
      t.core.tillPhones(function (error, result) {
        assert.ok(error, 'case ' + index);
        assert.strictEqual(result, undefined);
        assert.strictEqual(error.code, c[1], 'case ' + index);
        assert.strictEqual(error.message, c[2], 'case ' + index);
        next();
      });
    });
  }());
});

test('before joining there is nothing to ask the shop', function (done) {
  var core = notJoined();
  core.tillPhones(function (error) {
    assert.strictEqual(error.message, 'This device has not joined a shop yet.');
    core.tillPayments(24, function (error2) {
      assert.strictEqual(error2.message, 'This device has not joined a shop yet.');
      done();
    });
  });
});

// ---- setting a phone up --------------------------------------------------------------------------------------------------------------
test('setting a phone up sends the name, WHO is asking and their password to the shop, and gives back the key and the address', function (done) {
  till('owner', function () { return { status: 201, body: { success: true, key: KEY, phone: phoneRow(9, "Mama's iPhone") } }; }, function (t) {
    t.core.addTillPhone({ label: "Mama's iPhone", password: 'the-password' }, function (result) {
      assert.strictEqual(t.sent.length, 1);
      assert.strictEqual(t.sent[0].method, 'POST');
      assert.ok(/\?action=payment_inbox_add_source$/.test(t.sent[0].url), t.sent[0].url);
      assert.strictEqual(t.sent[0].auth, 'Bearer key-1');
      assert.deepStrictEqual(t.sent[0].body, { label: "Mama's iPhone", user_id: ADMIN, password: 'the-password' });
      assert.deepStrictEqual(result, {
        ok: true, key: KEY, address: BASE + '?action=payment_inbox_ingest',
        phone: { id: 9, label: "Mama's iPhone", addedBy: 'owner', addedAt: Date.parse('2026-11-17T06:00:00Z'), lastMessageAt: null }
      });
      assert.strictEqual(t.core.tillPhoneAddress(), BASE + '?action=payment_inbox_ingest');
      done();
    });
  });
});

test('neither the password nor the key is kept on the iPad', function (done) {
  till('owner', function () { return { status: 201, body: { success: true, key: KEY, phone: phoneRow(9, 'P') } }; }, function (t) {
    t.core.addTillPhone({ label: 'P', password: 'a-very-secret-password' }, function (result) {
      assert.strictEqual(result.ok, true);
      var kept = JSON.stringify(t.storage.data);
      assert.ok(kept.length > 100, 'the till does keep its own state');
      assert.strictEqual(kept.indexOf('a-very-secret-password'), -1, 'the password is not stored');
      assert.strictEqual(kept.indexOf(KEY), -1, 'the key is not stored');
      assert.strictEqual(kept.indexOf('npk_'), -1);
      done();
    });
  });
});

test('without a password nothing is sent', function (done) {
  till('owner', function () { return { status: 201, body: { success: true, key: KEY, phone: phoneRow(9, 'P') } }; }, function (t) {
    t.core.addTillPhone({ label: 'P', password: '' }, function (a) {
      assert.deepStrictEqual(a, { ok: false, message: 'Enter your password.', code: 'input' });
      t.core.addTillPhone({ label: 'P' }, function (b) {
        assert.strictEqual(b.message, 'Enter your password.');
        t.core.addTillPhone(null, function (c) {
          assert.strictEqual(c.message, 'Enter your password.');
          assert.strictEqual(t.sent.length, 0);
          done();
        });
      });
    });
  });
});

test('the shop\'s own words are shown when it says no: wrong password, locked, not an administrator, too many phones', function (done) {
  var cases = [
    [REFUSALS.wrong, 'wrong_password', 'That password is not right.'],
    [REFUSALS.locked, 'locked', 'Too many wrong passwords. Wait 10 minutes and try again.'],
    [REFUSALS.notAdmin, 'not_admin', 'Only an administrator of the shop can do this.'],
    [REFUSALS.tooMany, 'too_many', 'This shop already has 5 phones set up. Remove one first.'],
    [REFUSALS.oldServer, 'unavailable', 'The shop server cannot do this yet. Ask the owner to update it.'],
    [REFUSALS.noKey, 'unauthorized', 'This iPad is not allowed to do this. Ask the owner to check Connected devices.'],
    [REFUSALS.disabled, 'forbidden', 'This iPad is not allowed to do this. Ask the owner to check Connected devices.'],
    ['offline', 'offline', 'Could not reach the server. Check the internet connection and try again.']
  ];
  var index = 0;
  (function next() {
    if (index >= cases.length) { done(); return; }
    var c = cases[index++];
    till('owner', function () { return c[0]; }, function (t) {
      t.core.addTillPhone({ label: 'P', password: 'x' }, function (result) {
        assert.deepStrictEqual(result, { ok: false, message: c[2], code: c[1] }, 'adding, case ' + index);
        t.core.removeTillPhone({ phoneId: 3, password: 'x' }, function (removed) {
          assert.deepStrictEqual(removed, { ok: false, message: c[2], code: c[1] }, 'removing, case ' + index);
          next();
        });
      });
    });
  }());
});

test('a key the till cannot read is not passed off as one', function (done) {
  var bad = [
    { success: true, key: 'npk_short', phone: phoneRow(9, 'P') },
    { success: true, key: KEY.toUpperCase(), phone: phoneRow(9, 'P') },
    { success: true, key: KEY + '0', phone: phoneRow(9, 'P') },
    { success: true, key: 12345, phone: phoneRow(9, 'P') },
    { success: true, phone: phoneRow(9, 'P') },
    { success: true, key: KEY },
    { success: true, key: KEY, phone: { id: 0, label: 'P' } },
    { success: true, key: KEY, phone: 'P' }
  ];
  var index = 0;
  (function next() {
    if (index >= bad.length) { done(); return; }
    var body = bad[index++];
    till('owner', function () { return { status: 201, body: body }; }, function (t) {
      t.core.addTillPhone({ label: 'P', password: 'x' }, function (result) {
        assert.deepStrictEqual(result, { ok: false, message: 'The shop server sent a key this till cannot read. Remove the new phone from the list and set it up again.', code: 'server' }, 'case ' + index);
        next();
      });
    });
  }());
});

test('one at a time: a second tap while the shop is still answering waits', function (done) {
  till('owner', function () { return 'hold'; }, function (t) {
    var first = null;
    t.core.addTillPhone({ label: 'One', password: 'x' }, function (result) { first = result; });
    t.core.addTillPhone({ label: 'Two', password: 'x' }, function (second) {
      assert.deepStrictEqual(second, { ok: false, message: 'Wait a moment.', code: 'busy' });
      t.core.removeTillPhone({ phoneId: 3, password: 'x' }, function (third) {
        assert.deepStrictEqual(third, { ok: false, message: 'Wait a moment.', code: 'busy' });
        assert.strictEqual(t.sent.length, 1, 'only the first went to the shop');
        t.release({ status: 201, body: { success: true, key: KEY, phone: phoneRow(9, 'One') } });
        setTimeout(function () {
          assert.strictEqual(first.ok, true);
          // and afterwards the till is free again
          t.core.addTillPhone({ label: 'Three', password: 'x' }, function () {});
          assert.strictEqual(t.sent.length, 2);
          t.release({ status: 201, body: { success: true, key: KEY, phone: phoneRow(10, 'Three') } });
          done();
        }, 20);
      });
    });
  });
});

test('after a refusal the till is free again (not stuck on "Wait a moment")', function (done) {
  var answers = [REFUSALS.wrong, 'offline', { status: 201, body: { success: true, key: KEY, phone: phoneRow(9, 'P') } }];
  till('owner', function () { return answers.shift(); }, function (t) {
    t.core.addTillPhone({ label: 'P', password: 'x' }, function (a) {
      assert.strictEqual(a.code, 'wrong_password');
      t.core.addTillPhone({ label: 'P', password: 'x' }, function (b) {
        assert.strictEqual(b.code, 'offline');
        t.core.addTillPhone({ label: 'P', password: 'x' }, function (c) {
          assert.strictEqual(c.ok, true);
          done();
        });
      });
    });
  });
});

test('after a refused removal, and after a removal that worked, the till is free again too', function (done) {
  var answers = [REFUSALS.wrong, 'offline', { status: 200, body: { success: true, phones: [] } }, { status: 201, body: { success: true, key: KEY, phone: phoneRow(9, 'P') } }];
  till('owner', function () { return answers.shift(); }, function (t) {
    t.core.removeTillPhone({ phoneId: 3, password: 'x' }, function (a) {
      assert.strictEqual(a.code, 'wrong_password');
      t.core.removeTillPhone({ phoneId: 3, password: 'x' }, function (b) {
        assert.strictEqual(b.code, 'offline');
        t.core.removeTillPhone({ phoneId: 3, password: 'x' }, function (c) {
          assert.deepStrictEqual(c, { ok: true, phones: [] });
          t.core.addTillPhone({ label: 'P', password: 'x' }, function (d) {
            assert.strictEqual(d.ok, true);
            assert.strictEqual(t.sent.length, 4, 'every one of the four went to the shop');
            done();
          });
        });
      });
    });
  });
});

test('a key that arrives after the administrator was logged out is not handed to whoever is at the till', function (done) {
  till('owner', function () { return 'hold'; }, function (t) {
    t.core.addTillPhone({ label: 'P', password: 'x' }, function (result) {
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.code, 'logged_out');
      assert.strictEqual(result.key, undefined);
      assert.strictEqual(JSON.stringify(result).indexOf('npk_'), -1);
      done();
    });
    t.core.logout();
    t.core.login('cashier', PASSWORD, function (error) {
      assert.ifError(error);
      t.release({ status: 201, body: { success: true, key: KEY, phone: phoneRow(9, 'P') } });
    });
  });
});

// ---- removing a phone ----------------------------------------------------------------------------------------------------------------
test('removing a phone sends which phone, who is asking and their password, and gives back the phones that are left', function (done) {
  till('owner', function () { return { status: 200, body: { success: true, phones: [phoneRow(4, 'Spare')] } }; }, function (t) {
    t.core.removeTillPhone({ phoneId: 3, password: 'the-password' }, function (result) {
      assert.strictEqual(t.sent[0].method, 'POST');
      assert.ok(/\?action=payment_inbox_remove_source$/.test(t.sent[0].url), t.sent[0].url);
      assert.strictEqual(t.sent[0].auth, 'Bearer key-1');
      assert.deepStrictEqual(t.sent[0].body, { phone_id: 3, user_id: ADMIN, password: 'the-password' });
      assert.deepStrictEqual(result, { ok: true, phones: [{ id: 4, label: 'Spare', addedBy: 'owner', addedAt: Date.parse('2026-11-17T06:00:00Z'), lastMessageAt: null }] });
      done();
    });
  });
});

test('removing needs a real phone and a password before anything is sent', function (done) {
  till('owner', function () { return { status: 200, body: { success: true, phones: [] } }; }, function (t) {
    var bad = [[{ phoneId: 0, password: 'x' }, 'Choose the phone to remove.'], [{ phoneId: '3', password: 'x' }, 'Choose the phone to remove.'], [{ phoneId: 2.5, password: 'x' }, 'Choose the phone to remove.'],
      [{ password: 'x' }, 'Choose the phone to remove.'], [null, 'Choose the phone to remove.'], [{ phoneId: 3, password: '' }, 'Enter your password.'], [{ phoneId: 3 }, 'Enter your password.']];
    var index = 0;
    (function next() {
      if (index >= bad.length) {
        assert.strictEqual(t.sent.length, 0);
        done();
        return;
      }
      var c = bad[index++];
      t.core.removeTillPhone(c[0], function (result) {
        assert.deepStrictEqual(result, { ok: false, message: c[1], code: 'input' }, 'case ' + index);
        next();
      });
    }());
  });
});

test('an answer without a list of phones reads as none left', function (done) {
  till('owner', function () { return { status: 200, body: { success: true } }; }, function (t) {
    t.core.removeTillPhone({ phoneId: 3, password: 'x' }, function (result) {
      assert.deepStrictEqual(result, { ok: true, phones: [] });
      done();
    });
  });
});

// ---- the payments ---------------------------------------------------------------------------------------------------------------------
test('payments are asked for over a number of hours and read into plain rows', function (done) {
  till('cashier', function () {
    return { status: 200, body: { success: true, server_time: '2026-11-17T10:00:00Z', phones: 2, payments: [
      { code: 'SJK2TILL9X', message_received: true, amount_cents: 50000, payer_name: 'JOHN DOE', payer_phone: '254712345678', account_ref: null, paid_at_text: '17/11/26 9:05 AM',
        message: 'SJK2TILL9X Confirmed...', received_at: '2026-11-17T06:05:09Z', phone_label: "Mama's iPhone", used: null },
      { code: 'SJK3PAYB7Q', message_received: true, amount_cents: 235000, payer_name: 'JANE WANJIKU', payer_phone: null, account_ref: 'INV-1042', paid_at_text: '17/11/26 1:05 PM',
        message: '...', received_at: '2026-11-17T10:05:00Z', phone_label: 'Spare', used: { sale_id: 's-1', sale_number: 'ABC-20261117-XY12', amount_cents: 230000, at: '2026-11-17T10:06:00Z' } },
      { code: 'TYP3DCODE1', message_received: false, amount_cents: null, payer_name: null, payer_phone: null, account_ref: null, paid_at_text: null, message: null, received_at: null, phone_label: null,
        used: { sale_id: 's-2', sale_number: 'ABC-20261117-ZZ99', amount_cents: 30000, at: '2026-11-17T09:00:00Z' } }
    ] } };
  }, function (t) {
    t.core.tillPayments(24, function (error, result) {
      assert.ifError(error);
      assert.strictEqual(t.sent[0].method, 'GET');
      assert.ok(/\?action=payment_inbox_list&hours=24$/.test(t.sent[0].url), t.sent[0].url);
      assert.strictEqual(t.sent[0].auth, 'Bearer key-1');
      assert.deepStrictEqual(result, { phones: 2, payments: [
        { code: 'SJK2TILL9X', messageReceived: true, amountCents: 50000, payerName: 'JOHN DOE', payerPhone: '254712345678', accountRef: '', paidAtText: '17/11/26 9:05 AM',
          receivedAt: Date.parse('2026-11-17T06:05:09Z'), phoneLabel: "Mama's iPhone", used: null },
        { code: 'SJK3PAYB7Q', messageReceived: true, amountCents: 235000, payerName: 'JANE WANJIKU', payerPhone: '', accountRef: 'INV-1042', paidAtText: '17/11/26 1:05 PM',
          receivedAt: Date.parse('2026-11-17T10:05:00Z'), phoneLabel: 'Spare', used: { saleNumber: 'ABC-20261117-XY12', amountCents: 230000, usedAt: Date.parse('2026-11-17T10:06:00Z') } },
        { code: 'TYP3DCODE1', messageReceived: false, amountCents: null, payerName: '', payerPhone: '', accountRef: '', paidAtText: '',
          receivedAt: null, phoneLabel: '', used: { saleNumber: 'ABC-20261117-ZZ99', amountCents: 30000, usedAt: Date.parse('2026-11-17T09:00:00Z') } }
      ] });
      done();
    });
  });
});

test('the hours asked for are 1 to 72; anything else is the last 24', function (done) {
  var asked = [[48, 48], [1, 1], [72, 72], [0, 24], [73, 24], [-5, 24], [2.5, 24], ['48', 24], [undefined, 24], [null, 24]];
  till('owner', function () { return { status: 200, body: { success: true, phones: 0, payments: [] } }; }, function (t) {
    var index = 0;
    (function next() {
      if (index >= asked.length) { done(); return; }
      var c = asked[index++];
      t.core.tillPayments(c[0], function (error, result) {
        assert.ifError(error);
        assert.deepStrictEqual(result, { payments: [], phones: 0 });
        assert.ok(new RegExp('&hours=' + c[1] + '$').test(t.sent[t.sent.length - 1].url), JSON.stringify(c[0]) + ' -> ' + t.sent[t.sent.length - 1].url);
        next();
      });
    }());
  });
});

test('odd rows are read carefully: no code is no payment, an amount that is not whole cents is unknown, "received" must be exactly true', function (done) {
  till('owner', function () {
    return { status: 200, body: { success: true, phones: 'two', payments: [
      { message_received: true, amount_cents: 100 },
      { code: '', message_received: true, amount_cents: 100 },
      null,
      { code: 'ODD1AMOUNT', message_received: 'yes', amount_cents: '100', payer_name: 7, used: 'sale' },
      { code: 'ODD2AMOUNT', message_received: 1, amount_cents: 10.5, used: { sale_number: 5, amount_cents: '9', at: 'never' } }
    ] } };
  }, function (t) {
    t.core.tillPayments(24, function (error, result) {
      assert.ifError(error);
      assert.strictEqual(result.phones, 0);
      assert.deepStrictEqual(result.payments, [
        { code: 'ODD1AMOUNT', messageReceived: false, amountCents: null, payerName: '', payerPhone: '', accountRef: '', paidAtText: '', receivedAt: null, phoneLabel: '', used: null },
        { code: 'ODD2AMOUNT', messageReceived: false, amountCents: null, payerName: '', payerPhone: '', accountRef: '', paidAtText: '', receivedAt: null, phoneLabel: '', used: { saleNumber: '', amountCents: null, usedAt: null } }
      ]);
      done();
    });
  });
});

test('payments: a shop server that is not updated, no internet and an unreadable answer are each said plainly', function (done) {
  var cases = [
    [REFUSALS.oldServer, 'unavailable', 'The shop server cannot do this yet. Ask the owner to update it.'],
    [REFUSALS.noKey, 'unauthorized', 'This iPad is not allowed to do this. Ask the owner to check Connected devices.'],
    ['offline', 'offline', 'Could not reach the server. Check the internet connection and try again.'],
    [{ status: 200, body: { success: true, payments: {} } }, 'server', 'The shop server sent payments this till cannot read. Try again later.']
  ];
  var index = 0;
  (function next() {
    if (index >= cases.length) { done(); return; }
    var c = cases[index++];
    till('owner', function () { return c[0]; }, function (t) {
      t.core.tillPayments(24, function (error) {
        assert.strictEqual(error.code, c[1], 'case ' + index);
        assert.strictEqual(error.message, c[2], 'case ' + index);
        next();
      });
    });
  }());
});

var failed = 0;
var index = 0;
(function next() {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite till phone tests passed: ' + tests.length + ' tests.');
    return;
  }
  var t = tests[index++];
  var finished = false;
  var timer = setTimeout(function () { if (!finished) { finished = true; failed++; console.error('FAIL ' + t.name + '\n  timed out'); next(); } }, 15000);
  try {
    t.fn(function () { if (!finished) { finished = true; clearTimeout(timer); next(); } });
  } catch (error) {
    if (!finished) { finished = true; clearTimeout(timer); failed++; console.error('FAIL ' + t.name + '\n  ' + (error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n  ') : error)); next(); }
  }
}());
process.on('uncaughtException', function (error) {
  console.error('FAIL (uncaught): ' + (error && error.stack ? error.stack.split('\n').slice(0, 8).join('\n  ') : error));
  process.exit(1);
});
