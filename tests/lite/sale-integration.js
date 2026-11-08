/*
 * The decisive test: real sales rung up on the Lite page's code are sent to a REAL platform server (PHP + MySQL,
 * including the sync guard) and read back by a normal device. Every kind of sale must be accepted and a tampered
 * one refused with nothing stored.
 *
 * Run (needs a platform server, see tests/lite/README.md): LITE_API=http://127.0.0.1:8080/index.php node tests/lite/sale-integration.js
 */
'use strict';

var assert = require('assert');
var http = require('http');
var https = require('https');
var urlModule = require('url');
var crypto = require('crypto');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var API = process.env.LITE_API;
if (!API) {
  console.log('Lite sale integration test skipped: set LITE_API to a platform server.');
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
    data: data,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}

var uuid = (function () { var n = 0; return function () { n += 1; return '00000000-0000-4000-8000-' + ('000000000000' + n.toString(16)).slice(-12); }; }());
var stamp = new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
var nativeId = 'lite-sale-main-' + Date.now();
var revision = 0;
var ids = { cat: uuid(), soda: uuid(), bread: uuid(), owner: uuid(), cashier: uuid() };

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
    change('categories', row({ id: ids.cat, name: 'Drinks', status: 'active' })),
    change('products', row({ id: ids.soda, sku: 'SKU-1', name: 'Soda 500ml', categoryId: ids.cat, imagePath: null, barcode: '6001', retailPriceCents: 6000, wholesalePriceCents: 5000, costPriceCents: 4000, stockQty: 0, reorderLevel: 5, status: 'active' })),
    change('products', row({ id: ids.bread, sku: 'SKU-2', name: 'Bread', categoryId: ids.cat, imagePath: null, barcode: null, retailPriceCents: 7500, wholesalePriceCents: 7000, costPriceCents: 6000, stockQty: 0, reorderLevel: 2, status: 'active' })),
    change('stock_movements', row({ id: uuid(), productId: ids.soda, userId: null, movementType: 'purchase', quantity: 50, note: null })),
    change('stock_movements', row({ id: uuid(), productId: ids.bread, userId: null, movementType: 'purchase', quantity: 20, note: null })),
    change('users', row({ id: ids.owner, roleId: '00000000-0000-4000-8000-000000000001', name: 'Owner', username: 'owner', email: null, passwordHash: fixtures[0].hash, phone: null, status: 'active' })),
    change('users', row({ id: ids.cashier, roleId: '00000000-0000-4000-8000-000000000003', name: 'Wanjiru', username: 'wanjiru', email: null, passwordHash: fixtures[0].hash, phone: null, status: 'active' })),
    change('business_settings', row({ id: uuid(), businessName: 'Mama Mboga', address: null, phone: null, receiptFooter: null, currency: 'KES', paperWidthMm: 58 }))
  ];
  api('POST', 'push_changes', { changes: changes }, mainKey, function (pushStatus, pushed) {
    assert.strictEqual(pushStatus, 200, JSON.stringify(pushed));
    api('POST', 'generate_invite', {}, mainKey, function (inviteStatus, invite) {
      assert.strictEqual(inviteStatus, 200, JSON.stringify(invite));
      sellOnLite(invite.code, mainKey);
    });
  });
});

