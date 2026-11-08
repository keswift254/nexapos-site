/*
 * Selling through the Lite core: building the sale, saving it on the iPad first, sending it, and what happens
 * when the network drops, a reply is lost, or the server refuses a sale. The sale records themselves are
 * checked against the real app in sale.test.js; this file is about not losing or double-recording a sale.
 *
 * Run: node tests/lite/sell.test.js
 */
'use strict';

var assert = require('assert');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var BASE = 'https://sync.test/index.php';
var NOW = Date.UTC(2026, 10, 8, 10, 0, 0);
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

/** routes: 'METHOD action' -> function (request, body, callNumber) -> {status, body} | 'offline' */
function fakeServer(routes) {
  var calls = [];
  function http(request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    var body = request.body ? JSON.parse(request.body) : null;
    calls.push({ action: action, headers: request.headers, body: body });
    var handler = routes[request.method + ' ' + action];
    var result = handler ? handler(request, body, calls.length) : { status: 404, body: { success: false, message: 'No such route.' } };
    setImmediate(function () {
      if (result === 'offline') { cb(new Error('down')); } else { cb(null, { status: result.status, text: JSON.stringify(result.body) }); }
    });
  }
  http.calls = calls;
  return http;
}

function catalogBody(license) {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-11-08T10:00:00Z', cursor: 5,
    license: license || { state: 'active', valid_until: null, never_expires: true },
    business: { businessName: 'Mama Mboga', currency: 'KES' },
    categories: [{ id: 'c1', name: 'Drinks', status: 'active' }],
    products: [
      { id: '11111111-1111-4111-8111-111111111111', sku: 'S1', name: 'Soda', barcode: null, categoryId: 'c1', retailPriceCents: 6000, wholesalePriceCents: 5000, costPriceCents: 4000, reorderLevel: 5, status: 'active', stockQty: 10 },
      { id: '22222222-2222-4222-8222-222222222222', sku: 'S2', name: 'Bread', barcode: null, categoryId: 'c1', retailPriceCents: 7500, wholesalePriceCents: 0, costPriceCents: 6000, reorderLevel: 1, status: 'active', stockQty: 3 }
    ],
    users: [
      { id: '33333333-3333-4333-8333-333333333333', roleId: '00000000-0000-4000-8000-000000000001', name: 'Owner', username: 'owner', passwordHash: fixtures[0].hash, status: 'active' },
      { id: '44444444-4444-4444-8444-444444444444', roleId: '00000000-0000-4000-8000-000000000003', name: 'Cashier', username: 'cash', passwordHash: fixtures[0].hash, status: 'active' }
    ],
    roles: []
  };
}
var SODA = '11111111-1111-4111-8111-111111111111';
var BREAD = '22222222-2222-4222-8222-222222222222';

function routes(extra, license) {
  var r = {
    'POST register_device': function () { return { status: 201, body: { success: true, api_key: 'key-1' } }; },
    'POST join_shop': function () { return { status: 200, body: { success: true } }; },
    'GET lite_catalog': function () { return { status: 200, body: catalogBody(license) }; },
    'POST push_changes': function () { return { status: 200, body: { success: true } }; }
  };
  for (var k in (extra || {})) { r[k] = extra[k]; }
  return r;
}

var seed = 1;
function randomHex(n) { var s = ''; while (s.length < n * 2) { seed = (seed * 1103515245 + 12345) % 2147483648; s += ('00000000' + seed.toString(16)).slice(-8); } return s.slice(0, n * 2); }

function newCore(storage, http, clock) {
  return Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, now: function () { return clock.now; }, randomHex: randomHex });
}

/** A joined, logged-in till (as the cashier unless asked otherwise). */
function till(routeOverrides, username, license) {
  return function (done) {
    var storage = fakeStorage();
    var clock = { now: NOW };
    var http = fakeServer(routes(routeOverrides, license));
    var core = newCore(storage, http, clock);
    core.join('INV', 'Till', function (error) {
      assert.ifError(error);
      core.login(username || 'cash', 'Passw0rd!', function (loginError) {
        assert.ifError(loginError);
        done({ core: core, storage: storage, clock: clock, http: http, calls: http.calls });
      });
    });
  };
}

function oneSoda(qty) { return { cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: qty || 1 }], saleType: 'retail', paymentMethod: 'cash', cashReceivedCents: 100000 }; }
function stockOf(core, id) { return core.searchProducts('', null, true).filter(function (p) { return p.id === id; })[0].stockQty; }
function pushes(calls) { return calls.filter(function (c) { return c.action === 'push_changes'; }); }

