/*
 * Quick sign in on the Lite till: Face ID, Touch ID, a fingerprint or the device's passcode (a WebAuthn platform passkey).
 * A pretend authenticator built on Node's real WebCrypto makes real P-256 passkeys and signs real answers, so the core's
 * checks (the passkey, the site, the page, the question, the person verified, the signature) are tested for real, and so is
 * every way an answer can be wrong.
 *
 * Run: node tests/lite/quick.test.js
 */
'use strict';

process.env.TZ = 'Africa/Nairobi';

var assert = require('assert');
var nodeCrypto = require('crypto');
var subtle = nodeCrypto.webcrypto.subtle;
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var BASE = 'https://sync.test/index.php';
var PASSWORD = fixtures[0].password;
var OWNER = '33333333-3333-4333-8333-333333333333';
var CASHIER = '55555555-5555-4555-8555-555555555555';
var MANAGER = '44444444-4444-4444-8444-444444444444';
var RP = 'nexapos.cc';
var ORIGIN = 'https://nexapos.cc';
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
function person(id, role, name, status) {
  return { id: id, roleId: '00000000-0000-4000-8000-00000000000' + role, name: name, username: name.toLowerCase(), passwordHash: fixtures[0].hash, status: status || 'active' };
}
var catalogUsers;
function catalogBody() {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-11-19T10:00:00Z', cursor: 5,
    license: { state: 'active', valid_until: null, never_expires: true },
    business: { businessName: 'Mama Mboga', currency: 'KES' },
    categories: [], products: [], users: catalogUsers, roles: []
  };
}

function bytes(buffer) { return new Uint8Array(buffer); }
function concat(a, b) { var out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; }
function b64url(u8) { return Buffer.from(u8).toString('base64url'); }

/** r||s (what WebCrypto signs) -> ASN.1 DER (what a device sends). */
function rawToDer(raw) {
  function integer(part) {
    var i = 0;
    while (i < part.length - 1 && part[i] === 0) { i++; }
    var value = Array.prototype.slice.call(part, i);
    if (value[0] & 0x80) { value.unshift(0); }
    return [0x02, value.length].concat(value);
  }
  var body = integer(raw.subarray(0, 32)).concat(integer(raw.subarray(32)));
  return new Uint8Array([0x30, body.length].concat(body));
}

/**
 * The device: makes passkeys, answers sign-in questions. [tweak] changes what the next answer says, to test refusals.
 * supported: whether the browser has passkeys at all; givesPublicKey: false is a browser without getPublicKey (iOS 14/15).
 */