function sellOnLite(code, mainKey) {
  var storage = memoryStorage();
  var lite = Core.create({ baseUrl: API, http: transport, storage: storage, bcrypt: bcrypt, sale: Sale });
  lite.join(code, 'Sale test iPad', function (joinError) {
    assert.ifError(joinError);
    lite.login('wanjiru', 'Passw0rd!', function (loginError) {
      assert.ifError(loginError);

      var soda = function (qty, price) { return { productId: ids.soda, name: 'Soda 500ml', unitPriceCents: price || 6000, quantity: qty }; };
      var bread = function (qty) { return { productId: ids.bread, name: 'Bread', unitPriceCents: 7500, quantity: qty }; };
      var requests = [
        { cart: [soda(2), bread(1)], saleType: 'retail', paymentMethod: 'cash', cashReceivedCents: 20000 },
        { cart: [soda(3)], saleType: 'retail', paymentMethod: 'cash', discountCents: 1500, customerName: 'Wanjiru K', cashReceivedCents: 20000 },
        { cart: [bread(2)], saleType: 'retail', paymentMethod: 'mpesa_manual', customerPhone: '0712345678', referenceNote: 'QWE123XYZ9' },
        { cart: [soda(10, 5000)], saleType: 'wholesale', paymentMethod: 'cash', cashReceivedCents: 50000 },
        { cart: [soda(1), { productId: null, name: 'Delivery', unitPriceCents: 20000, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash', cashReceivedCents: 30000 }
      ];
      var receipts = [];
      requests.forEach(function (request) {
        var result = lite.sell(request);
        assert.ok(result.ok, result.message);
        receipts.push(result.receipt);
      });
      assert.strictEqual(lite.getStatus().pendingSales, 5);

      lite.sync(function (syncError, flushed) {
        assert.ifError(syncError);
        assert.strictEqual(flushed.sent, 5, JSON.stringify(flushed));
        assert.strictEqual(flushed.refused, 0, JSON.stringify(flushed.rejected));
        assert.strictEqual(lite.getStatus().pendingSales, 0);

        // Soda: 50 bought, 2+3+10+1 = 16 sold. Bread: 20 bought, 1+2 = 3 sold. The catalog (the server's own sums) agrees.
        var stock = {};
        lite.searchProducts('', null, true).forEach(function (p) { stock[p.id] = p.stockQty; });
        assert.strictEqual(stock[ids.soda], 34, 'soda stock after the sales');
        assert.strictEqual(stock[ids.bread], 17, 'bread stock after the sales');

        // A normal device pulls the shop's changes and finds exactly the sales that were made.
        api('GET', 'pull_changes&since=0', null, mainKey, function (pullStatus, pulled) {
          assert.strictEqual(pullStatus, 200);
          var byTable = {};
          pulled.changes.forEach(function (c) { (byTable[c.table_name] = byTable[c.table_name] || []).push(c); });
          var liteId = JSON.parse(storage.data['nexapos-lite-v1']).device.id;
          var liteSales = (byTable.sales || []).filter(function (c) { return c.device_id === liteId; });
          assert.strictEqual(liteSales.length, 5, 'five sales visible to the main device');
          done5(liteSales, byTable, receipts);
        });
      });
    });
  });

  function done5(liteSales, byTable, receipts) {
    // (the totals above are asserted against the receipts below, which is the clearer check)
    var totalsOnServer = liteSales.map(function (c) { return c.payload.totalCents; }).sort(function (a, b) { return a - b; });
    var totalsRung = receipts.map(function (r) { return r.totalCents; }).sort(function (a, b) { return a - b; });
    assert.deepStrictEqual(totalsOnServer, totalsRung, 'the server holds the totals that were rung up');
    var payments = (byTable.payment_records || []).filter(function (c) { return c.payload.method === 'mpesa_manual'; });
    assert.strictEqual(payments.length, 1);
    assert.strictEqual(payments[0].payload.referenceNote, 'QWE123XYZ9');

    // Sending the same sale again changes nothing (a lost reply must be harmless).
    var state = JSON.parse(storage.data['nexapos-lite-v1']);
    var key = state.device.apiKey;
    var firstSale = receipts[0];
    var original = liteSales.filter(function (c) { return c.row_id === firstSale.saleId; })[0];
    assert.ok(original, 'the first sale is on the server');
    api('GET', 'pull_changes&since=0', null, mainKey, function (_s, before) {
      var rows = [original.payload].concat((byTable.sale_items || []).filter(function (c) { return c.payload.saleId === firstSale.saleId; }).map(function (c) { return c.payload; }));
      var again = rows.map(function (p) { return { table_name: p.saleNumber ? 'sales' : 'sale_items', row_id: p.id, local_rev: p.localRev, updated_at: p.updatedAt, payload: p }; });
      // Only the sale and its lines (not its stock movements/payment) are resent here, which the guard would refuse as
      // incomplete if it were new: because they are already recorded they are skipped, so this must be accepted.
      api('POST', 'push_changes', { changes: again }, key, function (resendStatus, resent) {
        assert.strictEqual(resendStatus, 200, 'a repeat of a recorded sale is harmless: ' + JSON.stringify(resent));
        api('GET', 'pull_changes&since=0', null, mainKey, function (_s2, after) {
          assert.strictEqual(after.changes.length, before.changes.length, 'nothing was added by the repeat');

          // A tampered sale (the total no longer adds up) is refused and nothing of it is stored.
          var tampered = Sale.build({
            cart: [{ productId: ids.soda, name: 'Soda 500ml', unitPriceCents: 6000, quantity: 1 }],
            products: { }, saleType: 'retail', paymentMethod: 'cash', userId: ids.cashier, deviceId: state.device.id,
            now: function () { return Date.now(); }, nextRev: state.nextRev, randomHex: function (n) { return crypto.randomBytes(n).toString('hex'); }
          });
          assert.strictEqual(tampered.ok, false, 'the builder itself refuses an unknown product');
          var good = Sale.build({
            cart: [{ productId: ids.soda, name: 'Soda 500ml', unitPriceCents: 6000, quantity: 1 }],
            products: (function () { var m = {}; m[ids.soda] = { id: ids.soda, name: 'Soda 500ml', status: 'active', stockQty: 5, costPriceCents: 4000 }; return m; }()),
            saleType: 'retail', paymentMethod: 'cash', userId: ids.cashier, deviceId: state.device.id,
            now: function () { return Date.now(); }, nextRev: state.nextRev, randomHex: function (n) { return crypto.randomBytes(n).toString('hex'); }
          });
          assert.ok(good.ok);
          good.changes[0].payload.totalCents += 1;
          api('POST', 'push_changes', { changes: good.changes }, key, function (tamperStatus, tamperBody) {
            assert.strictEqual(tamperStatus, 422, JSON.stringify(tamperBody));
            assert.ok(/do not add up/.test(tamperBody.message), tamperBody.message);
            api('GET', 'pull_changes&since=0', null, mainKey, function (_s3, final) {
              assert.strictEqual(final.changes.length, before.changes.length, 'a refused sale stored nothing');
              console.log('Lite sale integration test passed: 5 kinds of sale accepted by the real server and read back by a normal device, stock summed correctly (soda 34, bread 17), a repeat was harmless, a tampered sale refused and not stored.');
            });
          });
        });
      });
    });
  }
}
