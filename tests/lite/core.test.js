/*
 * Tests of the Lite till's logic (lite/lite-core.js) with a scripted fake server and storage.
 * Logins are checked with REAL bcrypt hashes made by the app's own library (fixtures/bcrypt_fixtures.json)
 * and the real bcryptjs the page ships (lite/bcrypt.min.js).
 *
 * Run: node tests/lite/core.test.js
 */
'use strict';

var assert = require('assert');
var path = require('path');
var Core = require('../../lite/lite-core.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var BASE = 'https://sync.test/index.php';
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---- fakes --------------------------------------------------------------------------------------------------
function fakeStorage() {
  var data = {};
  return {
    data: data,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}

/** routes: { 'POST register_device': function (req, body) -> {status, body} | 'offline' } */
function fakeServer(routes) {
  var calls = [];
  function http(request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    var body = request.body ? JSON.parse(request.body) : null;
    calls.push({ action: action, method: request.method, headers: request.headers, body: body });
    var handler = routes[request.method + ' ' + action];
    var result = handler ? handler(request, body, calls.length) : { status: 404, body: { success: false, message: 'No such route.' } };
    setImmediate(function () {
      if (result === 'offline') {
        cb(new Error('network down'));
      } else {
        cb(null, { status: result.status, text: JSON.stringify(result.body) });
      }
    });
  }
  http.calls = calls;
  return http;
}

var NOW = Date.UTC(2026, 10, 8, 10, 0, 0);
var USER_HASH = fixtures[0].hash; // 'Passw0rd!'
function catalogBody(overrides) {
  var body = {
    success: true, shop_id: 7, device_id: 'lite-x', server_time: '2026-11-08T10:00:00Z',
    license: { state: 'active', valid_until: '2027-11-08T00:00:00Z', never_expires: false, checked_at: 1 },
    cursor: 99,
    business: { businessName: 'Mama Mboga', currency: 'KES', address: null, phone: null, receiptFooter: null, paperWidthMm: 58 },
    categories: [{ id: 'c1', name: 'Drinks', status: 'active' }, { id: 'c2', name: 'Food', status: 'active' }],
    products: [
      { id: 'p1', sku: 'SKU-1', name: 'Soda 500ml', barcode: '6001', categoryId: 'c1', retailPriceCents: 6000, wholesalePriceCents: 5000, costPriceCents: 4000, reorderLevel: 5, status: 'active', stockQty: 24 },
      { id: 'p2', sku: 'SKU-2', name: 'Bread', barcode: null, categoryId: 'c2', retailPriceCents: 7500, wholesalePriceCents: 7000, costPriceCents: 6000, reorderLevel: 2, status: 'active', stockQty: 3 },
      { id: 'p3', sku: 'OLD-9', name: 'Discontinued', barcode: '999', categoryId: 'c2', retailPriceCents: 100, wholesalePriceCents: 100, costPriceCents: 50, reorderLevel: 0, status: 'inactive', stockQty: 0 }
    ],
    users: [
      { id: 'u1', roleId: '00000000-0000-4000-8000-000000000001', name: 'Owner', username: 'owner', passwordHash: USER_HASH, status: 'active' },
      { id: 'u2', roleId: '00000000-0000-4000-8000-000000000003', name: 'Wanjiru', username: 'wanjiru', passwordHash: fixtures[4].hash, status: 'active' },
      { id: 'u3', roleId: '00000000-0000-4000-8000-000000000003', name: 'Gone', username: 'gone', passwordHash: USER_HASH, status: 'disabled' }
    ],
    roles: []
  };
  for (var key in (overrides || {})) { body[key] = overrides[key]; }
  return body;
}

function happyRoutes(extra) {
  var routes = {
    'POST register_device': function () { return { status: 201, body: { success: true, api_key: 'key-abc' } }; },
    'POST join_shop': function () { return { status: 200, body: { success: true } }; },
    'GET lite_catalog': function () { return { status: 200, body: catalogBody() }; }
  };
  for (var k in (extra || {})) { routes[k] = extra[k]; }
  return routes;
}

function make(routes, optionsExtra) {
  var storage = (optionsExtra && optionsExtra.storage) || fakeStorage();
  var clock = { now: NOW };
  var http = fakeServer(routes);
  var core = Core.create({
    baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt,
    now: function () { return clock.now; }, randomHex: function (n) { var s = ''; while (s.length < n * 2) { s += 'ab12'; } return s.slice(0, n * 2); }
  });
  return { core: core, http: http, storage: storage, clock: clock, calls: http.calls };
}

function joined(routes) {
  return function (done) {
    var t = make(happyRoutes(routes));
    t.core.join('INVITE1', 'Till 1', function (error) { assert.ifError(error); done(t); });
  };
}

// ---- joining -------------------------------------------------------------------------------------------------
test('joining registers a lite device, joins with the invite, then loads the catalog', function (done) {
  var t = make(happyRoutes());
  t.core.join(' INV ITE1 ', 'Till 1', function (error, status) {
    assert.ifError(error);
    assert.deepStrictEqual(t.calls.map(function (c) { return c.action; }), ['register_device', 'join_shop', 'lite_catalog']);
    var reg = t.calls[0].body;
    assert.strictEqual(reg.channel, 'lite');
    assert.ok(/^lite-/.test(reg.device_id) && reg.device_id.length <= 64, 'device id');
    assert.strictEqual(reg.registration_secret.length, 32);
    assert.strictEqual(reg.device_label, 'Till 1');
    assert.strictEqual(t.calls[0].headers.Authorization, undefined, 'registering carries no key');
    assert.strictEqual(t.calls[1].headers.Authorization, 'Bearer key-abc');
    assert.strictEqual(t.calls[1].body.invite_code, 'INVITE1', 'spaces in the code are ignored');
    assert.strictEqual(status.joined, true);
    assert.strictEqual(status.shopName, 'Mama Mboga');
    assert.strictEqual(status.productCount, 3);
    done();
  });
});

test('a wrong invite code is reported, and trying again reuses the same device and key', function (done) {
  var attempts = 0;
  var t = make(happyRoutes({ 'POST join_shop': function () { attempts += 1; return attempts === 1 ? { status: 422, body: { success: false, message: 'That invite code is invalid or has expired.' } } : { status: 200, body: { success: true } }; } }));
  t.core.join('BAD', 'Till 1', function (error) {
    assert.strictEqual(error.message, 'That invite code is invalid or has expired.');
    var firstId = t.calls[0].body.device_id;
    t.core.join('GOOD', 'Till 1', function (error2) {
      assert.ifError(error2);
      var registers = t.calls.filter(function (c) { return c.action === 'register_device'; });
      assert.strictEqual(registers.length, 1, 'must not register a second device');
      assert.strictEqual(t.calls[t.calls.length - 2].headers.Authorization, 'Bearer key-abc');
      assert.strictEqual(firstId, registers[0].body.device_id);
      done();
    });
  });
});

test('an empty invite code is refused without touching the network', function (done) {
  var t = make(happyRoutes());
  t.core.join('   ', 'x', function (error) {
    assert.strictEqual(error.code, 'input');
    assert.strictEqual(t.calls.length, 0);
    done();
  });
});

test('no internet while joining gives a plain message, and joining works once it is back', function (done) {
  var online = false;
  var t = make(happyRoutes({ 'POST register_device': function () { return online ? { status: 201, body: { success: true, api_key: 'k' } } : 'offline'; } }));
  t.core.join('INV', 'x', function (error) {
    assert.strictEqual(error.code, 'offline');
    assert.ok(/internet/i.test(error.message));
    online = true;
    t.core.join('INV', 'x', function (error2) { assert.ifError(error2); done(); });
  });
});

test('if the server no longer knows the key, the device starts over clean', function (done) {
  var t = make(happyRoutes({ 'POST join_shop': function () { return { status: 401, body: { success: false, message: 'Invalid or missing API key.' } }; } }));
  t.core.join('INV', 'x', function (error) {
    assert.strictEqual(error.code, 'unauthorized');
    assert.strictEqual(t.core.getStatus().hasDevice, false);
    done();
  });
});

test('everything survives a reload: the device and catalog come back from storage', function (done) {
  var t = make(happyRoutes());
  t.core.join('INV', 'Till 1', function (error) {
    assert.ifError(error);
    var again = Core.create({ baseUrl: BASE, http: function () { throw new Error('no network needed'); }, storage: t.storage, bcrypt: bcrypt, now: function () { return NOW; } });
    var status = again.getStatus();
    assert.ok(status.joined && status.hasCatalog && status.shopName === 'Mama Mboga');
    assert.strictEqual(again.searchProducts('soda').length, 1, 'works offline from the saved catalog');
    done();
  });
});

// ---- refreshing ----------------------------------------------------------------------------------------------
test('a revoked device is told so, and the saved catalog is kept', function (done) {
  joined({})(function (t) {
    t.calls.length = 0;
    var routes = { 'GET lite_catalog': function () { return { status: 403, body: { success: false, message: 'This device has been disabled.' } }; } };
    var core2 = Core.create({ baseUrl: BASE, http: fakeServer(routes), storage: t.storage, bcrypt: bcrypt, now: function () { return NOW; } });
    core2.refresh(function (error) {
      assert.strictEqual(error.code, 'forbidden');
      assert.ok(/no longer allowed/.test(error.message));
      assert.strictEqual(core2.getStatus().revoked, true);
      assert.strictEqual(core2.getStatus().hasCatalog, true);
      done();
    });
  });
});

test('a refresh with no internet keeps the saved catalog', function (done) {
  joined({})(function (t) {
    var core2 = Core.create({ baseUrl: BASE, http: fakeServer({ 'GET lite_catalog': function () { return 'offline'; } }), storage: t.storage, bcrypt: bcrypt, now: function () { return NOW; } });
    core2.refresh(function (error) {
      assert.strictEqual(error.code, 'offline');
      assert.strictEqual(core2.getStatus().productCount, 3);
      done();
    });
  });
});

// ---- licence, by the server's clock ----------------------------------------------------------------------------
test('the licence is judged by the server clock, not a wrong iPad clock', function (done) {
  function licenceWith(validUntil, deviceClock, check) {
    var t = make(happyRoutes({ 'GET lite_catalog': function () { return { status: 200, body: catalogBody({ license: { state: 'active', valid_until: validUntil, never_expires: false } }) }; } }));
    t.clock.now = deviceClock;
    t.core.join('INV', 'x', function (error) { assert.ifError(error); check(t.core.getStatus().license); });
  }
  // The server says it is 2026-11-08. The licence ends tomorrow. An iPad clock set far into the FUTURE must not expire it...
  licenceWith('2026-11-09T00:00:00Z', Date.UTC(2030, 0, 1), function (ahead) {
    assert.strictEqual(ahead.ok, true, 'iPad clock in 2030: ' + JSON.stringify(ahead));
    // ...and an iPad clock set far into the PAST must not keep an already ended licence alive.
    licenceWith('2026-11-07T00:00:00Z', Date.UTC(2019, 0, 1), function (behind) {
      assert.strictEqual(behind.state, 'expired', 'iPad clock in 2019: ' + JSON.stringify(behind));
      assert.strictEqual(behind.ok, false);
      done();
    });
  });
});

test('an expired or revoked licence is reported as not OK', function (done) {
  var expired = make(happyRoutes({ 'GET lite_catalog': function () { return { status: 200, body: catalogBody({ license: { state: 'active', valid_until: '2026-01-01T00:00:00Z', never_expires: false } }) }; } }));
  expired.core.join('INV', 'x', function () {
    assert.strictEqual(expired.core.getStatus().license.state, 'expired');
    assert.strictEqual(expired.core.getStatus().license.ok, false);
    var revoked = make(happyRoutes({ 'GET lite_catalog': function () { return { status: 200, body: catalogBody({ license: { state: 'revoked', valid_until: null, never_expires: false } }) }; } }));
    revoked.core.join('INV', 'x', function () {
      assert.strictEqual(revoked.core.getStatus().license.ok, false);
      var lifetime = make(happyRoutes({ 'GET lite_catalog': function () { return { status: 200, body: catalogBody({ license: { state: 'active', valid_until: null, never_expires: true } }) }; } }));
      lifetime.core.join('INV', 'x', function () {
        assert.strictEqual(lifetime.core.getStatus().license.ok, true);
        done();
      });
    });
  });
});

// ---- logging in -----------------------------------------------------------------------------------------------
test('every password the app can create is accepted by the page (real app hashes)', function (done) {
  var cases = fixtures.filter(function (c) { return c.password !== ''; });
  joined({})(function (t) {
    // Each fixture hash becomes the password hash of the 'owner' user in turn.
    var index = 0;
    (function next() {
      if (index >= cases.length) { return done(); }
      var c = cases[index++];
      var routes = { 'GET lite_catalog': function () { var b = catalogBody(); b.users[0].passwordHash = c.hash; return { status: 200, body: b }; } };
      var core2 = Core.create({ baseUrl: BASE, http: fakeServer(routes), storage: t.storage, bcrypt: bcrypt, now: function () { return NOW; } });
      core2.refresh(function (error) {
        assert.ifError(error);
        core2.login('owner', c.password, function (loginError, user) {
          assert.ifError(loginError);
          assert.strictEqual(user.name, 'Owner');
          core2.login('owner', c.password + 'x', function (wrong) {
            assert.strictEqual(wrong && wrong.code, 'credentials', 'a wrong password must fail for ' + JSON.stringify(c.password));
            next();
          });
        });
      });
    }());
  });
});

test('login: right password, wrong password, unknown user, disabled user, empty fields', function (done) {
  joined({})(function (t) {
    t.core.login(' owner ', 'Passw0rd!', function (error, user) {
      assert.ifError(error);
      assert.deepStrictEqual([user.id, user.username, user.roleName], ['u1', 'owner', 'Admin']);
      assert.strictEqual(t.core.currentUser().name, 'Owner');
      t.core.logout();
      assert.strictEqual(t.core.currentUser(), null);
      t.core.login('owner', 'nope', function (e1) {
        assert.strictEqual(e1.code, 'credentials');
        t.core.login('nobody', 'Passw0rd!', function (e2) {
          assert.strictEqual(e2.code, 'credentials');
          t.core.login('gone', 'Passw0rd!', function (e3) {
            assert.strictEqual(e3.code, 'disabled');
            t.core.login('', 'x', function (e4) {
              assert.strictEqual(e4.code, 'input');
              t.core.login('owner', '', function (e5) {
                assert.strictEqual(e5.code, 'input');
                done();
              });
            });
          });
        });
      });
    });
  });
});

test('login: a password is not trimmed, a username is', function (done) {
  joined({})(function (t) {
    t.core.login('owner', ' Passw0rd! ', function (error) {
      assert.strictEqual(error.code, 'credentials');
      done();
    });
  });
});

test('login is locked for 30 seconds after 5 wrong passwords, then works again', function (done) {
  joined({})(function (t) {
    var n = 0;
    (function wrong() {
      if (n === 5) { return afterFive(); }
      n += 1;
      t.core.login('owner', 'bad' + n, function (error) { assert.ok(error); wrong(); });
    }());
    function afterFive() {
      t.core.login('owner', 'Passw0rd!', function (error) {
        assert.strictEqual(error.code, 'locked', 'even the right password is refused while locked');
        t.clock.now += 31 * 1000;
        t.core.login('owner', 'Passw0rd!', function (error2, user) {
          assert.ifError(error2);
          assert.strictEqual(user.id, 'u1');
          done();
        });
      });
    }
  });
});

test('the lock-out cannot be escaped by reloading the page', function (done) {
  joined({})(function (t) {
    var n = 0;
    (function wrong() {
      if (n === 5) { return reload(); }
      n += 1;
      t.core.login('owner', 'bad', function () { wrong(); });
    }());
    function reload() {
      var again = Core.create({ baseUrl: BASE, http: fakeServer({}), storage: t.storage, bcrypt: bcrypt, now: function () { return NOW; } });
      again.login('owner', 'Passw0rd!', function (error) {
        assert.strictEqual(error.code, 'locked');
        done();
      });
    }
  });
});

// ---- the catalog ----------------------------------------------------------------------------------------------
test('product search: by name, code and barcode, by category; inactive products hidden', function (done) {
  joined({})(function (t) {
    var names = function (list) { return list.map(function (p) { return p.name; }); };
    assert.deepStrictEqual(names(t.core.searchProducts('')), ['Soda 500ml', 'Bread']);
    assert.deepStrictEqual(names(t.core.searchProducts('SODA')), ['Soda 500ml']);
    assert.deepStrictEqual(names(t.core.searchProducts('sku-2')), ['Bread']);
    assert.deepStrictEqual(names(t.core.searchProducts('6001')), ['Soda 500ml']);
    assert.deepStrictEqual(names(t.core.searchProducts('', 'c2')), ['Bread']);
    assert.deepStrictEqual(names(t.core.searchProducts('disc')), [], 'inactive hidden');
    assert.deepStrictEqual(names(t.core.searchProducts('disc', null, true)), ['Discontinued']);
    assert.strictEqual(t.core.categoryName('c2'), 'Food');
    done();
  });
});

test('forgetting the device clears it', function (done) {
  joined({})(function (t) {
    t.core.forget();
    assert.strictEqual(t.core.getStatus().hasDevice, false);
    assert.strictEqual(t.core.getStatus().productCount, 0);
    assert.strictEqual(Object.keys(t.storage.data).length, 0);
    done();
  });
});

test('if storage is unavailable (private browsing) it keeps working and says so', function (done) {
  var broken = { getItem: function () { return null; }, setItem: function () { throw new Error('QuotaExceededError'); }, removeItem: function () {} };
  var t = make(happyRoutes(), { storage: broken });
  t.core.join('INV', 'x', function (error, status) {
    assert.ifError(error);
    assert.strictEqual(status.storageOk, false);
    assert.strictEqual(t.core.getStatus().productCount, 3);
    done();
  });
});

test('money formatting', function (done) {
  assert.strictEqual(Core.formatCents(125050), '1,250.50');
  assert.strictEqual(Core.formatCents(5), '0.05');
  assert.strictEqual(Core.formatCents(0), '0.00');
  assert.strictEqual(Core.formatCents(100000000), '1,000,000.00');
  assert.strictEqual(Core.formatCents(-250), '-2.50');
  done();
});

// ---- run ------------------------------------------------------------------------------------------------------
var failed = 0;
(function run(index) {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite core tests passed: ' + tests.length + ' tests.');
    return;
  }
  var t = tests[index];
  var finished = false;
  var timer = setTimeout(function () { if (!finished) { finished = true; failed++; console.error('FAIL (timeout) ' + t.name); run(index + 1); } }, 60000);
  try {
    t.fn(function () { if (finished) { return; } finished = true; clearTimeout(timer); run(index + 1); });
  } catch (error) {
    finished = true; clearTimeout(timer); failed++;
    console.error('FAIL ' + t.name + '\n  ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n  ') : error));
    run(index + 1);
  }
}(0));

process.on('uncaughtException', function (error) {
  console.error('FAIL (uncaught): ' + (error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n  ') : error));
  process.exit(1);
});