function fakeAuthenticator(settings) {
  settings = settings || {};
  var device = {
    supportedFlag: settings.supported !== false,
    givesPublicKey: settings.givesPublicKey !== false,
    cancel: false,
    keys: [],
    created: [],
    asked: [],
    tweak: null
  };
  var passkeys = {
    rpId: RP,
    origin: ORIGIN,
    supported: function () { return device.supportedFlag; },
    randomBytes: function (n) { return new Uint8Array(nodeCrypto.randomBytes(n)); },
    create: function (options, cb) {
      device.created.push(options);
      if (device.cancel) { setImmediate(function () { cb({ name: 'NotAllowedError' }); }); return; }
      subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']).then(function (pair) {
        return subtle.exportKey('spki', pair.publicKey).then(function (spki) {
          var id = new Uint8Array(nodeCrypto.randomBytes(16));
          device.keys.push({ id: id, privateKey: pair.privateKey, rpId: options.rp.id });
          cb(null, { rawId: id, publicKey: device.givesPublicKey ? bytes(spki) : null, algorithm: device.givesPublicKey ? -7 : null });
        });
      }).catch(function (e) { cb(e); });
    },
    get: function (options, cb) {
      device.asked.push(options);
      if (device.cancel) { setImmediate(function () { cb({ name: 'NotAllowedError' }); }); return; }
      var wanted = options.allowCredentials[0].id;
      var key = null;
      device.keys.forEach(function (k) { if (Buffer.compare(Buffer.from(k.id), Buffer.from(wanted)) === 0) { key = k; } });
      if (!key) { setImmediate(function () { cb({ name: 'NotAllowedError' }); }); return; }
      var t = device.tweak || {};
      device.tweak = null;
      var signer = t.otherKey ? null : key.privateKey;
      var client = { type: t.type || 'webauthn.get', challenge: t.challenge || b64url(options.challenge), origin: t.origin || ORIGIN, crossOrigin: false };
      var clientJson = new Uint8Array(Buffer.from(JSON.stringify(client), 'utf8'));
      var flags = t.flags === undefined ? 0x05 : t.flags;
      subtle.digest('SHA-256', Buffer.from(t.rpId || key.rpId, 'ascii')).then(function (rpHash) {
        var authData = concat(bytes(rpHash), new Uint8Array([flags, 0, 0, 0, 1]));
        return subtle.digest('SHA-256', clientJson).then(function (clientHash) {
          var signed = concat(authData, bytes(clientHash));
          var keyPromise = signer ? Promise.resolve(signer) : subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']).then(function (p) { return p.privateKey; });
          return keyPromise.then(function (k) {
            return subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, signed).then(function (raw) {
              var der = t.signatureDer || rawToDer(bytes(raw));
              if (t.flipSignature) { der = new Uint8Array(der); der[der.length - 1] ^= 1; }
              cb(null, { rawId: t.rawId || key.id, authenticatorData: authData, clientDataJSON: clientJson, signature: der });
            });
          });
        });
      }).catch(function (e) { cb(e); });
    },
    sha256: function (data, cb) { subtle.digest('SHA-256', data).then(function (h) { cb(null, bytes(h)); }, function (e) { cb(e); }); },
    verify: function (spki, signed, raw, cb) {
      subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).then(function (k) {
        return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, raw, signed);
      }).then(function (ok) { cb(null, ok); }, function (e) { cb(e); });
    }
  };
  device.passkeys = passkeys;
  return device;
}

/** A joined till; [user] logged in (null: nobody). */
function till(device, user, done, storage) {
  catalogUsers = [person(OWNER, 1, 'Owner'), person(MANAGER, 2, 'Manager'), person(CASHIER, 3, 'Cashier')];
  storage = storage || fakeStorage();
  var http = function (request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    var result = { status: 200, body: { success: true } };
    if (action === 'register_device') { result = { status: 201, body: { success: true, api_key: 'key-1' } }; }
    if (action === 'lite_catalog') { result = { status: 200, body: catalogBody() }; }
    setImmediate(function () { cb(null, { status: result.status, text: JSON.stringify(result.body) }); });
  };
  var core = Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, now: function () { return Date.parse('2026-11-19T10:00:00Z'); }, randomHex: Core.randomHex, passkeys: device ? device.passkeys : undefined });
  function ready() {
    if (!user) { done(core, storage); return; }
    core.login(user, PASSWORD, function (error) { assert.ifError(error); done(core, storage); });
  }
  if (storage.getItem(Core.STORE_KEY)) { ready(); return; }
  core.join('INV', 'Till', function (error) { assert.ifError(error); ready(); });
}

/** Turns quick sign in on for [user], then logs out: ready for quickLogin. */
function setUp(device, user, done) {
  till(device, user, function (core, storage) {
    core.setUpQuickSignIn(function (error) {
      assert.ifError(error);
      core.logout();
      done(core, storage);
    });
  });
}

// ---- what the browser can do ---------------------------------------------------------------------------------------------------
test('a browser without passkeys (an old iPad) is not offered quick sign in', function (done) {
  var device = fakeAuthenticator({ supported: false });
  till(device, 'owner', function (core) {
    assert.deepStrictEqual(core.quickSignInStatus(), { supported: false, setUpFor: null, mine: false });
    core.setUpQuickSignIn(function (error) {
      assert.strictEqual(error.code, 'unsupported');
      assert.strictEqual(device.created.length, 0);
      core.quickLogin(function (error2) {
        assert.strictEqual(error2.code, 'not_set_up');
        done();
      });
    });
  });
});

test('no passkeys given at all (the tests of other parts, an old page) is the same as not supported', function (done) {
  till(null, 'owner', function (core) {
    assert.strictEqual(core.quickSignInStatus().supported, false);
    done();
  });
});

