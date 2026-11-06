/*
 * End to end: the real Lite till logic against a real platform server (PHP + MySQL), no fakes on the wire.
 * A "main device" is set up with a shop (cashier with a bcrypt hash made by the app's own library, products,
 * stock), then a Lite device joins it with a real invite code, loads the catalog and logs in.
 *
 * Run (needs a platform server, see tests/lite/README.md): LITE_API=http://127.0.0.1:8080/index.php node tests/lite/integration.js
 */
'use strict';

var assert = require('assert');
var http = require('http');
var https = require('https');
var urlModule = require('url');
var Core = require('../../lite/lite-core.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var API = process.env.LITE_API;
if (!API) {
  console.log('Lite integration test skipped: set LITE_API to a platform server.');
  process.exit(0);
}

function transport(request, cb) {
  var parsed = urlModule.parse(request.url);
  var lib = parsed.protocol === 'https:' ? https : http;
  var req = lib.request({ method: request.method, hostname: parsed.hostname, port: parsed.port, path: parsed.path, headers: request.headers }, function (res) {
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () { cb(null, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }); });
  });
  req.on('error', function (e) { cb(e); });
  if (request.body) { req.write(request.body); }
  req.end();
}

function api(method, action, body, key, cb) {
  var headers = { 'Accept': 'application/json' };
  if (body) { headers['Content-Type'] = 'application/json'; }
  if (key) { headers.Authorization = 'Bearer ' + key; }
  transport({ method: method, url: API + '?action=' + action, headers: headers, body: body ? JSON.stringify(body) : null }, function (error, response) {
    if (error) { throw error; }
    cb(response.status, JSON.parse(response.text));
  });
}

function memoryStorage() {
  var data = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}

function newLite() {
  return Core.create({ baseUrl: API, http: transport, storage: memoryStorage(), bcrypt: bcrypt });
}

var uuid = (function () { var n = 0; return function () { n += 1; var h = ('000000000000' + n.toString(16)).slice(-12); return '00000000-0000-4000-8000-' + h; }; }());
var stamp = new Date().toISOString().replace('Z', '000Z').replace(/\.(\d{3})\d*Z$/, '.$1000Z');

var nativeId = 'lite-it-main-' + Date.now();
var revision = 0;
var catId = uuid(), sodaId = uuid(), breadId = uuid(), ownerId = uuid(), staffId = uuid();

function row(extra) {
  revision += 1;
  var base = { createdAt: stamp, updatedAt: stamp, deletedAt: null, localRev: revision, createdByDeviceId: nativeId, syncState: 'local_only' };
  for (var k in extra) { base[k] = extra[k]; }
  return base;
}
function change(table, payload) { return { table_name: table, row_id: payload.id, local_rev: payload.localRev, updated_at: payload.updatedAt, payload: payload }; }

api('POST', 'register_device', { device_id: nativeId, device_label: 'Main PC', registration_secret: 'secret-' + nativeId }, null, function (status, registered) {
  assert.strictEqual(status, 201, JSON.stringify(registered));
  var mainKey = registered.api_key;
  var changes = [
    change('categories', row({ id: catId, name: 'Drinks', status: 'active' })),
    change('products', row({ id: sodaId, sku: 'SKU-1', name: 'Soda 500ml', categoryId: catId, imagePath: null, barcode: '6001', retailPriceCents: 6000, wholesalePriceCents: 5000, costPriceCents: 4000, stockQty: 999, reorderLevel: 5, status: 'active' })),
    change('products', row({ id: breadId, sku: 'SKU-2', name: 'Bread', categoryId: catId, imagePath: null, barcode: null, retailPriceCents: 7500, wholesalePriceCents: 7000, costPriceCents: 6000, stockQty: 999, reorderLevel: 2, status: 'active' })),
    change('stock_movements', row({ id: uuid(), productId: sodaId, userId: null, movementType: 'purchase', quantity: 24, note: null })),
    change('stock_movements', row({ id: uuid(), productId: breadId, userId: null, movementType: 'purchase', quantity: 3, note: null })),
    change('users', row({ id: ownerId, roleId: '00000000-0000-4000-8000-000000000001', name: 'Owner', username: 'owner', email: null, passwordHash: fixtures[0].hash, phone: null, status: 'active' })),
    change('users', row({ id: staffId, roleId: '00000000-0000-4000-8000-000000000003', name: 'Wanjiru', username: 'wanjiru', email: null, passwordHash: fixtures[4].hash, phone: null, status: 'disabled' })),
    change('business_settings', row({ id: uuid(), businessName: 'Mama Mboga', address: null, phone: null, receiptFooter: null, currency: 'KES', paperWidthMm: 58 }))
  ];
  api('POST', 'push_changes', { changes: changes }, mainKey, function (pushStatus, pushed) {
    assert.strictEqual(pushStatus, 200, JSON.stringify(pushed));
    api('POST', 'generate_invite', {}, mainKey, function (inviteStatus, invite) {
      assert.strictEqual(inviteStatus, 200, JSON.stringify(invite));
      runLite(invite.code);
    });
  });
});

function runLite(code) {
  var lite = newLite();
  lite.join(code, 'Test iPad', function (error, status) {
    assert.ifError(error);
    assert.strictEqual(status.joined, true);
    assert.strictEqual(status.shopName, 'Mama Mboga');
    assert.strictEqual(status.productCount, 2);
    assert.strictEqual(status.license.state === 'unknown' || status.license.ok, true);
    var found = lite.searchProducts('soda');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].stockQty, 24, 'stock is the sum of the movements, not the product\'s own stockQty');
    assert.strictEqual(found[0].retailPriceCents, 6000);
    assert.strictEqual(lite.categoryName(catId), 'Drinks');
    lite.login('owner', 'Passw0rd!', function (loginError, user) {
      assert.ifError(loginError);
      assert.strictEqual(user.roleName, 'Admin');
      lite.login('owner', 'wrong', function (wrong) {
        assert.strictEqual(wrong.code, 'credentials');
        lite.login('wanjiru', 'Wanjiru@2026#', function (disabled) {
          assert.strictEqual(disabled.code, 'disabled');
          // The invite is single use: a second iPad with the same code is turned away.
          newLite().join(code, 'Second iPad', function (secondError) {
            assert.ok(secondError, 'a used invite code must not work twice');
            console.log('Lite integration test passed: joined with a real invite, catalog (' + status.productCount + ' products, stock summed), login with an app-made bcrypt hash, used invite refused.');
          });
        });
      });
    });
  });
}
