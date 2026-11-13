/*
 * Held sales in the Lite core: a sale set aside to serve someone else first. Device-local, takes no stock, sends
 * nothing, survives a reload and a log out, and is cleared when the iPad is disconnected from the shop.
 *
 * Run: node tests/lite/held.test.js
 */
'use strict';

var assert = require('assert');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var BASE = 'https://sync.test/index.php';
var NOW = Date.UTC(2026, 10, 11, 10, 0, 0);
var CASHIER = '44444444-4444-4444-8444-444444444444';
var OWNER = '33333333-3333-4333-8333-333333333333';
var SODA = '11111111-1111-4111-8111-111111111111';
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
function fakeServer(routes) {
  var calls = [];
  function http(request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    var body = request.body ? JSON.parse(request.body) : null;
    calls.push({ action: action, body: body });
    var handler = routes[request.method + ' ' + action];
    var result = handler ? handler(request, body) : { status: 404, body: { success: false } };
    setImmediate(function () { cb(null, { status: result.status, text: JSON.stringify(result.body) }); });
  }
  http.calls = calls;
  return http;
}
function catalogBody() {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-11-11T10:00:00Z', cursor: 5,
    license: { state: 'active', valid_until: null, never_expires: true },
    business: { businessName: 'Mama Mboga', currency: 'KES' },
    categories: [{ id: 'c1', name: 'Drinks', status: 'active' }],
    products: [{ id: SODA, sku: 'S1', name: 'Soda', barcode: null, categoryId: 'c1', retailPriceCents: 6000, wholesalePriceCents: 5000, costPriceCents: 4000, reorderLevel: 5, status: 'active', stockQty: 10 }],
    users: [
      { id: CASHIER, roleId: '00000000-0000-4000-8000-000000000003', name: 'Wanjiru', username: 'cash', passwordHash: fixtures[0].hash, status: 'active' },
      { id: OWNER, roleId: '00000000-0000-4000-8000-000000000001', name: 'Owner', username: 'owner', passwordHash: fixtures[0].hash, status: 'active' }
    ],
    roles: []
  };
}
var seed = 1;
function randomHex(n) { var s = ''; while (s.length < n * 2) { seed = (seed * 1103515245 + 12345) % 2147483648; s += ('00000000' + seed.toString(16)).slice(-8); } return s.slice(0, n * 2); }
function newCore(storage, http, clock) {
  return Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, now: function () { return clock.now; }, randomHex: randomHex });
}
function till(done, username) {
  var storage = fakeStorage();
  var clock = { now: NOW };
  var http = fakeServer({
    'POST register_device': function () { return { status: 201, body: { success: true, api_key: 'key-1' } }; },
    'POST join_shop': function () { return { status: 200, body: { success: true } }; },
    'GET lite_catalog': function () { return { status: 200, body: catalogBody() }; },
    'POST push_changes': function () { return { status: 200, body: { success: true } }; }
  });
  var core = newCore(storage, http, clock);
  core.join('INV', 'Till', function (error) {
    assert.ifError(error);
    core.login(username || 'cash', 'Passw0rd!', function (loginError) {
      assert.ifError(loginError);
      done({ core: core, storage: storage, clock: clock, http: http });
    });
  });
}
function reloaded(t) { return newCore(t.storage, t.http, t.clock); }
function saved(t) { return JSON.parse(t.storage.data['nexapos-lite-v1']); }
function draft(extra) {
  var d = { cart: [{ productId: SODA, name: 'Soda', qty: 2 }], saleType: 'retail', discount: '', payment: 'cash', phone: '', cashReceived: '' };
  for (var k in extra) { d[k] = extra[k]; }
  return d;
}

test('holding sets the cart aside with everything the screen had, newest first, under the cashier\'s name', function (done) {
  till(function (t) {
    var first = t.core.holdSale('Mama Njeri', draft({ discount: '10', saleType: 'wholesale', payment: 'paystack', phone: '0712 345 678', cashReceived: '500' }));
    assert.ok(first.ok);
    t.clock.now += 60000;
    var second = t.core.holdSale('Second', draft({ cart: [{ productId: null, name: 'Delivery', qty: 1, priceCents: 20000 }] }));
    assert.ok(second.ok);
    var list = t.core.heldList();
    assert.deepStrictEqual(list.map(function (h) { return h.label; }), ['Second', 'Mama Njeri'], 'newest first');
    assert.strictEqual(list[1].heldBy, 'Wanjiru');
    assert.strictEqual(list[1].heldAt, NOW);
    assert.strictEqual(list[0].heldAt, NOW + 60000);
    assert.deepStrictEqual(list[1].draft, { cart: [{ productId: SODA, name: 'Soda', qty: 2 }], saleType: 'wholesale', discount: '10', payment: 'paystack', phone: '0712 345 678', cashReceived: '500' });
    assert.deepStrictEqual(list[0].draft.cart, [{ productId: null, name: 'Delivery', qty: 1, priceCents: 20000 }]);
    assert.strictEqual(t.core.getStatus().heldSales, 2);
    done();
  });
});