// ---- turning it on ---------------------------------------------------------------------------------------------------------------
test('turning it on asks the device for a platform passkey that needs the person, ES256, for this site', function (done) {
  var device = fakeAuthenticator();
  till(device, 'cashier', function (core, storage) {
    core.setUpQuickSignIn(function (error) {
      assert.ifError(error);
      var asked = device.created[0];
      assert.strictEqual(asked.rp.id, RP);
      assert.deepStrictEqual(asked.pubKeyCredParams, [{ type: 'public-key', alg: -7 }]);
      assert.deepStrictEqual(asked.authenticatorSelection, { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' });
      assert.strictEqual(asked.attestation, 'none');
      assert.strictEqual(asked.challenge.length, 32);
      assert.strictEqual(asked.user.id.length, 16);
      assert.deepStrictEqual(core.quickSignInStatus(), { supported: true, setUpFor: { id: CASHIER, name: 'Cashier' }, mine: true });
      var kept = JSON.parse(storage.data[Core.STORE_KEY]).quick;
      assert.deepStrictEqual(Object.keys(kept).sort(), ['credentialId', 'publicKey', 'rpId', 'userId']);
      assert.strictEqual(kept.userId, CASHIER);
      assert.strictEqual(kept.rpId, RP);
      assert.strictEqual(Buffer.from(kept.credentialId, 'base64url').length, 16);
      done();
    });
  });
});

test('it can only be turned on by someone logged in', function (done) {
  var device = fakeAuthenticator();
  till(device, null, function (core) {
    core.setUpQuickSignIn(function (error) {
      assert.deepStrictEqual([error.code, error.message], ['input', 'Log in first.']);
      assert.strictEqual(device.created.length, 0);
      done();
    });
  });
});

test('a browser that cannot hand over the public key (iOS 14 and 15) is told so, and nothing is kept', function (done) {
  var device = fakeAuthenticator({ givesPublicKey: false });
  till(device, 'owner', function (core, storage) {
    core.setUpQuickSignIn(function (error) {
      assert.strictEqual(error.code, 'unsupported');
      assert.ok(/iOS 16 or newer/.test(error.message), error.message);
      assert.strictEqual(core.quickSignInStatus().setUpFor, null);
      assert.ok(!JSON.parse(storage.data[Core.STORE_KEY]).quick);
      done();
    });
  });
});

test('cancelling the face / finger / passcode question turns nothing on', function (done) {
  var device = fakeAuthenticator();
  device.cancel = true;
  till(device, 'owner', function (core) {
    core.setUpQuickSignIn(function (error) {
      assert.strictEqual(error.code, 'cancelled');
      assert.strictEqual(core.quickSignInStatus().setUpFor, null);
      done();
    });
  });
});

test('a log out while the device was asking turns nothing on', function (done) {
  var device = fakeAuthenticator();
  till(device, 'owner', function (core) {
    core.setUpQuickSignIn(function (error) {
      assert.strictEqual(error.code, 'logged_out');
      assert.strictEqual(core.quickSignInStatus().setUpFor, null);
      done();
    });
    core.logout();
  });
});

// ---- signing in --------------------------------------------------------------------------------------------------------------------
test('quick sign in: the device checks the person, the till checks the answer, and that person is signed in', function (done) {
  var device = fakeAuthenticator();
  setUp(device, 'manager', function (core) {
    assert.strictEqual(core.currentUser(), null);
    assert.deepStrictEqual(core.quickSignInStatus(), { supported: true, setUpFor: { id: MANAGER, name: 'Manager' }, mine: false });
    core.quickLogin(function (error, session) {
      assert.ifError(error);
      assert.deepStrictEqual(session, { id: MANAGER, name: 'Manager', username: 'manager', roleId: '00000000-0000-4000-8000-000000000002', roleName: 'Manager' });
      assert.strictEqual(core.currentUser().id, MANAGER);
      var asked = device.asked[0];
      assert.strictEqual(asked.rpId, RP);
      assert.strictEqual(asked.userVerification, 'required');
      assert.strictEqual(asked.challenge.length, 32);
      assert.deepStrictEqual(asked.allowCredentials[0].transports, ['internal']);
      done();
    });
  });
});

test('every sign in asks a new question (an old answer cannot be used again)', function (done) {
  var device = fakeAuthenticator();
  setUp(device, 'owner', function (core) {
    core.quickLogin(function (error) {
      assert.ifError(error);
      core.logout();
      core.quickLogin(function (error2) {
        assert.ifError(error2);
        assert.notStrictEqual(b64url(device.asked[0].challenge), b64url(device.asked[1].challenge));
        done();
      });
    });
  });
});

test('it still works after the page is opened again (it is kept with the till)', function (done) {
  var device = fakeAuthenticator();
  setUp(device, 'owner', function (core, storage) {
    till(device, null, function (again) {
      assert.deepStrictEqual(again.quickSignInStatus().setUpFor, { id: OWNER, name: 'Owner' });
      again.quickLogin(function (error, session) {
        assert.ifError(error);
        assert.strictEqual(session.id, OWNER);
        done();
      });
    }, storage);
  });
});

test('set up earlier, then opened where passkeys do not work: refused plainly, never tried', function (done) {
  var device = fakeAuthenticator();
  setUp(device, 'owner', function (core, storage) {
    var unable = fakeAuthenticator({ supported: false });
    till(unable, null, function (again) {
      assert.strictEqual(again.quickSignInStatus().supported, false);
      assert.ok(again.quickSignInStatus().setUpFor, 'still remembered');
      again.quickLogin(function (error) {
        assert.strictEqual(error.code, 'unsupported');
        assert.strictEqual(unable.asked.length, 0, 'the device was not asked');
        assert.strictEqual(again.currentUser(), null);
        done();
      });
    }, storage);
  });
});

function refused(tweak, label) {
  test('a wrong answer is refused: ' + label, function (done) {
    var device = fakeAuthenticator();
    setUp(device, 'owner', function (core) {
      device.tweak = typeof tweak === 'function' ? tweak(device) : tweak;
      core.quickLogin(function (error, session) {
        assert.ok(error, 'not refused');
        assert.strictEqual(error.code, 'not_verified', error.message);
        assert.strictEqual(session, undefined);
        assert.strictEqual(core.currentUser(), null);
        done();
      });
    });
  });
}
refused({ challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'an answer to another question');
refused({ origin: 'https://evil.example' }, 'from another page');
refused({ type: 'webauthn.create' }, 'the wrong kind of answer');
refused({ flags: 0x01 }, 'the person was not verified (no face, finger or passcode)');
refused({ flags: 0x04 }, 'the person was not present');
refused({ rpId: 'evil.example' }, 'for another site');
refused({ flipSignature: true }, 'a signature that does not match');
refused({ otherKey: true }, 'signed by another key');
refused({ signatureDer: new Uint8Array([0x30, 0x02, 0x02, 0x00]) }, 'a signature that is not one');
refused(function () { return { rawId: new Uint8Array(16) }; }, 'another passkey');

test('cancelling at sign in signs nobody in', function (done) {
  var device = fakeAuthenticator();
  setUp(device, 'owner', function (core) {
    device.cancel = true;
    core.quickLogin(function (error) {
      assert.strictEqual(error.code, 'cancelled');
      assert.strictEqual(core.currentUser(), null);
      done();
    });
  });
});

test('a person switched off or gone from the shop is not signed in, whatever the device says', function (done) {
  var device = fakeAuthenticator();
  setUp(device, 'cashier', function (core, storage) {
    // the shop switches the cashier off
    catalogUsers[2].status = 'inactive';
    var state = JSON.parse(storage.data[Core.STORE_KEY]);
    state.catalog.users[2].status = 'inactive';
    storage.setItem(Core.STORE_KEY, JSON.stringify(state));
    var http = function (r, cb) { setImmediate(function () { cb(new Error('offline')); }); };
    var again = Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, now: function () { return 1; }, randomHex: Core.randomHex, passkeys: device.passkeys });
    again.quickLogin(function (error) {
      assert.deepStrictEqual([error.code, error.message], ['disabled', 'This account is not active. Ask the owner.']);
      state.catalog.users.splice(2, 1);
      storage.setItem(Core.STORE_KEY, JSON.stringify(state));
      var third = Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, now: function () { return 1; }, randomHex: Core.randomHex, passkeys: device.passkeys });
      assert.strictEqual(third.quickSignInStatus().setUpFor.name, 'someone no longer in the shop');
      third.quickLogin(function (error2) {
        assert.strictEqual(error2.code, 'disabled');
        assert.strictEqual(third.currentUser(), null);
        done();
      });
    });
  });
});

