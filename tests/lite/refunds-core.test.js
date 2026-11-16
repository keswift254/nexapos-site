/*
 * Refunds in the Lite core: an owner (Admin) or a Manager opens a sale of the shop, chooses what to give back, gives a reason and
 * types their own password again. The refund is saved on the iPad first (as its own sale with negative amounts, exactly as the app
 * writes it), travels in the same outbox as the sales, and the stock goes back on the shelf at once. The shop is pretended here: it
 * keeps what is pushed and answers lite_sale from it the way the real server does.
 *
 * Run: node tests/lite/refunds-core.test.js
 */
'use strict';

process.env.TZ = 'Africa/Nairobi';

var assert = require('assert');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var BASE = 'https://sync.test/index.php';
var NOW = new Date(2026, 10, 16, 10, 0, 0).getTime();
var CASHIER = '44444444-4444-4444-8444-444444444444';
var OWNER = '33333333-3333-4333-8333-333333333333';
var MANAGER = '55555555-5555-4555-8555-555555555555';
var SODA = '11111111-1111-4111-8111-111111111111';
var GONE = '22222222-2222-4222-8222-222222222222';
var MAIN_PC = '51e9906b-2d41-4be4-83d3-2416e3ae184f';
var SALE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
var LINE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
var LINE2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
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
function catalogBody() {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-11-16T10:00:00Z', cursor: 5,
    license: { state: 'active', valid_until: null, never_expires: true },
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
var PASSWORD = 'Passw0rd!';
var seed = 1;
function randomHex(n) { var s = ''; while (s.length < n * 2) { seed = (seed * 1103515245 + 12345) % 2147483648; s += ('00000000' + seed.toString(16)).slice(-8); } return s.slice(0, n * 2); }

/** A sale made on another device and already in the shop: 5 sodas at 60.00, one line (and optionally a manual one). */
function theSale(extra, withManual) {
  var sale = {
    id: SALE, createdAt: '2026-11-16T05:00:00.000000Z', updatedAt: '2026-11-16T05:00:00.000000Z', deletedAt: null, localRev: 2, createdByDeviceId: MAIN_PC, syncState: 'local_only',
    saleNumber: 'AAAAAA-20261116080000-ABCD', userId: CASHIER, customerName: 'Mama Njeri', customerPhone: '0712345678', saleType: 'retail', paymentMethod: 'mpesa_manual',
    subtotalCents: 30000, discountCents: 0, totalCents: 30000, status: 'paid', cashReceivedCents: null
  };
  for (var k in extra) { sale[k] = extra[k]; }
  var items = [{ id: LINE, createdAt: sale.createdAt, updatedAt: sale.updatedAt, deletedAt: null, saleId: SALE, productId: SODA, itemName: 'Soda', quantity: 5, unitPriceCents: 6000, costPriceCents: 4000, lineTotalCents: 30000 }];
  if (withManual) {
    items.push({ id: LINE2, createdAt: sale.createdAt, updatedAt: sale.updatedAt, deletedAt: null, saleId: SALE, productId: null, itemName: 'Delivery', quantity: 1, unitPriceCents: 5000, costPriceCents: 0, lineTotalCents: 5000 });
    sale.subtotalCents = 35000; sale.totalCents = 35000;
  }
  return { sale: sale, items: items };
}

function till(options, done) {
  options = options || {};
  var storage = options.storage || fakeStorage();
  var clock = options.clock || { now: NOW };
  var shop = options.shop || { sales: {}, items: {}, pushes: [], calls: [], refuse: null, offline: false, serverError: false, saleStatus: null, saleBody: null, hold: null };
  var http = function (request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    var body = request.body ? JSON.parse(request.body) : null;
    var result;
    shop.calls.push(action);
    if (action === 'register_device') { result = { status: 201, body: { success: true, api_key: 'key-1' } }; }
    else if (action === 'join_shop') { result = { status: 200, body: { success: true } }; }
    else if (action === 'lite_catalog') { var catalog = catalogBody(); if (shop.catalogTweak) { shop.catalogTweak(catalog); } result = shop.catalogStatus ? { status: shop.catalogStatus, body: { success: false, message: 'no' } } : { status: 200, body: catalog }; }
    else if (action === 'push_changes') {
      shop.pushes.push(body.changes);
      var refusal;
      if (shop.offline || (shop.offlineAfterPushes !== undefined && shop.pushes.length > shop.offlineAfterPushes)) { result = 'offline'; }
      else if (shop.serverError) { result = { status: 503, body: { success: false, message: 'Try later.' } }; }
      else if (shop.refuse && (refusal = typeof shop.refuse === 'function' ? shop.refuse(body.changes) : shop.refuse)) { result = { status: 422, body: { success: false, message: refusal } }; }
      else {
        body.changes.forEach(function (c) {
          if (c.table_name === 'sales') { shop.sales[c.row_id] = c.payload; }
          if (c.table_name === 'sale_items') { shop.items[c.row_id] = c.payload; }
        });
        result = { status: 200, body: { success: true } };
      }
    } else if (action === 'lite_sale') {
      var id = decodeURIComponent(/id=([^&]+)/.exec(request.url)[1]);
      if (shop.offline) { result = 'offline'; }
      else if (shop.saleStatus) { result = { status: shop.saleStatus, body: shop.saleBody || { success: false, message: 'x' } }; }
      else if (!shop.sales[id] || shop.sales[id].saleType === 'refund') { result = { status: 404, body: { success: false, message: 'The shop has no such sale.' } }; }
      else {
        var refunds = Object.keys(shop.sales).map(function (k) { return shop.sales[k]; }).filter(function (s) { return s.saleType === 'refund' && s.refundOfSaleId === id && s.status === 'paid'; });
        var items = Object.keys(shop.items).map(function (k) { return shop.items[k]; }).filter(function (i) { return i.saleId === id; });
        var given = {};
        var sums = { subtotalCents: 0, discountCents: 0, totalCents: 0, cashCents: 0 };
        refunds.forEach(function (r) {
          sums.subtotalCents -= r.subtotalCents; sums.discountCents -= r.discountCents; sums.totalCents -= r.totalCents; sums.cashCents -= (r.cashReceivedCents || 0);
          Object.keys(shop.items).map(function (k) { return shop.items[k]; }).filter(function (i) { return i.saleId === r.id; }).forEach(function (l) { given[l.refundOfItemId] = (given[l.refundOfItemId] || 0) - l.quantity; });
        });
        result = { status: 200, body: { success: true, shop_id: 7, sale: shop.sales[id], cashierName: 'Wanjiru', items: items, refundCount: refunds.length, refunded: sums,
          lines: items.map(function (i) { return { itemId: i.id, quantity: i.quantity, refunded: given[i.id] || 0, remaining: i.quantity - (given[i.id] || 0) }; }) } };
      }
    } else { result = { status: 404, body: { success: false } }; }
    var send = function () {
      if (result === 'offline') { cb(new Error('network')); return; }
      cb(null, { status: result.status, text: typeof result.body === 'string' ? result.body : JSON.stringify(result.body) });
    };
    if (shop.hold && action === 'push_changes') { shop.hold(send); } else { setImmediate(send); }
  };
  var core = Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, now: function () { return clock.now; }, randomHex: randomHex });
  function ready() {
    core.login(options.user || 'owner', PASSWORD, function (loginError) {
      assert.ifError(loginError);
      done({ core: core, shop: shop, storage: storage, clock: clock, http: http });
    });
  }
  if (options.joined) { ready(); return; }
  core.join('INV', 'Till', function (error) { assert.ifError(error); ready(); });
}
function saved(t) { return JSON.parse(t.storage.data['nexapos-lite-v1']); }
function seedSale(t, extra, withManual) {
  var s = theSale(extra, withManual);
  t.shop.sales[SALE] = s.sale;
  s.items.forEach(function (i) { t.shop.items[i.id] = i; });
  return s;
}
function opened(t, cb) { t.core.loadSaleForRefund(SALE, function (error, source) { assert.ifError(error); cb(source); }); }
function ask(source, quantity, extra) {
  var r = { source: source, choices: [{ itemId: LINE, quantity: quantity, restock: true }], reason: 'Wrong goods', password: PASSWORD };
  for (var k in extra) { r[k] = extra[k]; }
  return r;
}
function stockOf(t) { return t.core.searchProducts('', null, true)[0].stockQty; }