// ---- selling ---------------------------------------------------------------------------------------------------
test('a sale is saved on the iPad first, takes stock out locally, and survives a reload', function (done) {
  till()(function (t) {
    var result = t.core.sell(oneSoda(3));
    assert.ok(result.ok, result.message);
    assert.strictEqual(stockOf(t.core, SODA), 7);
    assert.strictEqual(t.core.getStatus().pendingSales, 1);
    assert.strictEqual(pushes(t.calls).length, 0, 'nothing is sent by sell() itself');
    var again = newCore(t.storage, fakeServer({}), t.clock);
    assert.strictEqual(again.getStatus().pendingSales, 1, 'still waiting after a reload');
    assert.strictEqual(again.outbox().pending, 1);
    assert.strictEqual(again.history()[0].receipt.totalCents, 18000);
    done();
  });
});

test('selling needs a login, a loaded shop and an active licence', function (done) {
  var storage = fakeStorage();
  var core = newCore(storage, fakeServer(routes()), { now: NOW });
  assert.strictEqual(core.sell(oneSoda()).message, 'Log in first.');
  till({}, 'cash', { state: 'active', valid_until: '2026-01-01T00:00:00Z', never_expires: false })(function (expired) {
    var r = expired.core.sell(oneSoda());
    assert.strictEqual(r.ok, false);
    assert.ok(/expired/.test(r.message), r.message);
    till({}, 'cash', { state: 'revoked', valid_until: null, never_expires: false })(function (revoked) {
      assert.strictEqual(revoked.core.sell(oneSoda()).ok, false);
      done();
    });
  });
});

test('overselling is stopped by the iPad\'s own stock, counting sales not yet sent', function (done) {
  till()(function (t) {
    assert.ok(t.core.sell({ cart: [{ productId: BREAD, name: 'Bread', unitPriceCents: 7500, quantity: 2 }], saleType: 'retail', paymentMethod: 'cash' }).ok);
    var r = t.core.sell({ cart: [{ productId: BREAD, name: 'Bread', unitPriceCents: 7500, quantity: 2 }], saleType: 'retail', paymentMethod: 'cash' });
    assert.strictEqual(r.message, 'Only 1 Bread in stock.');
    done();
  });
});

test('every sale gets fresh revision numbers, kept across reloads and across refused sales', function (done) {
  till({ 'POST push_changes': function () { return { status: 422, body: { success: false, message: 'Could not record changes: nope' } }; } })(function (t) {
    t.core.sell(oneSoda());
    t.core.flush(function () {
      assert.ok(t.core.sell(oneSoda()).ok);
      var state = JSON.parse(t.storage.data['nexapos-lite-v1']);
      var used = {};
      var highest = 0;
      state.outbox.forEach(function (entry) {
        entry.changes.forEach(function (change) {
          assert.ok(!used[change.local_rev], 'revision ' + change.local_rev + ' was used twice');
          used[change.local_rev] = true;
          highest = Math.max(highest, change.local_rev);
        });
      });
      assert.ok(state.nextRev > highest, 'the saved counter is ahead of every revision already used');
      done();
    });
  });
});

// ---- sending ---------------------------------------------------------------------------------------------------
test('flush sends the sale, in order, with the device key, and clears it', function (done) {
  till()(function (t) {
    var sale = t.core.sell(oneSoda(2));
    t.core.flush(function (error, result) {
      assert.ifError(error);
      assert.strictEqual(result.sent, 1);
      assert.strictEqual(result.pending, 0);
      var sent = pushes(t.calls);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].headers.Authorization, 'Bearer key-1');
      assert.deepStrictEqual(sent[0].body.changes.map(function (c) { return c.table_name; }), ['sales', 'sale_items', 'stock_movements']);
      assert.strictEqual(sent[0].body.changes[0].row_id, sale.receipt.saleId);
      assert.strictEqual(t.core.history()[0].status, 'sent');
      done();
    });
  });
});

test('no internet: the sale waits, and the very same records are sent when it is back', function (done) {
  var online = false;
  till({ 'POST push_changes': function () { return online ? { status: 200, body: { success: true } } : 'offline'; } })(function (t) {
    t.core.sell(oneSoda());
    t.core.flush(function (error) {
      assert.strictEqual(error.code, 'offline');
      assert.strictEqual(t.core.outbox().pending, 1, 'still waiting');
      var firstTry = JSON.stringify(pushes(t.calls)[0].body);
      online = true;
      t.core.flush(function (error2, result) {
        assert.ifError(error2);
        assert.strictEqual(result.sent, 1);
        assert.strictEqual(JSON.stringify(pushes(t.calls)[1].body), firstTry, 'identical records (same ids and revisions) - safe to repeat');
        done();
      });
    });
  });
});