test('a successful quick sign in clears earlier wrong passwords', function (done) {
  var device = fakeAuthenticator();
  setUp(device, 'owner', function (core, storage) {
    core.login('owner', 'wrong', function (error) {
      assert.strictEqual(error.code, 'credentials');
      assert.strictEqual(JSON.parse(storage.data[Core.STORE_KEY]).failedLogins, 1);
      core.quickLogin(function (error2) {
        assert.ifError(error2);
        assert.strictEqual(JSON.parse(storage.data[Core.STORE_KEY]).failedLogins, 0);
        done();
      });
    });
  });
});

test('one question at a time', function (done) {
  var device = fakeAuthenticator();
  setUp(device, 'owner', function (core) {
    var first = null;
    core.quickLogin(function (error) { first = error; });
    core.quickLogin(function (error2) {
      assert.strictEqual(error2.code, 'busy');
      setTimeout(function () {
        assert.strictEqual(first, null);
        done();
      }, 200);
    });
  });
});

// ---- turning it off ----------------------------------------------------------------------------------------------------------------
test('turning it off: the person it is set up for, or an administrator - not another cashier', function (done) {
  var device = fakeAuthenticator();
  setUp(device, 'manager', function (core) {
    core.login('cashier', PASSWORD, function (error) {
      assert.ifError(error);
      assert.deepStrictEqual(core.turnOffQuickSignIn(), { ok: false, message: 'Only the person it is set up for, or an administrator, can turn it off.' });
      assert.ok(core.quickSignInStatus().setUpFor);
      core.logout();
      core.login('owner', PASSWORD, function (error2) {
        assert.ifError(error2);
        assert.deepStrictEqual(core.turnOffQuickSignIn(), { ok: true });
        assert.strictEqual(core.quickSignInStatus().setUpFor, null);
        core.logout();
        core.quickLogin(function (error3) {
          assert.strictEqual(error3.code, 'not_set_up');
          done();
        });
      });
    });
  });
});