// ---- who may refund ------------------------------------------------------------------------------------------------------------
test('only an owner (Admin) or a Manager can refund; a cashier cannot even open a sale for it', function (done) {
  till({ user: 'cash' }, function (t) {
    seedSale(t);
    assert.strictEqual(t.core.refundBlock(), 'Only an administrator or a manager can refund.');
    t.core.loadSaleForRefund(SALE, function (error) {
      assert.ok(error);
      assert.strictEqual(error.message, 'Only an administrator or a manager can refund.');
      assert.ok(t.shop.calls.indexOf('lite_sale') < 0, 'the shop was not even asked');
      t.core.refundSale({ source: { sale: { id: SALE }, heldHere: 0 }, choices: [], reason: 'x', password: PASSWORD }, function (result) {
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.message, 'Only an administrator or a manager can refund.');
        done();
      });
    });
  });
});

test('an owner and a manager can refund', function (done) {
  till({ user: 'manager' }, function (t) {
    assert.strictEqual(t.core.refundBlock(), null);
    till({ user: 'owner' }, function (o) {
      assert.strictEqual(o.core.refundBlock(), null);
      done();
    });
  });
});

test('a shop whose licence has been revoked, or an iPad the shop has switched off, cannot refund', function (done) {
  till({}, function (t) {
    t.shop.catalogTweak = function (c) { c.license = { state: 'revoked', valid_until: null, never_expires: false }; };
    t.core.refresh(function (error) {
      assert.ifError(error);
      assert.strictEqual(t.core.refundBlock(), 'This shop\'s licence has been revoked.');
      t.shop.catalogTweak = null;
      t.core.refresh(function (error2) {
        assert.ifError(error2);
        assert.strictEqual(t.core.refundBlock(), null);
        t.shop.catalogStatus = 403;
        t.core.refresh(function () {
          assert.strictEqual(t.core.refundBlock(), 'This iPad is no longer allowed to use the shop.');
          done();
        });
      });
    });
  });
});