test('a name is optional: blank gets Held sale 1, 2, 3 without repeating; a typed name is trimmed and cut at 60', function (done) {
  till(function (t) {
    assert.strictEqual(t.core.holdSale('', draft()).held.label, 'Held sale 1');
    assert.strictEqual(t.core.holdSale('   ', draft()).held.label, 'Held sale 2');
    assert.strictEqual(t.core.holdSale(null, draft()).held.label, 'Held sale 3');
    var id = t.core.heldList()[1].id; // Held sale 2
    t.core.discardHeld(id);
    assert.strictEqual(t.core.holdSale(undefined, draft()).held.label, 'Held sale 2', 'the smallest number not in use');
    assert.strictEqual(t.core.holdSale('  Mama  ', draft()).held.label, 'Mama');
    var long = new Array(100).join('x');
    assert.strictEqual(t.core.holdSale(long, draft()).held.label.length, 60);
    done();
  });
});

test('held sales survive closing the page, a log out, and another cashier logging in', function (done) {
  till(function (t) {
    t.core.holdSale('Mama Njeri', draft({ discount: '5' }));
    t.core.logout();
    var again = reloaded(t);
    assert.strictEqual(again.heldList().length, 1, 'still there after a reload (and nobody is logged in)');
    again.login('owner', 'Passw0rd!', function (error) {
      assert.ifError(error);
      var list = again.heldList();
      assert.strictEqual(list[0].label, 'Mama Njeri');
      assert.strictEqual(list[0].heldBy, 'Wanjiru', 'who set it aside is kept');
      assert.strictEqual(list[0].draft.discount, '5');
      assert.strictEqual(again.resumeHeld(list[0].id).ok, true, 'any logged-in person can open it');
      done();
    });
  });
});

test('holding needs a login and something to hold; a broken cart is refused', function (done) {
  till(function (t) {
    var loggedOut = reloaded(t);
    assert.strictEqual(loggedOut.holdSale('x', draft()).message, 'Log in first.');
    var bad = [
      null, undefined, 'a cart', {}, { cart: [] }, { cart: 'x' },
      draft({ cart: [{ productId: SODA, name: 'Soda', qty: 0 }] }),
      draft({ cart: [{ productId: SODA, name: 'Soda', qty: 1.5 }] }),
      draft({ cart: [{ productId: SODA, name: 'Soda', qty: -1 }] }),
      draft({ cart: [{ productId: SODA, name: 'Soda', qty: 100001 }] }),
      draft({ cart: [{ productId: SODA, name: '', qty: 1 }] }),
      draft({ cart: [{ productId: SODA, qty: 1 }] }),
      draft({ cart: [{ productId: null, name: 'Delivery', qty: 1 }] }),
      draft({ cart: [{ productId: null, name: 'Delivery', qty: 1, priceCents: 0 }] }),
      draft({ cart: [{ productId: null, name: 'Delivery', qty: 1, priceCents: 1.5 }] }),
      draft({ cart: [null] })
    ];
    bad.forEach(function (d, i) {
      var r = t.core.holdSale('x', d);
      assert.strictEqual(r.ok, false, 'case ' + i);
      assert.strictEqual(r.message, 'There is nothing to hold.', 'case ' + i);
    });
    assert.strictEqual(t.core.heldList().length, 0);
    done();
  });
});

test('only the known fields are kept, and odd values are put right', function (done) {
  till(function (t) {
    var held = t.core.holdSale('x', {
      cart: [{ productId: SODA, name: 'Soda', qty: 2, priceCents: 1, evil: '<script>' }], saleType: 'bogus', discount: new Array(50).join('9'),
      payment: 'mpesa_manual', phone: new Array(80).join('7'), cashReceived: new Array(50).join('5'), extra: 'dropped'
    }).held;
    assert.deepStrictEqual(Object.keys(held.draft).sort(), ['cart', 'cashReceived', 'discount', 'payment', 'phone', 'saleType']);
    assert.deepStrictEqual(held.draft.cart, [{ productId: SODA, name: 'Soda', qty: 2 }], 'a catalog line has no price of its own (it is looked up when sold)');
    assert.strictEqual(held.draft.saleType, 'retail');
    assert.strictEqual(held.draft.payment, 'cash');
    assert.strictEqual(held.draft.discount.length, 20);
    assert.strictEqual(held.draft.phone.length, 30);
    assert.strictEqual(held.draft.cashReceived.length, 20);
    done();
  });
});