test('a lost reply: the server got the sale but the iPad did not hear - sending again is harmless', function (done) {
  var seen = {};
  var lost = true;
  till({ 'POST push_changes': function (request, body) {
    var key = body.changes[0].row_id;
    var already = !!seen[key];
    seen[key] = true;
    if (lost) { lost = false; return 'offline'; }
    return { status: 200, body: { success: true, duplicate: already } };
  } })(function (t) {
    t.core.sell(oneSoda());
    t.core.flush(function () {
      assert.strictEqual(t.core.outbox().pending, 1);
      t.core.flush(function (error, result) {
        assert.ifError(error);
        assert.strictEqual(result.pending, 0);
        assert.strictEqual(pushes(t.calls).length, 2);
        assert.strictEqual(Object.keys(seen).length, 1, 'only ever one sale on the server');
        done();
      });
    });
  });
});

test('a sale the server refuses is kept, shown as not recorded, and does not block the next one', function (done) {
  var n = 0;
  till({ 'POST push_changes': function () { n += 1; return n === 1 ? { status: 422, body: { success: false, message: 'Could not record changes: The stock movements do not match the lines.' } } : { status: 200, body: { success: true } }; } })(function (t) {
    var a = t.core.sell(oneSoda(1));
    var b = t.core.sell(oneSoda(2));
    t.core.flush(function (error, result) {
      assert.ifError(error);
      assert.strictEqual(result.sent, 1);
      assert.strictEqual(result.refused, 1);
      var summary = t.core.outbox();
      assert.strictEqual(summary.pending, 0);
      assert.strictEqual(summary.rejected.length, 1);
      assert.strictEqual(summary.rejected[0].id, a.receipt.saleId);
      assert.ok(/stock movements/.test(summary.rejected[0].message));
      assert.strictEqual(t.core.getStatus().rejectedSales, 1);
      assert.deepStrictEqual(t.core.history().map(function (h) { return h.status; }), ['sent', 'rejected']);
      assert.strictEqual(b.ok, true);
      // It is still there after a reload, and sending again does not retry it.
      var again = newCore(t.storage, fakeServer(routes()), t.clock);
      assert.strictEqual(again.outbox().rejected.length, 1);
      done();
    });
  });
});

test('a server hiccup (500) keeps the sale for later and stops sending', function (done) {
  till({ 'POST push_changes': function () { return { status: 503, body: { success: false, message: 'Busy' } }; } })(function (t) {
    t.core.sell(oneSoda());
    t.core.sell(oneSoda());
    t.core.flush(function (error) {
      assert.ok(error);
      assert.strictEqual(t.core.outbox().pending, 2);
      assert.strictEqual(pushes(t.calls).length, 1, 'stopped after the first failure');
      assert.strictEqual(t.core.outbox().rejected.length, 0);
      done();
    });
  });
});

test('a device the server no longer accepts keeps its sales and says it is revoked', function (done) {
  till({ 'POST push_changes': function () { return { status: 401, body: { status: false, message: 'Invalid or missing API key.' } }; } })(function (t) {
    t.core.sell(oneSoda());
    t.core.flush(function (error) {
      assert.strictEqual(error.code, 'unauthorized');
      assert.strictEqual(t.core.outbox().pending, 1);
      assert.strictEqual(t.core.getStatus().revoked, true);
      done();
    });
  });
});

test('two flushes at once send each sale only once', function (done) {
  till()(function (t) {
    t.core.sell(oneSoda());
    var finished = 0;
    function one() { finished += 1; if (finished === 2) { assert.strictEqual(pushes(t.calls).length, 1); done(); } }
    t.core.flush(one);
    t.core.flush(one);
  });
});

// ---- stock and syncing ----------------------------------------------------------------------------------------
test('a catalog refresh keeps the unsent sales counted in stock; once sent, the server\'s number takes over', function (done) {
  var serverStock = 10;
  till({
    'GET lite_catalog': function () { var b = catalogBody(); b.products[0].stockQty = serverStock; return { status: 200, body: b }; }
  })(function (t) {
    t.core.sell(oneSoda(4));
    assert.strictEqual(stockOf(t.core, SODA), 6);
    t.core.refresh(function (error) {
      assert.ifError(error);
      assert.strictEqual(stockOf(t.core, SODA), 6, 'server still says 10, but 4 are waiting to be sent');
      serverStock = 6; // the server now has the sale
      t.core.sync(function (syncError, flushed) {
        assert.ifError(syncError);
        assert.strictEqual(flushed.sent, 1);
        assert.strictEqual(stockOf(t.core, SODA), 6, 'sent: not subtracted twice');
        done();
      });
    });
  });
});

