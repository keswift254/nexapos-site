/*
 * Paying online from the Lite till, against a REAL platform server (PHP + MySQL, sync guard on) and a pretend Paystack:
 * a payment started on the Lite page is initialised through the real endpoint, the pending sale is accepted by the
 * guard, and the paid / cancelled outcome is verified through the real verify endpoint and accepted as a follow-up.
 *
 * Needs, all local (see tests/lite/README.md):
 *   LITE_API          platform server, e.g. http://127.0.0.1:8082/index.php, started with PLATFORM_PAYSTACK_API_BASE
 *                     pointing at the pretend Paystack and a fresh database
 *   LITE_FAKE_PAYSTACK the pretend Paystack (platform repo tests/integration/fake_paystack_lite.php), e.g. http://127.0.0.1:18090
 *   LITE_MYSQL, LITE_DB_NAME  the mysql client and the database name (to give the shop a payout account / take it away)
 *
 * Run: LITE_API=... LITE_FAKE_PAYSTACK=... LITE_MYSQL=... LITE_DB_NAME=... node tests/lite/online-integration.js
 */
'use strict';

var assert = require('assert');
var http = require('http');
var https = require('https');
var urlModule = require('url');
var crypto = require('crypto');
var childProcess = require('child_process');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var API = process.env.LITE_API;
var FAKE = process.env.LITE_FAKE_PAYSTACK;
var MYSQL = process.env.LITE_MYSQL;
var DB = process.env.LITE_DB_NAME;
if (!API || !FAKE || !MYSQL || !DB) {
  console.log('Lite online-payment integration test skipped: set LITE_API, LITE_FAKE_PAYSTACK, LITE_MYSQL and LITE_DB_NAME.');
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

function fakeControl(path, cb) {
  transport({ method: 'GET', url: FAKE + path, headers: {}, body: null }, function (error, response) {
    if (error) { throw error; }
    cb(JSON.parse(response.text));
  });
}

function sql(statement) {
  childProcess.execFileSync(MYSQL, ['-uroot', DB, '-e', statement], { stdio: 'pipe' });
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
var nativeId = 'lite-online-main-' + Date.now();
var revision = 0;
var ids = { cat: uuid(), soda: uuid(), bread: uuid(), owner: uuid(), cashier: uuid() };
var REFERENCE = /^[0-9A-Z]{6}-\d{14}-[0-9A-Z]{4}$/;

function row(extra) {
  revision += 1;
  var base = { createdAt: stamp, updatedAt: stamp, deletedAt: null, localRev: revision, createdByDeviceId: nativeId, syncState: 'local_only' };
  for (var k in extra) { base[k] = extra[k]; }
  return base;
}
function change(table, payload) { return { table_name: table, row_id: payload.id, local_rev: payload.localRev, updated_at: payload.updatedAt, payload: payload }; }

var steps = [];
function step(name, fn) { steps.push({ name: name, fn: fn }); }
var ctx = {};

function runFrom(index) {
  if (index >= steps.length) {
    console.log('Lite online-payment integration test passed: ' + steps.length + ' steps against the real platform (initialise -> pay / abandon -> verify -> settle accepted by the guard; wrong amount, missing payout account and a payment finished elsewhere handled).');
    return;
  }
  var current = steps[index];
  process.stdout.write('  - ' + current.name + '\n');
  current.fn(function () { runFrom(index + 1); });
}

// ---------------------------------------------------------------------------------------------------------------
function latestVersions(changes, table) {
  var latest = {};
  changes.filter(function (c) { return c.table_name === table; }).forEach(function (c) {
    if (!latest[c.row_id] || c.payload.updatedAt > latest[c.row_id].payload.updatedAt) { latest[c.row_id] = c; }
  });
  return latest;
}
function pullAll(cb) {
  api('GET', 'pull_changes&since=0', null, ctx.mainKey, function (status, pulled) {
    assert.strictEqual(status, 200);
    cb(pulled.changes);
  });
}
function stockOf(id) { return ctx.lite.searchProducts('', null, true).filter(function (p) { return p.id === id; })[0].stockQty; }
function soda(qty) { return { productId: ids.soda, name: 'Soda 500ml', unitPriceCents: 6000, quantity: qty }; }
function bread(qty) { return { productId: ids.bread, name: 'Bread', unitPriceCents: 7500, quantity: qty }; }
function refresh(cb) { ctx.lite.sync(function (error) { assert.ifError(error); cb(); }); }

step('set up a shop (owner device, catalog, cashier), give it a payout account, connect the Lite till', function (next) {
  api('POST', 'register_device', { device_id: nativeId, device_label: 'Main PC', registration_secret: 'secret-' + nativeId }, null, function (status, registered) {
    assert.strictEqual(status, 201, JSON.stringify(registered));
    ctx.mainKey = registered.api_key;
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
    api('POST', 'push_changes', { changes: changes }, ctx.mainKey, function (pushStatus, pushed) {
      assert.strictEqual(pushStatus, 200, JSON.stringify(pushed));
      sql("UPDATE shops SET business_name = 'Mama Mboga', subaccount_code = 'SUB_LITE_D', is_verified = 1 WHERE id = (SELECT shop_id FROM clients WHERE device_id = '" + nativeId + "')");
      api('POST', 'generate_invite', {}, ctx.mainKey, function (inviteStatus, invite) {
        assert.strictEqual(inviteStatus, 200, JSON.stringify(invite));
        ctx.storage = memoryStorage();
        ctx.lite = Core.create({ baseUrl: API, http: transport, storage: ctx.storage, bcrypt: bcrypt, sale: Sale });
        ctx.lite.join(invite.code, 'Online test iPad', function (joinError) {
          assert.ifError(joinError);
          ctx.lite.login('wanjiru', 'Passw0rd!', function (loginError) {
            assert.ifError(loginError);
            next();
          });
        });
      });
    });
  });
});

step('a payment is initialised through the real endpoint with the shop\'s payout account, its own email and the Lite return page', function (next) {
  ctx.lite.startOnline({ cart: [soda(2)], saleType: 'retail' }, function (error, started) {
    assert.ifError(error);
    ctx.paid = started;
    assert.ok(REFERENCE.test(started.reference), started.reference);
    assert.ok(/^https:\/\/checkout\.paystack\.com\/fake-/.test(started.authorizationUrl), started.authorizationUrl);
    fakeControl('/__control/get?reference=' + encodeURIComponent(started.reference), function (got) {
      assert.strictEqual(got.status, true, 'Paystack was asked');
      var asked = got.entry.request;
      assert.ok(/^s\d+-0001@nexapos\.cc$/.test(asked.email), 'a per-payment address, not the till placeholder: ' + asked.email);
      assert.strictEqual(asked.callback_url, 'https://nexapos.cc/lite/paid.html');
      assert.strictEqual(asked.amount, 12000);
      assert.strictEqual(asked.currency, 'KES');
      assert.strictEqual(asked.subaccount, 'SUB_LITE_D');
      assert.strictEqual(asked.reference, started.reference);
      assert.strictEqual(stockOf(ids.soda), 48, 'the two sodas are reserved on the iPad at once');
      next();
    });
  });
});

step('the pending sale is accepted by the guard; not paid yet means still waiting', function (next) {
  ctx.lite.flush(function (error, flushed) {
    assert.ifError(error);
    assert.strictEqual(flushed.sent, 1, JSON.stringify(flushed));
    assert.strictEqual(flushed.refused, 0, JSON.stringify(flushed.rejected));
    ctx.lite.checkOnline(function (checkError, outcome) {
      assert.ifError(checkError);
      assert.deepStrictEqual(outcome, { paid: 0, waiting: 1 });
      pullAll(function (changes) {
        var sale = latestVersions(changes, 'sales')[ctx.paid.receipt.saleId];
        assert.strictEqual(sale.payload.status, 'pending');
        next();
      });
    });
  });
});

step('the customer pays: it is verified through the real endpoint, settled, and the settle is accepted', function (next) {
  fakeControl('/__control/set?reference=' + encodeURIComponent(ctx.paid.reference) + '&status=success', function () {
    ctx.lite.checkOnline(function (error, outcome) {
      assert.ifError(error);
      assert.deepStrictEqual(outcome, { paid: 1, waiting: 0 });
      ctx.lite.flush(function (flushError, flushed) {
        assert.ifError(flushError);
        assert.strictEqual(flushed.sent, 1, JSON.stringify(flushed));
        assert.strictEqual(flushed.refused, 0, JSON.stringify(flushed.rejected));
        pullAll(function (changes) {
          var sale = latestVersions(changes, 'sales')[ctx.paid.receipt.saleId];
          assert.strictEqual(sale.payload.status, 'paid', 'a normal device sees the sale as paid');
          var payments = latestVersions(changes, 'payment_records');
          var payment = Object.keys(payments).map(function (k) { return payments[k]; }).filter(function (p) { return p.payload.saleId === ctx.paid.receipt.saleId; })[0];
          assert.strictEqual(payment.payload.status, 'paid');
          assert.strictEqual(payment.payload.referenceNote, ctx.paid.reference);
          refresh(function () {
            assert.strictEqual(stockOf(ids.soda), 48, 'the server\'s own stock sum agrees');
            next();
          });
        });
      });
    });
  });
});

step('an abandoned payment is cancelled: stock goes back, the sale is cancelled and its payment failed', function (next) {
  ctx.lite.startOnline({ cart: [bread(1)], saleType: 'retail' }, function (error, started) {
    assert.ifError(error);
    fakeControl('/__control/set?reference=' + encodeURIComponent(started.reference) + '&status=abandoned', function () {
      ctx.lite.cancelOnline(started.receipt.saleId, function (cancelError, outcome) {
        assert.ifError(cancelError);
        assert.strictEqual(outcome.outcome, 'cancelled');
        assert.strictEqual(stockOf(ids.bread), 20);
        ctx.lite.flush(function (flushError, flushed) {
          assert.ifError(flushError);
          assert.strictEqual(flushed.sent, 2, JSON.stringify(flushed));
          assert.strictEqual(flushed.refused, 0, JSON.stringify(flushed.rejected));
          pullAll(function (changes) {
            assert.strictEqual(latestVersions(changes, 'sales')[started.receipt.saleId].payload.status, 'cancelled');
            var payments = latestVersions(changes, 'payment_records');
            var payment = Object.keys(payments).map(function (k) { return payments[k]; }).filter(function (p) { return p.payload.saleId === started.receipt.saleId; })[0];
            assert.strictEqual(payment.payload.status, 'failed');
            refresh(function () {
              assert.strictEqual(stockOf(ids.bread), 20, 'the server\'s stock sum has the return in it');
              next();
            });
          });
        });
      });
    });
  });
});

step('the main device finished the same payment first: the Lite settle is done, not refused', function (next) {
  ctx.lite.startOnline({ cart: [soda(1)], saleType: 'retail' }, function (error, started) {
    assert.ifError(error);
    ctx.shared = started;
    ctx.lite.flush(function (flushError, flushed) {
      assert.ifError(flushError);
      assert.strictEqual(flushed.sent, 1);
      pullAll(function (changes) {
        var sale = latestVersions(changes, 'sales')[started.receipt.saleId];
        var payments = latestVersions(changes, 'payment_records');
        var payment = Object.keys(payments).map(function (k) { return payments[k]; }).filter(function (p) { return p.payload.saleId === started.receipt.saleId; })[0];
        // The main device's own startup reconcile: the same rows, paid, newer.
        var later = new Date(Date.now() + 5000).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
        function paid(original, extra) {
          revision += 1;
          var payload = JSON.parse(JSON.stringify(original.payload));
          payload.status = 'paid';
          payload.updatedAt = later;
          payload.localRev = revision;
          payload.createdByDeviceId = nativeId; // a device stamps every revision it writes with its own id (the server requires it)
          for (var k in extra) { payload[k] = extra[k]; }
          return change(original.table_name, payload);
        }
        api('POST', 'push_changes', { changes: [paid(sale), paid(payment)] }, ctx.mainKey, function (pushStatus, pushed) {
          assert.strictEqual(pushStatus, 200, JSON.stringify(pushed));
          fakeControl('/__control/set?reference=' + encodeURIComponent(started.reference) + '&status=success', function () {
            ctx.lite.checkOnline(function (checkError, outcome) {
              assert.ifError(checkError);
              assert.strictEqual(outcome.paid, 1);
              ctx.lite.flush(function (settleError, settled) {
                assert.ifError(settleError);
                assert.strictEqual(settled.refused, 0, 'the real guard\'s paid-to-paid refusal must count as done: ' + JSON.stringify(settled.rejected));
                assert.strictEqual(settled.sent, 1);
                assert.strictEqual(ctx.lite.outbox().pending, 0);
                assert.strictEqual(ctx.lite.outbox().rejected.length, 0);
                next();
              });
            });
          });
        });
      });
    });
  });
});

step('Paystack reports a different amount: the platform refuses to confirm it, the sale keeps waiting and cannot be cancelled', function (next) {
  ctx.lite.startOnline({ cart: [soda(1)], saleType: 'retail' }, function (error, started) {
    assert.ifError(error);
    ctx.odd = started;
    fakeControl('/__control/set?reference=' + encodeURIComponent(started.reference) + '&status=success&amount=100', function () {
      ctx.lite.checkOnline(function (checkError, outcome) {
        assert.ok(checkError, 'a payment that does not match what was asked for is not a confirmation');
        assert.strictEqual(outcome.paid, 0);
        assert.strictEqual(ctx.lite.online().length, 1);
        ctx.lite.cancelOnline(started.receipt.saleId, function (cancelError) {
          assert.ok(cancelError, 'it cannot be cancelled while its state cannot be established');
          assert.strictEqual(ctx.lite.online().length, 1);
          next();
        });
      });
    });
  });
});

step('only the device that started a payment can verify it', function (next) {
  api('GET', 'verify_transaction&reference=' + encodeURIComponent(ctx.odd.reference), null, ctx.mainKey, function (status, body) {
    assert.strictEqual(status, 404, JSON.stringify(body));
    next();
  });
});

step('the amount is put right and the customer never paid: now it can be cancelled', function (next) {
  fakeControl('/__control/set?reference=' + encodeURIComponent(ctx.odd.reference) + '&status=abandoned&amount=6000', function () {
    ctx.lite.cancelOnline(ctx.odd.receipt.saleId, function (error, outcome) {
      assert.ifError(error);
      assert.strictEqual(outcome.outcome, 'cancelled');
      ctx.lite.flush(function (flushError, flushed) {
        assert.ifError(flushError);
        assert.strictEqual(flushed.refused, 0, JSON.stringify(flushed.rejected));
        next();
      });
    });
  });
});

step('a shop that has not set up its payout account gets a clear refusal and nothing is recorded', function (next) {
  sql("UPDATE shops SET subaccount_code = NULL WHERE id = (SELECT shop_id FROM clients WHERE device_id = '" + nativeId + "')");
  var stockBefore = stockOf(ids.soda);
  var outboxBefore = ctx.lite.outbox().pending;
  ctx.lite.startOnline({ cart: [soda(1)], saleType: 'retail' }, function (error) {
    assert.ok(error && /payment settings/i.test(error.message), error && error.message);
    assert.strictEqual(stockOf(ids.soda), stockBefore);
    assert.strictEqual(ctx.lite.outbox().pending, outboxBefore);
    assert.strictEqual(ctx.lite.online().length, 0);
    sql("UPDATE shops SET subaccount_code = 'SUB_LITE_D' WHERE id = (SELECT shop_id FROM clients WHERE device_id = '" + nativeId + "')");
    next();
  });
});

step('the guard refuses a tampered settle (sale paid but its payment failed) and stores nothing of it', function (next) {
  ctx.lite.startOnline({ cart: [soda(1)], saleType: 'retail' }, function (error, started) {
    assert.ifError(error);
    ctx.lite.flush(function (flushError) {
      assert.ifError(flushError);
      var state = JSON.parse(ctx.storage.data['nexapos-lite-v1']);
      var item = state.online.filter(function (o) { return o.saleId === started.receipt.saleId; })[0];
      var settled = Sale.settle({ original: item.original, outcome: 'paid', deviceId: state.device.id, now: function () { return Date.now() + 10000; }, nextRev: state.nextRev + 50, randomHex: function (n) { return crypto.randomBytes(n).toString('hex'); } });
      assert.ok(settled.ok);
      settled.changes[1].payload.status = 'failed';
      pullAll(function (before) {
        api('POST', 'push_changes', { changes: settled.changes }, state.device.apiKey, function (status, body) {
          assert.strictEqual(status, 422, JSON.stringify(body));
          pullAll(function (after) {
            assert.strictEqual(after.length, before.length, 'a refused settle stored nothing');
            assert.strictEqual(latestVersions(after, 'sales')[started.receipt.saleId].payload.status, 'pending');
            next();
          });
        });
      });
    });
  });
});

runFrom(0);