test('opening a held sale gives it back and takes it off the list, for good', function (done) {
  till(function (t) {
    var a = t.core.holdSale('A', draft({ discount: '7' })).held;
    t.core.holdSale('B', draft());
    var opened = t.core.resumeHeld(a.id);
    assert.ok(opened.ok);
    assert.strictEqual(opened.held.label, 'A');
    assert.strictEqual(opened.held.draft.discount, '7');
    assert.deepStrictEqual(t.core.heldList().map(function (h) { return h.label; }), ['B']);
    assert.strictEqual(reloaded(t).heldList().length, 1, 'gone after a reload too');
    var again = t.core.resumeHeld(a.id);
    assert.strictEqual(again.ok, false, 'it cannot be opened twice');
    assert.strictEqual(t.core.resumeHeld('nope').ok, false);
    done();
  });
});

test('throwing one away removes only that one, for good', function (done) {
  till(function (t) {
    var a = t.core.holdSale('A', draft()).held;
    t.core.holdSale('B', draft());
    assert.strictEqual(t.core.discardHeld(a.id).ok, true);
    assert.deepStrictEqual(t.core.heldList().map(function (h) { return h.label; }), ['B']);
    assert.deepStrictEqual(reloaded(t).heldList().map(function (h) { return h.label; }), ['B']);
    assert.strictEqual(t.core.discardHeld(a.id).ok, false);
    assert.strictEqual(t.core.discardHeld('nope').ok, false);
    assert.deepStrictEqual(t.core.heldList().map(function (h) { return h.label; }), ['B']);
    done();
  });
});

test('there is a limit of 50, with a clear message, and room again once one is gone', function (done) {
  till(function (t) {
    for (var i = 0; i < 50; i++) { assert.ok(t.core.holdSale('S' + i, draft()).ok, 'hold ' + i); }
    var over = t.core.holdSale('one too many', draft());
    assert.strictEqual(over.ok, false);
    assert.ok(/Too many held sales/.test(over.message), over.message);
    assert.strictEqual(t.core.heldList().length, 50);
    t.core.discardHeld(t.core.heldList()[0].id);
    assert.ok(t.core.holdSale('fits now', draft()).ok);
    done();
  });
});

test('holding takes no stock, records nothing and sends nothing', function (done) {
  till(function (t) {
    var callsBefore = t.http.calls.length;
    t.core.holdSale('A', draft({ cart: [{ productId: SODA, name: 'Soda', qty: 9 }] }));
    assert.strictEqual(t.http.calls.length, callsBefore, 'nothing is sent');
    assert.strictEqual(t.core.searchProducts('', null, true)[0].stockQty, 10, 'stock is not touched');
    assert.strictEqual(t.core.getStatus().pendingSales, 0);
    assert.strictEqual(t.core.outbox().pending, 0);
    assert.strictEqual(t.core.history().length, 0);
    assert.strictEqual(saved(t).outbox.length, 0);
    done();
  });
});

test('disconnecting the iPad from the shop throws every held sale away with the rest', function (done) {
  till(function (t) {
    t.core.holdSale('A', draft());
    t.core.forget();
    assert.strictEqual(t.core.heldList().length, 0);
    assert.strictEqual(reloaded(t).heldList().length, 0);
    done();
  });
});

test('a till saved before held sales existed still opens', function (done) {
  till(function (t) {
    var state = saved(t);
    delete state.held;
    t.storage.data['nexapos-lite-v1'] = JSON.stringify(state);
    var old = reloaded(t);
    assert.deepStrictEqual(old.heldList(), []);
    assert.strictEqual(old.getStatus().heldSales, 0);
    old.login('cash', 'Passw0rd!', function (error) {
      assert.ifError(error);
      assert.ok(old.holdSale('first', draft()).ok);
      done();
    });
  });
});

test('the list given out cannot be used to change the saved one', function (done) {
  till(function (t) {
    t.core.holdSale('A', draft());
    var list = t.core.heldList();
    list.length = 0;
    assert.strictEqual(t.core.heldList().length, 1);
    done();
  });
});

var failed = 0;
(function run(index) {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite held-sales tests passed: ' + tests.length + ' tests.');
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