test('the person it is set up for can turn it off', function (done) {
  var device = fakeAuthenticator();
  setUp(device, 'cashier', function (core) {
    core.quickLogin(function (error) {
      assert.ifError(error);
      assert.deepStrictEqual(core.turnOffQuickSignIn(), { ok: true });
      assert.strictEqual(core.quickSignInStatus().setUpFor, null);
      done();
    });
  });
});

test('disconnecting the iPad from the shop forgets it too', function (done) {
  var device = fakeAuthenticator();
  setUp(device, 'owner', function (core) {
    core.forget();
    assert.strictEqual(core.quickSignInStatus().setUpFor, null);
    done();
  });
});

// ---- the signature form ------------------------------------------------------------------------------------------------------------
test('a device\'s DER signature becomes the r||s the browser checks (leading zeros, short values)', function (done) {
  var cases = 0;
  (function next() {
    if (cases >= 40) { done(); return; }
    cases++;
    subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']).then(function (pair) {
      return subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, nodeCrypto.randomBytes(20));
    }).then(function (raw) {
      raw = bytes(raw);
      var back = Core.derToRawSignature(rawToDer(raw));
      assert.strictEqual(Buffer.compare(Buffer.from(back), Buffer.from(raw)), 0);
      next();
    }).catch(function (e) { throw e; });
  }());
});

test('things that are not DER signatures are refused', function () {
  [null, new Uint8Array(0), new Uint8Array([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]), new Uint8Array([0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]),
    new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01]), new Uint8Array([0x30, 0x06, 0x03, 0x01, 0x01, 0x02, 0x01, 0x01])].forEach(function (bad, i) {
    assert.strictEqual(Core.derToRawSignature(bad), null, 'case ' + i);
  });
  var tooLong = [0x30, 0x46, 0x02, 0x21].concat(new Array(33).fill(1)).concat([0x02, 0x21]).concat(new Array(33).fill(1));
  assert.strictEqual(Core.derToRawSignature(new Uint8Array(tooLong)), null, 'a 33-byte value that is not a padded 32-byte one');
});

var failed = 0;
var index = 0;
(function next() {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite quick sign in tests passed: ' + tests.length + ' tests.');
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