test('nobody logged in, or a till that has not joined, cannot refund', function (done) {
  till({}, function (t) {
    t.core.logout();
    assert.strictEqual(t.core.refundBlock(), 'Log in first.');
    done();
  });
});

// ---- opening a sale -------------------------------------------------------------------------------------------------------------------
test('opening a sale gives the shop\'s sale, its lines and what is left to refund', function (done) {
  till({}, function (t) {
    seedSale(t, null, true);
    opened(t, function (source) {
      assert.strictEqual(source.sale.saleNumber, 'AAAAAA-20261116080000-ABCD');
      assert.strictEqual(source.items.length, 2);
      assert.strictEqual(source.refundCount, 0);
      assert.deepStrictEqual(source.refunded, { subtotalCents: 0, discountCents: 0, totalCents: 0, cashCents: 0 });
      assert.strictEqual(source.lines[0].remaining, 5);
      assert.strictEqual(source.heldHere, 0);
      assert.strictEqual(t.core.whyNotRefundable(source), null);
      var q = t.core.quoteRefund(source, [{ itemId: LINE, quantity: 2 }]);
      assert.strictEqual(q.totalCents, 12000);
      done();
    });
  });
});

test('opening a sale sends what is waiting on this iPad first (so the shop\'s picture is complete)', function (done) {
  till({}, function (t) {
    var sold = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 2 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: 12000 });
    assert.ok(sold.ok);
    assert.strictEqual(t.core.outbox().pending, 1);
    t.core.loadSaleForRefund(sold.receipt.saleId, function (error, source) {
      assert.ifError(error);
      assert.strictEqual(source.sale.saleNumber, sold.receipt.saleNumber, 'the sale was sent, then read back');
      assert.strictEqual(t.core.outbox().pending, 0);
      assert.ok(t.shop.calls.indexOf('push_changes') < t.shop.calls.indexOf('lite_sale'));
      done();
    });
  });
});

test('no internet: opening a sale says so; a sale or refund still waiting here is not opened', function (done) {
  till({}, function (t) {
    seedSale(t);
    t.shop.offline = true;
    t.core.loadSaleForRefund(SALE, function (error) {
      assert.strictEqual(error.code, 'offline');
      t.shop.calls = [];
      var sold = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: 6000 });
      t.core.loadSaleForRefund(sold.receipt.saleId, function (error2) {
        assert.ok(error2, 'a sale that could not be sent cannot be refunded yet');
        assert.strictEqual(error2.code, 'waiting', 'it says it is waiting, not that the shop has no such sale');
        assert.ok(t.shop.calls.indexOf('lite_sale') < 0);
        done();
      });
    });
  });
});

test('an unrelated sale that cannot be sent does not stop another sale being opened for a refund', function (done) {
  till({}, function (t) {
    seedSale(t);
    var other = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: 6000 });
    assert.ok(other.ok);
    t.shop.serverError = true;
    t.core.loadSaleForRefund(SALE, function (error, source) {
      assert.ifError(error);
      assert.strictEqual(source.sale.id, SALE);
      assert.strictEqual(t.core.outbox().pending, 1, 'the other sale is still waiting');
      done();
    });
  });
});

test('a refund of this sale still waiting here (the push stopped part-way) is not opened over: it says to send it first', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      var other = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: 6000 });
      assert.ok(other.ok);
      t.core.refundSale(ask(source, 1), function (result) {
        assert.ok(result.ok, result.message);
        t.shop.offlineAfterPushes = t.shop.pushes.length + 1; // the sale goes, the refund behind it does not
        t.shop.calls = [];
        t.core.loadSaleForRefund(SALE, function (error) {
          assert.ok(error);
          assert.strictEqual(error.code, 'waiting');
          assert.ok(/still waiting on this iPad/.test(error.message));
          assert.ok(t.shop.calls.indexOf('lite_sale') < 0, 'the shop was not asked for a picture that is missing a refund');
          done();
        });
      });
    });
  });
});

