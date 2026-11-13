/*
 * Printing a receipt from the Lite till: what goes on the sheet (shop details, receipt number, date, cashier, items,
 * totals, how it was paid, the shop's footer) and where the shop details come from. The page only draws this data.
 *
 * Run: node tests/lite/print.test.js
 */
'use strict';

var assert = require('assert');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var bcrypt = require('../../lite/bcrypt.min.js');
var fixtures = require('./fixtures/bcrypt_fixtures.json').cases;

var BASE = 'https://sync.test/index.php';
var NOW = Date.UTC(2026, 2, 7, 10, 5, 0); // 7 March: day and month differ, so mixing them up shows
var CASHIER = '44444444-4444-4444-8444-444444444444';
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
  function http(request, cb) {
    var action = /action=([a-z_]+)/.exec(request.url)[1];
    var body = request.body ? JSON.parse(request.body) : null;
    var handler = routes[request.method + ' ' + action];
    var result = handler ? handler(request, body) : { status: 404, body: { success: false } };
    setImmediate(function () { cb(null, { status: result.status, text: JSON.stringify(result.body) }); });
  }
  return http;
}
var BUSINESS = { businessName: 'Mama Mboga', address: 'Tom Mboya St, Nairobi', phone: '0700 111 222', receiptFooter: 'Thank you, come again!', currency: 'KES', paperWidthMm: 80 };
function catalogBody(business) {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-11-11T10:00:00Z', cursor: 5,
    license: { state: 'active', valid_until: null, never_expires: true },
    business: business,
    categories: [{ id: 'c1', name: 'Drinks', status: 'active' }],
    products: [{ id: SODA, sku: 'S1', name: 'Soda', barcode: null, categoryId: 'c1', retailPriceCents: 6000, wholesalePriceCents: 5000, costPriceCents: 4000, reorderLevel: 5, status: 'active', stockQty: 50 }],
    users: [{ id: CASHIER, roleId: '00000000-0000-4000-8000-000000000003', name: 'Wanjiru', username: 'cash', passwordHash: fixtures[0].hash, status: 'active' }],
    roles: []
  };
}
var seed = 1;
function randomHex(n) { var s = ''; while (s.length < n * 2) { seed = (seed * 1103515245 + 12345) % 2147483648; s += ('00000000' + seed.toString(16)).slice(-8); } return s.slice(0, n * 2); }
function till(business, done) {
  var storage = fakeStorage();
  var clock = { now: NOW };
  var http = fakeServer({
    'POST register_device': function () { return { status: 201, body: { success: true, api_key: 'key-1' } }; },
    'POST join_shop': function () { return { status: 200, body: { success: true } }; },
    'GET lite_catalog': function () { return { status: 200, body: catalogBody(business) }; },
    'POST push_changes': function () { return { status: 200, body: { success: true } }; }
  });
  var core = Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, now: function () { return clock.now; }, randomHex: randomHex });
  core.join('INV', 'Till', function (error) {
    assert.ifError(error);
    core.login('cash', 'Passw0rd!', function (loginError) {
      assert.ifError(loginError);
      done({ core: core, clock: clock });
    });
  });
}
function sell(t, extra) {
  var request = { cart: [{ productId: SODA, name: 'Soda', unitPriceCents: 6000, quantity: 2 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 0, customerName: '', customerPhone: '', referenceNote: '', cashReceivedCents: null };
  for (var k in extra) { request[k] = extra[k]; }
  var result = t.core.sell(request);
  assert.ok(result.ok, result.message);
  return result.receipt;
}
function rowsOf(list) { return list.map(function (r) { return r.label + '=' + r.value; }); }
function pad(n) { return (n < 10 ? '0' : '') + n; }

test('a cash sale prints the shop, the sale, the items, the total and the change', function (done) {
  till(BUSINESS, function (t) {
    var sheet = t.core.receiptSheet(sell(t, { cashReceivedCents: 20000 }), false);
    var d = new Date(NOW);
    var date = pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    assert.strictEqual(sheet.shopName, 'Mama Mboga');
    assert.strictEqual(sheet.address, 'Tom Mboya St, Nairobi');
    assert.strictEqual(sheet.phone, '0700 111 222');
    assert.strictEqual(sheet.footer, 'Thank you, come again!');
    assert.strictEqual(sheet.widthMm, 80);
    assert.strictEqual(sheet.title, 'RECEIPT');
    assert.deepStrictEqual(rowsOf(sheet.meta).slice(1), ['Date=' + date, 'Cashier=Wanjiru']);
    assert.ok(/^\d\d\/\d\d\/2026 \d\d:\d\d$/.test(sheet.meta[1].value) && sheet.meta[1].value.indexOf('/03/') === 2, 'day/month/year, with the year: ' + sheet.meta[1].value);
    assert.ok(/^[A-Z0-9]+-\d{14}-[A-Z0-9]+$/i.test(sheet.meta[0].value) && sheet.meta[0].label === 'Receipt #', sheet.meta[0].value);
    assert.deepStrictEqual(sheet.lines, [{ name: 'Soda', detail: '2 x 60.00', total: '120.00' }]);
    assert.deepStrictEqual(sheet.totals, [{ label: 'TOTAL (KES)', value: '120.00', grand: true }]);
    assert.deepStrictEqual(rowsOf(sheet.payment), ['Paid by=Cash', 'Cash received=200.00', 'Change=80.00']);
    done();
  });
});

test('a discount shows the subtotal and the discount before the total', function (done) {
  till(BUSINESS, function (t) {
    var sheet = t.core.receiptSheet(sell(t, { discountCents: 1000 }), false);
    assert.deepStrictEqual(sheet.totals, [
      { label: 'Subtotal', value: '120.00' },
      { label: 'Discount', value: '-10.00' },
      { label: 'TOTAL (KES)', value: '110.00', grand: true }
    ]);
    done();
  });
});

test('cash that does not cover the sale says what is still owed; cash not typed shows no cash lines', function (done) {
  till(BUSINESS, function (t) {
    assert.deepStrictEqual(rowsOf(t.core.receiptSheet(sell(t, { cashReceivedCents: 10000 }), false).payment), ['Paid by=Cash', 'Cash received=100.00', 'Balance owed=20.00']);
    assert.deepStrictEqual(rowsOf(t.core.receiptSheet(sell(t, {}), false).payment), ['Paid by=Cash']);
    assert.deepStrictEqual(rowsOf(t.core.receiptSheet(sell(t, { cashReceivedCents: 12000 }), false).payment), ['Paid by=Cash', 'Cash received=120.00', 'Change=0.00'], 'exact cash is change 0, not a debt');
    done();
  });
});

test('an M-Pesa sale shows the reference the cashier typed, and no cash lines', function (done) {
  till(BUSINESS, function (t) {
    var sheet = t.core.receiptSheet(sell(t, { paymentMethod: 'mpesa_manual', referenceNote: 'QWE123XYZ' }), false);
    assert.deepStrictEqual(rowsOf(sheet.payment), ['Paid by=M-Pesa', 'Reference=QWE123XYZ']);
    assert.deepStrictEqual(rowsOf(t.core.receiptSheet(sell(t, { paymentMethod: 'mpesa_manual' }), false).payment), ['Paid by=M-Pesa']);
    done();
  });
});

test('a named customer is shown, a walk-in is not', function (done) {
  till(BUSINESS, function (t) {
    assert.ok(rowsOf(t.core.receiptSheet(sell(t, { customerName: 'Mama Njeri' }), false).meta).indexOf('Customer=Mama Njeri') >= 0);
    assert.ok(!rowsOf(t.core.receiptSheet(sell(t, {}), false).meta).some(function (r) { return /^Customer=/.test(r); }));
    done();
  });
});

test('a reprint is marked as one', function (done) {
  till(BUSINESS, function (t) {
    var receipt = sell(t, {});
    assert.strictEqual(t.core.receiptSheet(receipt, true).title, 'RECEIPT - REPRINT');
    assert.strictEqual(t.core.receiptSheet(receipt, false).title, 'RECEIPT');
    done();
  });
});

test('the cashier who rang the sale up is kept on the saved receipt, and an old receipt without one still prints', function (done) {
  till(BUSINESS, function (t) {
    var receipt = sell(t, {});
    assert.strictEqual(receipt.cashierName, 'Wanjiru');
    assert.strictEqual(t.core.history()[0].receipt.cashierName, 'Wanjiru');
    delete receipt.cashierName;
    var sheet = t.core.receiptSheet(receipt, false);
    assert.ok(!rowsOf(sheet.meta).some(function (r) { return /^Cashier=/.test(r); }));
    assert.strictEqual(sheet.lines.length, 1);
    done();
  });
});

test('shop details: missing ones are blank, a missing shop is just "Shop", and a silly paper width falls back to 58 mm', function (done) {
  till({ businessName: 'Plain Shop', currency: 'usd' }, function (t) {
    var info = t.core.shopInfo();
    assert.deepStrictEqual(info, { name: 'Plain Shop', address: '', phone: '', footer: '', currency: 'USD', paperWidthMm: 58 });
    var sheet = t.core.receiptSheet(sell(t, {}), false);
    assert.strictEqual(sheet.address, '');
    assert.strictEqual(sheet.totals[sheet.totals.length - 1].label, 'TOTAL (USD)');
    till({ businessName: 'X', paperWidthMm: 10 }, function (t2) {
      assert.strictEqual(t2.core.shopInfo().name, 'X');
    assert.strictEqual(t2.core.shopInfo().paperWidthMm, 58, 'too narrow');
      till({ businessName: 'X', paperWidthMm: 500 }, function (t3) {
        assert.strictEqual(t3.core.shopInfo().paperWidthMm, 58, 'too wide');
        till({ businessName: 'X', paperWidthMm: 58 }, function (t4) {
          assert.strictEqual(t4.core.shopInfo().paperWidthMm, 58);
          till({ businessName: 'X', paperWidthMm: 80 }, function (t5) {
            assert.strictEqual(t5.core.shopInfo().paperWidthMm, 80);
            done();
          });
        });
      });
    });
  });
});

test('a shop with no name set still prints, as just "Shop"', function (done) {
  till({ businessName: '', currency: 'KES' }, function (t) {
    assert.strictEqual(t.core.shopInfo().name, 'Shop');
    assert.strictEqual(t.core.receiptSheet(sell(t, {}), false).shopName, 'Shop');
    done();
  });
});

test('printing changes nothing: no stock, no sale, nothing queued', function (done) {
  till(BUSINESS, function (t) {
    var receipt = sell(t, {});
    var before = JSON.stringify([t.core.history().length, t.core.outbox(), t.core.searchProducts('', null, true)[0].stockQty]);
    t.core.receiptSheet(receipt, false);
    t.core.receiptSheet(receipt, true);
    assert.strictEqual(JSON.stringify([t.core.history().length, t.core.outbox(), t.core.searchProducts('', null, true)[0].stockQty]), before);
    done();
  });
});

var failed = 0;
(function run(index) {
  if (index >= tests.length) {
    if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
    console.log('Lite receipt-printing tests passed: ' + tests.length + ' tests.');
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