test('only an owner can remove a refused sale', function (done) {
  var refuse = function () { return { status: 422, body: { success: false, message: 'Could not record changes: nope' } }; };
  till({ 'POST push_changes': refuse }, 'cash')(function (cashier) {
    var sale = cashier.core.sell(oneSoda());
    cashier.core.flush(function () {
      assert.strictEqual(cashier.core.discardRejected(sale.receipt.saleId).ok, false);
      assert.strictEqual(cashier.core.outbox().rejected.length, 1);
      till({ 'POST push_changes': refuse }, 'owner')(function (owner) {
        var s2 = owner.core.sell(oneSoda());
        owner.core.flush(function () {
          assert.strictEqual(owner.core.discardRejected('not-a-sale').ok, false);
          assert.strictEqual(owner.core.discardRejected(s2.receipt.saleId).ok, true);
          assert.strictEqual(owner.core.outbox().rejected.length, 0);
          assert.strictEqual(owner.core.history()[0].status, 'discarded');
          done();
        });
      });
    });
  });
});

test('a refused sale is not counted again in stock after a refresh (the server never took it)', function (done) {
  till({ 'POST push_changes': function () { return { status: 422, body: { success: false, message: 'Could not record changes: nope' } }; } })(function (t) {
    t.core.sell(oneSoda(4));
    t.core.flush(function () {
      assert.strictEqual(t.core.outbox().rejected.length, 1);
      t.core.refresh(function (error) {
        assert.ifError(error);
        assert.strictEqual(stockOf(t.core, SODA), 10, 'the server\'s own number, with nothing waiting to subtract');
        done();
      });
    });
  });
});

test('an owner cannot discard a sale that is still waiting to be sent', function (done) {
  till({ 'POST push_changes': function () { return 'offline'; } }, 'owner')(function (t) {
    var waiting = t.core.sell(oneSoda());
    var result = t.core.discardRejected(waiting.receipt.saleId);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(t.core.outbox().pending, 1, 'still there');
    done();
  });
});

test('sync sends what is waiting and then refreshes the catalog', function (done) {
  till()(function (t) {
    t.core.sell(oneSoda());
    t.calls.length = 0;
    t.core.sync(function (error, flushed, status) {
      assert.ifError(error);
      assert.deepStrictEqual(t.calls.map(function (c) { return c.action; }), ['push_changes', 'lite_catalog']);
      assert.strictEqual(flushed.sent, 1);
      assert.ok(status && status.hasCatalog);
      done();
    });
  });
});

test('sync with no internet reports it and keeps the sale', function (done) {
  till({ 'POST push_changes': function () { return 'offline'; } })(function (t) {
    t.core.sell(oneSoda());
    t.calls.length = 0;
    t.core.sync(function (error) {
      assert.strictEqual(error.code, 'offline');
      assert.strictEqual(t.core.outbox().pending, 1);
      assert.deepStrictEqual(t.calls.map(function (c) { return c.action; }), ['push_changes'], 'no catalog call when sending already failed for lack of internet');
      done();
    });
  });
});
test('the history keeps the latest 100 sales', function (done) {
  till()(function (t) {
    var catalogNeedsStock = t.core.searchProducts('', null, true);
    assert.ok(catalogNeedsStock.length);
    for (var i = 0; i < 105; i++) {
      t.core.sell({ cart: [{ productId: null, name: 'Item ' + i, unitPriceCents: 100, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash' });
    }
    assert.strictEqual(t.core.history().length, 100);
    assert.strictEqual(t.core.history()[0].receipt.lines[0].name, 'Item 104');
    done();
  });
});

var failed = 0;
(function run(index) {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite selling tests passed: ' + tests.length + ' tests.');
    return;
  }
  var t = tests[index];
  var finished = false;
  var timer = setTimeout(function () { if (!finished) { finished = true; failed++; console.error('FAIL (timeout) ' + t.name); run(index + 1); } }, 60000);
  try {
    t.fn(function () { if (finished) { return; } finished = true; clearTimeout(timer); run(index + 1); });
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