test('the shop answers: no such sale / server too old / not allowed / unreadable', function (done) {
  till({}, function (t) {
    t.core.loadSaleForRefund(SALE, function (e1) {
      assert.strictEqual(e1.code, 'missing');
      assert.strictEqual(e1.message, 'The shop has no record of that sale, so it cannot be refunded.');
      seedSale(t);
      t.shop.saleStatus = 404; t.shop.saleBody = { success: false, message: 'Unknown action.' };
      t.core.loadSaleForRefund(SALE, function (e2) {
        assert.strictEqual(e2.code, 'unavailable');
        assert.ok(/cannot do refunds yet/.test(e2.message));
        t.shop.saleStatus = 403; t.shop.saleBody = { success: false, message: 'no' };
        t.core.loadSaleForRefund(SALE, function (e3) {
          assert.strictEqual(e3.code, 'forbidden');
          assert.ok(/not allowed to refund/.test(e3.message));
          t.shop.saleStatus = 401;
          t.core.loadSaleForRefund(SALE, function (e4) {
            assert.strictEqual(e4.code, 'unauthorized');
            t.shop.saleStatus = 200; t.shop.saleBody = { success: true, sale: { id: SALE }, items: 'no', lines: [], refunded: {} };
            t.core.loadSaleForRefund(SALE, function (e5) {
              assert.strictEqual(e5.code, 'server');
              assert.ok(/cannot read/.test(e5.message));
              t.shop.saleStatus = 200;
              var goodSale = function () { return { id: SALE, saleNumber: 'X', status: 'paid', paymentMethod: 'cash', subtotalCents: 100, discountCents: 0, totalCents: 100 }; };
              var goodItem = function () { return { id: LINE, itemName: 'Soda', quantity: 1, unitPriceCents: 100, costPriceCents: 50 }; };
              var goodRefunded = function () { return { subtotalCents: 0, discountCents: 0, totalCents: 0, cashCents: 0 }; };
              var bad = [
                ['a fractional amount', { sale: (function () { var s = goodSale(); s.subtotalCents = 1.5; return s; }()), items: [], lines: [], refunded: goodRefunded() }],
                ['an item with a fractional quantity', { sale: goodSale(), items: [(function () { var i = goodItem(); i.quantity = 1.5; return i; }())], lines: [], refunded: goodRefunded() }],
                ['an item with no name', { sale: goodSale(), items: [(function () { var i = goodItem(); delete i.itemName; return i; }())], lines: [], refunded: goodRefunded() }],
                ['an item with a fractional cost', { sale: goodSale(), items: [(function () { var i = goodItem(); i.costPriceCents = 0.5; return i; }())], lines: [], refunded: goodRefunded() }],
                ['a line with a fractional count', { sale: goodSale(), items: [goodItem()], lines: [{ itemId: LINE, quantity: 1, refunded: 0.5, remaining: 1 }], refunded: goodRefunded() }],
                ['a line with no item', { sale: goodSale(), items: [goodItem()], lines: [{ quantity: 1, refunded: 0 }], refunded: goodRefunded() }],
                ['a refunded figure that is not whole', { sale: goodSale(), items: [goodItem()], lines: [], refunded: { subtotalCents: 0, discountCents: 0, totalCents: 0.5, cashCents: 0 } }],
                ['a refunded figure that is missing', { sale: goodSale(), items: [goodItem()], lines: [], refunded: { subtotalCents: 0, discountCents: 0, totalCents: 0 } }],
                ['a cash amount that is not whole', { sale: (function () { var s = goodSale(); s.cashReceivedCents = 'x'; return s; }()), items: [], lines: [], refunded: goodRefunded() }]
              ];
              (function next(index) {
                if (index === bad.length) {
                  t.shop.saleBody = { success: true, sale: goodSale(), items: [goodItem()], lines: [{ itemId: LINE, quantity: 1, refunded: 0, remaining: 1 }], refunded: goodRefunded(), refundCount: 0 };
                  t.core.loadSaleForRefund(SALE, function (fine, source) {
                    assert.ifError(fine);
                    assert.strictEqual(source.items.length, 1, 'a well-formed answer is accepted');
                    done();
                  });
                  return;
                }
                var body = bad[index][1];
                body.success = true;
                t.shop.saleBody = body;
                t.core.loadSaleForRefund(SALE, function (e6) {
                  assert.ok(e6, bad[index][0] + ' is not a sale this till can read');
                  assert.strictEqual(e6.code, 'server', bad[index][0]);
                  next(index + 1);
                });
              }(0));
            });
          });
        });
      });
    });
  });
});

// ---- refunding ------------------------------------------------------------------------------------------------------------------------------
test('a refund is saved on the iPad first, puts the stock back at once, and is sent with the rest', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      var before = stockOf(t);
      t.core.refundSale(ask(source, 2), function (result) {
        assert.ok(result.ok, result.message);
        var r = result.receipt;
        assert.strictEqual(r.isRefund, true);
        assert.strictEqual(r.totalCents, 12000);
        assert.strictEqual(r.refundOfSaleNumber, 'AAAAAA-20261116080000-ABCD');
        assert.strictEqual(r.cashierName, 'Owner');
        assert.strictEqual(stockOf(t), before + 2, 'two sodas back on the shelf');
        var s = saved(t);
        assert.strictEqual(s.outbox.length, 1);
        assert.strictEqual(s.outbox[0].kind, 'refund');
        assert.strictEqual(s.outbox[0].status, 'pending');
        assert.deepStrictEqual(s.outbox[0].changes.map(function (c) { return c.table_name; }), ['sales', 'sale_items', 'stock_movements', 'payment_records']);
        assert.strictEqual(s.history[0].receipt.saleId, r.saleId);
        assert.strictEqual(s.history[0].status, 'queued');
        assert.strictEqual(t.core.outbox().pendingRefunds, 1);
        assert.strictEqual(t.core.outbox().pending, 0, 'a refund is not counted as a sale');
        assert.strictEqual(t.core.getStatus().pendingRefunds, 1);
        assert.strictEqual(t.shop.pushes.length, 0, 'nothing was sent yet');
        t.core.flush(function (error, flushed) {
          assert.ifError(error);
          assert.strictEqual(flushed.sent, 1);
          assert.strictEqual(saved(t).outbox.length, 0);
          assert.strictEqual(saved(t).history[0].status, 'sent');
          var stored = t.shop.sales[r.saleId];
          assert.strictEqual(stored.saleType, 'refund');
          assert.strictEqual(stored.refundOfSaleId, SALE);
          assert.strictEqual(stored.totalCents, -12000);
          // and the shop now shows 3 of the 5 left
          t.core.loadSaleForRefund(SALE, function (e2, again) {
            assert.ifError(e2);
            assert.strictEqual(again.refundCount, 1);
            assert.strictEqual(again.lines[0].remaining, 3);
            done();
          });
        });
      });
    });
  });
});

