/*
 * My License in the Lite core: the device ID, and the time left on the shop's licence counted by the SHOP's clock (the iPad's own
 * clock, however wrong, never changes it).
 *
 * Run: node tests/lite/license.test.js
 */
'use strict';

var assert = require('assert');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');

var BASE = 'https://sync.test/index.php';
var SERVER_NOW = Date.parse('2026-11-16T10:00:00Z');
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function fakeStorage() {
  var data = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}

/** A joined till whose own clock is [deviceNow] and whose shop says its licence is [license] (the shop's time is SERVER_NOW). */
function till(license, deviceNow, done) {
  var clock = { now: deviceNow };
  var http = function (request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    var body = { success: true };
    if (action === 'register_device') { body = { success: true, api_key: 'key-1' }; }
    if (action === 'lite_catalog') {
      body = { success: true, shop_id: 7, device_id: 'x', server_time: new Date(SERVER_NOW).toISOString().replace('.000Z', 'Z'), cursor: 1, license: license, business: { businessName: 'Mama Mboga', currency: 'KES' }, categories: [], products: [], users: [], roles: [] };
    }
    setImmediate(function () { cb(null, { status: action === 'register_device' ? 201 : 200, text: JSON.stringify(body) }); });
  };
  var core = Core.create({ baseUrl: BASE, http: http, storage: fakeStorage(), bcrypt: bcrypt, sale: Sale, now: function () { return clock.now; }, randomHex: Core.randomHex });
  core.join('INV', 'Till', function (error) { assert.ifError(error); done(core, clock); });
}

test('the device ID is the one the shop knows this iPad by', function (done) {
  till({ state: 'active', valid_until: null, never_expires: true }, SERVER_NOW, function (core) {
    var id = core.getStatus().deviceId;
    assert.ok(/^lite-[0-9a-f]{24}$/.test(id), id);
    assert.strictEqual(core.getStatus().deviceId, id, 'it does not change');
    done();
  });
});

test('before joining there is no device ID', function (done) {
  var core = Core.create({ baseUrl: BASE, http: function () {}, storage: fakeStorage(), bcrypt: bcrypt, sale: Sale, now: function () { return 1; }, randomHex: Core.randomHex });
  assert.strictEqual(core.getStatus().deviceId, '');
  done();
});

test('a licence that never ends has no time left to count', function (done) {
  till({ state: 'active', valid_until: null, never_expires: true }, SERVER_NOW, function (core) {
    var license = core.licenseDetails();
    assert.strictEqual(license.neverExpires, true);
    assert.strictEqual(license.validUntil, null);
    assert.strictEqual(license.remainingMs, null);
    assert.strictEqual(license.ok, true);
    done();
  });
});

test('the time left is the licence\'s end minus the shop\'s time: 2 days 3 hours exactly', function (done) {
  var end = new Date(SERVER_NOW + (2 * 86400000) + (3 * 3600000)).toISOString().replace('.000Z', 'Z');
  till({ state: 'active', valid_until: end, never_expires: false }, SERVER_NOW, function (core) {
    var license = core.licenseDetails();
    assert.strictEqual(license.validUntil, SERVER_NOW + 2 * 86400000 + 3 * 3600000);
    assert.strictEqual(license.remainingMs, 2 * 86400000 + 3 * 3600000);
    assert.strictEqual(license.ok, true);
    done();
  });
});

test('this iPad\'s clock being wrong (an hour behind, a week ahead) does not change the time left', function (done) {
  var end = new Date(SERVER_NOW + 5 * 86400000).toISOString().replace('.000Z', 'Z');
  till({ state: 'active', valid_until: end, never_expires: false }, SERVER_NOW - 3600000, function (behind, behindClock) {
    assert.strictEqual(behind.licenseDetails().remainingMs, 5 * 86400000, 'an hour behind');
    behindClock.now += 60000;
    assert.strictEqual(behind.licenseDetails().remainingMs, 5 * 86400000 - 60000, 'a minute later by the iPad is a minute later by the shop');
    till({ state: 'active', valid_until: end, never_expires: false }, SERVER_NOW + 7 * 86400000, function (ahead) {
      assert.strictEqual(ahead.licenseDetails().remainingMs, 5 * 86400000, 'a week ahead');
      assert.strictEqual(ahead.licenseDetails().ok, true, 'and not wrongly expired');
      done();
    });
  });
});

test('as time passes the time left goes down second by second', function (done) {
  var end = new Date(SERVER_NOW + 100000).toISOString().replace('.000Z', 'Z');
  till({ state: 'active', valid_until: end, never_expires: false }, SERVER_NOW, function (core, clock) {
    assert.strictEqual(core.licenseDetails().remainingMs, 100000);
    clock.now += 1000;
    assert.strictEqual(core.licenseDetails().remainingMs, 99000);
    clock.now += 98000;
    assert.strictEqual(core.licenseDetails().remainingMs, 1000);
    clock.now += 2000;
    assert.strictEqual(core.licenseDetails().remainingMs, -1000, 'past the end it is negative (the page shows 00 and Expired)');
    assert.strictEqual(core.licenseDetails().ok, false);
    assert.strictEqual(core.licenseDetails().state, 'expired');
    done();
  });
});

test('an expired, a revoked and an unchecked licence are told apart', function (done) {
  till({ state: 'active', valid_until: '2026-11-01T00:00:00Z', never_expires: false }, SERVER_NOW, function (expired) {
    assert.strictEqual(expired.licenseDetails().state, 'expired');
    assert.ok(expired.licenseDetails().remainingMs < 0);
    till({ state: 'revoked', valid_until: null, never_expires: false }, SERVER_NOW, function (revoked) {
      assert.strictEqual(revoked.licenseDetails().state, 'revoked');
      assert.strictEqual(revoked.licenseDetails().ok, false);
      till(null, SERVER_NOW, function (unknown) {
        assert.strictEqual(unknown.licenseDetails().state, 'unknown');
        assert.strictEqual(unknown.licenseDetails().remainingMs, null);
        assert.strictEqual(unknown.licenseDetails().validUntil, null);
        done();
      });
    });
  });
});

var failed = 0;
var index = 0;
(function next() {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite license tests passed: ' + tests.length + ' tests.');
    return;
  }
  var t = tests[index++];
  var finished = false;
  var timer = setTimeout(function () { if (!finished) { finished = true; failed++; console.error('FAIL ' + t.name + '\n  timed out'); next(); } }, 5000);
  try {
    t.fn(function () { if (!finished) { finished = true; clearTimeout(timer); next(); } });
  } catch (error) {
    if (!finished) { finished = true; clearTimeout(timer); failed++; console.error('FAIL ' + t.name + '\n  ' + (error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n  ') : error)); next(); }
  }
}());
process.on('uncaughtException', function (error) {
  console.error('FAIL (uncaught): ' + (error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n  ') : error));
  process.exit(1);
});