test('the revisions are consecutive across a sale and the refund that follows it', function (done) {
  till({}, function (t) {
    var sold = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 3 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: 18000 });
    t.core.loadSaleForRefund(sold.receipt.saleId, function (error, source) {
      assert.ifError(error);
      t.core.refundSale({ source: source, choices: [{ itemId: source.items[0].id, quantity: 1, restock: true }], reason: 'Wrong', password: PASSWORD }, function (result) {
        assert.ok(result.ok, result.message);
        var revs = [];
        saved(t).outbox.forEach(function (e) { e.changes.forEach(function (c) { revs.push(c.local_rev); }); });
        if (!revs.length) { saved(t).history.forEach(function () {}); }
        var all = t.shop.pushes.reduce(function (a, b) { return a.concat(b); }, []).concat(saved(t).outbox.reduce(function (a, e) { return a.concat(e.changes); }, []));
        var numbers = all.map(function (c) { return c.local_rev; });
        for (var i = 1; i < numbers.length; i++) { assert.strictEqual(numbers[i], numbers[i - 1] + 1, 'revision ' + numbers[i]); }
        done();
      });
    });
  });
});

test('a sale made while the password is being checked does not share revisions with the refund', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      var finished = null;
      t.core.refundSale(ask(source, 1), function (result) { finished = result; });
      var sold = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: 6000 });
      assert.ok(sold.ok);
      var wait = setInterval(function () {
        if (!finished) { return; }
        clearInterval(wait);
        assert.ok(finished.ok, finished.message);
        var revs = [];
        saved(t).outbox.forEach(function (e) { e.changes.forEach(function (c) { revs.push(c.local_rev); }); });
        revs.sort(function (a, b) { return a - b; });
        for (var i = 1; i < revs.length; i++) { assert.strictEqual(revs[i], revs[i - 1] + 1, 'revisions are all different and consecutive: ' + revs.join(',')); }
        done();
      }, 5);
    });
  });
});

test('a refund of a cash sale has no payment record; stock only goes back for a product the till knows', function (done) {
  till({}, function (t) {
    seedSale(t, { paymentMethod: 'cash', cashReceivedCents: 30000 });
    t.shop.items[LINE].productId = GONE;
    opened(t, function (source) {
      t.core.refundSale(ask(source, 1), function (result) {
        assert.ok(result.ok, result.message);
        var tables = saved(t).outbox[0].changes.map(function (c) { return c.table_name; });
        assert.deepStrictEqual(tables, ['sales', 'sale_items'], 'a cash refund has no payment record, and a gone product has no stock to return');
        assert.strictEqual(saved(t).outbox[0].changes[1].payload.costPriceCents, 0);
        done();
      });
    });
  });
});

test('"do not put back in stock" leaves the stock alone', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      var before = stockOf(t);
      t.core.refundSale(ask(source, 2, { choices: [{ itemId: LINE, quantity: 2, restock: false }] }), function (result) {
        assert.ok(result.ok, result.message);
        assert.strictEqual(stockOf(t), before);
        assert.ok(saved(t).outbox[0].changes.every(function (c) { return c.table_name !== 'stock_movements'; }));
        done();
      });
    });
  });
});

// ---- the password ------------------------------------------------------------------------------------------------------------------------
test('the refund is checked completely BEFORE the password is tried (a mistake in the refund does not count as a wrong password)', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      t.core.refundSale(ask(source, 2, { reason: '  ', password: 'wrong' }), function (blank) {
        assert.strictEqual(blank.message, 'Enter the reason for the refund.');
        t.core.refundSale(ask(source, 9, { password: 'wrong' }), function (tooMany) {
          assert.strictEqual(tooMany.message, 'Only 5 of Soda can still be refunded.');
          t.core.refundSale(ask(source, 2, { choices: [] , password: 'wrong' }), function (none) {
            assert.strictEqual(none.message, 'Choose at least one item to refund.');
            assert.strictEqual(saved(t).failedLogins, 0, 'no wrong password was counted');
            assert.strictEqual(saved(t).outbox.length, 0);
            done();
          });
        });
      });
    });
  });
});

test('a missing or wrong password refuses the refund and saves nothing; five wrong ones lock it for 30 seconds', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      t.core.refundSale(ask(source, 2, { password: '' }), function (none) {
        assert.strictEqual(none.message, 'Enter your password.');
        var tries = 0;
        (function again() {
          t.core.refundSale(ask(source, 2, { password: 'wrong' }), function (result) {
            tries += 1;
            assert.strictEqual(result.ok, false);
            if (tries < 5) {
              assert.strictEqual(result.message, 'That password is not right.');
              again();
              return;
            }
            assert.strictEqual(result.message, 'Too many wrong passwords. Try again in 30 seconds.');
            assert.strictEqual(saved(t).outbox.length, 0, 'nothing was saved');
            t.core.refundSale(ask(source, 2), function (locked) {
              assert.strictEqual(locked.ok, false, 'even the right password waits');
              assert.ok(/Too many wrong passwords/.test(locked.message));
              t.clock.now += 31000;
              t.core.refundSale(ask(source, 2), function (after) {
                assert.ok(after.ok, after.message);
                assert.strictEqual(saved(t).failedLogins, 0);
                done();
              });
            });
          });
        }());
      });
    });
  });
});

test('two wrong passwords then the right one: the wrong ones are forgotten', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      t.core.refundSale(ask(source, 1, { password: 'wrong' }), function (a) {
        t.core.refundSale(ask(source, 1, { password: 'wrong' }), function (b) {
          assert.strictEqual(a.ok || b.ok, false);
          assert.strictEqual(saved(t).failedLogins, 2);
          t.core.refundSale(ask(source, 1), function (c) {
            assert.ok(c.ok, c.message);
            assert.strictEqual(saved(t).failedLogins, 0);
            done();
          });
        });
      });
    });
  });
});

test('the password is the logged-in person\'s own: another user\'s is not enough', function (done) {
  till({ user: 'manager' }, function (t) {
    seedSale(t);
    // give the owner a different password than the manager's: only the manager's hash is the fixture's
    var s = JSON.parse(t.storage.data['nexapos-lite-v1']);
    s.catalog.users.forEach(function (u) { if (u.id !== MANAGER) { u.passwordHash = fixtures[1].hash; } });
    t.storage.data['nexapos-lite-v1'] = JSON.stringify(s);
    till({ storage: t.storage, shop: t.shop, joined: true, user: 'manager' }, function (m) {
      opened(m, function (source) {
        m.core.refundSale(ask(source, 1, { password: fixtures[1].password }), function (wrong) {
          assert.strictEqual(wrong.ok, false, 'nobody else\'s password approves the manager\'s refund');
          m.core.refundSale(ask(source, 1), function (right) {
            assert.ok(right.ok, right.message);
            assert.strictEqual(saved(m).outbox[0].changes[0].payload.userId, MANAGER);
            done();
          });
        });
      });
    });
  });
});

test('a person who has since been switched off, or made a cashier, cannot approve a refund', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      t.shop.catalogTweak = function (c) { c.users.forEach(function (u) { if (u.id === OWNER) { u.roleId = '00000000-0000-4000-8000-000000000003'; } }); };
      t.core.refresh(function (error) {
        assert.ifError(error);
        t.core.refundSale(ask(source, 1), function (demoted) {
          assert.strictEqual(demoted.ok, false);
          assert.strictEqual(demoted.message, 'Only an administrator or a manager can refund.');
          t.shop.catalogTweak = function (c) { c.users.forEach(function (u) { if (u.id === OWNER) { u.status = 'disabled'; } }); };
          t.core.refresh(function (error2) {
            assert.ifError(error2);
            t.core.refundSale(ask(source, 1), function (off) {
              assert.strictEqual(off.ok, false);
              assert.strictEqual(off.message, 'Only an administrator or a manager can refund.');
              assert.strictEqual(saved(t).outbox.length, 0);
              done();
            });
          });
        });
      });
    });
  });
});

// ---- double submit and changes underneath ------------------------------------------------------------------------------------------
test('submitting the same sale twice cannot refund it twice (the second one says the sale has changed)', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      t.core.refundSale(ask(source, 5), function (first) {
        assert.ok(first.ok, first.message);
        t.core.refundSale(ask(source, 5), function (second) {
          assert.strictEqual(second.ok, false);
          assert.strictEqual(second.message, 'This sale has changed since it was opened. Open it again.');
          assert.strictEqual(saved(t).outbox.length, 1);
          t.core.refundSale(ask(source, 5, { password: 'wrong' }), function (third) {
            assert.strictEqual(third.message, 'This sale has changed since it was opened. Open it again.', 'said before the password is even looked at');
            assert.strictEqual(saved(t).failedLogins, 0);
            done();
          });
        });
      });
    });
  });
});

test('two taps at once record one refund', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      var results = [];
      function finished(result) { results.push(result); if (results.length === 2) { check(); } }
      t.core.refundSale(ask(source, 5), finished);
      t.core.refundSale(ask(source, 5), finished);
      function check() {
        assert.strictEqual(results.filter(function (r) { return r.ok; }).length, 1, 'exactly one succeeded');
        assert.strictEqual(results.filter(function (r) { return !r.ok; })[0].message, 'A refund is being recorded. Wait a moment.');
        assert.strictEqual(saved(t).outbox.length, 1);
        done();
      }
    });
  });
});

test('logging out while the password is being checked records nothing', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      var finished = null;
      t.core.refundSale(ask(source, 2), function (result) { finished = result; });
      t.core.logout();
      var wait = setInterval(function () {
        if (!finished) { return; }
        clearInterval(wait);
        assert.strictEqual(finished.ok, false);
        assert.strictEqual(finished.message, 'You were logged out. Log in and try again.');
        assert.strictEqual(saved(t).outbox.length, 0);
        done();
      }, 5);
    });
  });
});

test('refunds in parts: the second is worked out from what the first took, and a sale refunded in full cannot be opened for more', function (done) {
  till({}, function (t) {
    seedSale(t, { discountCents: 3000, totalCents: 27000 });
    opened(t, function (source) {
      t.core.refundSale(ask(source, 2), function (first) {
        assert.ok(first.ok, first.message);
        assert.strictEqual(first.receipt.discountCents, 1200);
        assert.strictEqual(first.receipt.totalCents, 10800);
        t.core.flush(function () {
          opened(t, function (again) {
            t.core.refundSale(ask(again, 3), function (second) {
              assert.ok(second.ok, second.message);
              assert.strictEqual(second.receipt.discountCents, 1800, 'the last part takes the rounding: 3000 - 1200');
              assert.strictEqual(second.receipt.totalCents, 16200);
              t.core.flush(function () {
                opened(t, function (last) {
                  assert.strictEqual(t.core.whyNotRefundable(last), 'This sale has already been refunded in full.');
                  t.core.refundSale(ask(last, 1), function (third) {
                    assert.strictEqual(third.ok, false);
                    assert.strictEqual(third.message, 'This sale has already been refunded in full.');
                    done();
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

// ---- what the shop says to a refund ------------------------------------------------------------------------------------------------------
test('a refund the shop refuses stays on the iPad as "not recorded", apart from the sales, and the owner can remove it', function (done) {
  till({}, function (t) {
    seedSale(t);
    t.shop.refuse = 'Refund X: only 3 of Soda can still be refunded.';
    opened(t, function (source) {
      t.core.refundSale(ask(source, 2), function (result) {
        assert.ok(result.ok);
        t.core.flush(function (error, flushed) {
          assert.ifError(error);
          assert.strictEqual(flushed.refused, 1);
          var summary = t.core.outbox();
          assert.strictEqual(summary.rejected.length, 0, 'not a sale');
          assert.strictEqual(summary.rejectedRefunds.length, 1);
          assert.strictEqual(summary.rejectedRefunds[0].message, 'Refund X: only 3 of Soda can still be refunded.');
          assert.strictEqual(summary.rejectedRefunds[0].totalCents, 12000);
          assert.strictEqual(summary.rejectedRefunds[0].refundOfSaleNumber, 'AAAAAA-20261116080000-ABCD');
          assert.strictEqual(t.core.getStatus().rejectedRefunds, 1);
          assert.strictEqual(t.core.getStatus().rejectedSales, 0);
          assert.strictEqual(saved(t).history[0].status, 'rejected');
          // a refund the shop refused still counts as held here: the sale on screen is out of date
          assert.strictEqual(t.core.discardRejected(result.receipt.saleId).ok, true, 'the owner removes it');
          assert.strictEqual(t.core.outbox().rejectedRefunds.length, 0);
          done();
        });
      });
    });
  });
});

test('only the owner can remove a refund the shop refused (as for a sale)', function (done) {
  till({ user: 'manager' }, function (t) {
    seedSale(t);
    t.shop.refuse = 'no';
    opened(t, function (source) {
      t.core.refundSale(ask(source, 1), function (result) {
        assert.ok(result.ok);
        t.core.flush(function () {
          var removed = t.core.discardRejected(result.receipt.saleId);
          assert.strictEqual(removed.ok, false);
          assert.strictEqual(t.core.outbox().rejectedRefunds.length, 1);
          done();
        });
      });
    });
  });
});

test('no internet when sending: the refund waits, and is sent when the shop is back', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      t.core.refundSale(ask(source, 1), function (result) {
        assert.ok(result.ok);
        t.shop.offline = true;
        t.core.flush(function (error) {
          assert.strictEqual(error.code, 'offline');
          assert.strictEqual(t.core.outbox().pendingRefunds, 1);
          t.shop.offline = false;
          t.core.flush(function (error2, flushed) {
            assert.ifError(error2);
            assert.strictEqual(flushed.sent, 1);
            assert.strictEqual(t.core.outbox().pendingRefunds, 0);
            done();
          });
        });
      });
    });
  });
});

test('a refund waiting on the iPad survives a reload and is still counted', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      t.core.refundSale(ask(source, 1), function (result) {
        assert.ok(result.ok);
        till({ storage: t.storage, shop: t.shop, joined: true }, function (again) {
          assert.strictEqual(again.core.outbox().pendingRefunds, 1);
          again.core.loadSaleForRefund(SALE, function (error, source2) {
            assert.ifError(error);
            assert.strictEqual(source2.refundCount, 1, 'it was sent first, then read back');
            assert.strictEqual(source2.lines[0].remaining, 4);
            done();
          });
        });
      });
    });
  });
});

// ---- today on this iPad and the receipt --------------------------------------------------------------------------------------------------
test('today\'s totals: a refund takes its money back out of the cash or M-Pesa it was paid with and is not a sale', function (done) {
  till({}, function (t) {
    seedSale(t, { paymentMethod: 'cash', cashReceivedCents: 30000 });
    var sold = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 4 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: 24000 });
    assert.ok(sold.ok);
    opened(t, function (source) {
      t.core.refundSale(ask(source, 2), function (result) {
        assert.ok(result.ok, result.message);
        var today = t.core.todaySummary();
        assert.strictEqual(today.sales, 1);
        assert.strictEqual(today.items, 4);
        assert.strictEqual(today.refunds, 1);
        assert.strictEqual(today.refundCents, 12000);
        assert.strictEqual(today.cashCents, 24000 - 12000);
        assert.strictEqual(today.totalCents, 24000 - 12000);
        done();
      });
    });
  });
});

test('today\'s totals: an M-Pesa refund takes its money out of M-Pesa only', function (done) {
  till({}, function (t) {
    seedSale(t);
    opened(t, function (source) {
      t.core.refundSale(ask(source, 2), function (result) {
        assert.ok(result.ok, result.message);
        var today = t.core.todaySummary();
        assert.strictEqual(today.mpesaCents, -12000);
        assert.strictEqual(today.cashCents, 0);
        assert.strictEqual(today.onlineCents, 0);
        assert.strictEqual(today.totalCents, -12000);
        done();
      });
    });
  });
});

test('today\'s totals: a refund of a split sale takes the cash share out of cash and the rest out of online', function (done) {
  till({}, function (t) {
    var s = seedSale(t, { paymentMethod: 'paystack', cashReceivedCents: 10000, subtotalCents: 30000, totalCents: 30000 });
    assert.ok(s);
    opened(t, function (source) {
      t.core.refundSale(ask(source, 5), function (result) {
        assert.ok(result.ok, result.message);
        assert.strictEqual(result.receipt.cashBackCents, 10000);
        var today = t.core.todaySummary();
        assert.strictEqual(today.cashCents, -10000);
        assert.strictEqual(today.onlineCents, -20000);
        assert.strictEqual(today.mpesaCents, 0);
        assert.strictEqual(today.totalCents, -30000);
        done();
      });
    });
  });
});

test('a refund the shop refused is not in today\'s totals', function (done) {
  till({}, function (t) {
    seedSale(t);
    t.shop.refuse = 'no';
    opened(t, function (source) {
      t.core.refundSale(ask(source, 2), function (result) {
        assert.ok(result.ok);
        t.core.flush(function () {
          var today = t.core.todaySummary();
          assert.strictEqual(today.refunds, 0);
          assert.strictEqual(today.totalCents, 0);
          done();
        });
      });
    });
  });
});

test('the REFUND receipt: title, who, which sale, why, what went back, how it was paid back', function (done) {
  till({}, function (t) {
    seedSale(t, { discountCents: 3000, totalCents: 27000 }, false);
    opened(t, function (source) {
      t.core.refundSale(ask(source, 2, { reason: 'Bottle cracked' }), function (result) {
        assert.ok(result.ok);
        var sheet = t.core.receiptSheet(result.receipt, false);
        assert.strictEqual(sheet.title, 'REFUND');
        var meta = {};
        sheet.meta.forEach(function (m) { meta[m.label] = m.value; });
        assert.strictEqual(meta['Refunded by'], 'Owner');
        assert.strictEqual(meta['Refund of'], 'AAAAAA-20261116080000-ABCD');
        assert.strictEqual(meta.Reason, 'Bottle cracked');
        assert.strictEqual(meta.Customer, 'Mama Njeri');
        assert.strictEqual(meta['Receipt #'], result.receipt.saleNumber);
        assert.deepStrictEqual(sheet.lines, [{ name: 'Soda', quantity: 2, unit: 'KES 60.00', total: 'KES 120.00' }]);
        assert.deepStrictEqual(sheet.totals.map(function (x) { return x.label + '=' + x.value; }), ['Subtotal=KES 120.00', 'Discount=KES 12.00', 'TOTAL REFUNDED=KES 108.00']);
        assert.deepStrictEqual(sheet.payment.map(function (x) { return x.label + '=' + x.value; }), ['Paid back via=M-Pesa (Manual)', 'Status=REFUNDED']);
        assert.strictEqual(sheet.reprint, false);
        assert.strictEqual(t.core.receiptSheet(result.receipt, true).reprint, true);
        done();
      });
    });
  });
});

test('the REFUND receipt of a split sale says how much was cash and how much M-Pesa', function (done) {
  till({}, function (t) {
    seedSale(t, { paymentMethod: 'paystack', cashReceivedCents: 10000 });
    opened(t, function (source) {
      t.core.refundSale(ask(source, 5), function (result) {
        assert.ok(result.ok);
        var sheet = t.core.receiptSheet(result.receipt, false);
        assert.deepStrictEqual(sheet.payment.map(function (x) { return x.label + '=' + x.value; }), ['Paid back via=M-Pesa', 'Cash back=KES 100.00', 'M-Pesa back=KES 200.00', 'Status=REFUNDED']);
        done();
      });
    });
  });
});

test('an ordinary sale receipt is unchanged (no REFUND title)', function (done) {
  till({}, function (t) {
    var sold = t.core.sell({ cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: 6000 });
    assert.strictEqual(t.core.receiptSheet(sold.receipt, false).title, undefined);
    done();
  });
});

// ---- running --------------------------------------------------------------------------------------------------------------------------------
var failed = 0;
var index = 0;
(function next() {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite refunds core tests passed: ' + tests.length + ' tests.');
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
