/*
 * The Lite receipt: what the sheet holds (the same layout as the apps' receipt - shop, "Powered by NEXAPOS", receipt number,
 * date, cashier, items, Subtotal / Discount / TOTAL, how it was paid, sale type and status, thank-you and support lines, the
 * shop's footer, the barcode) and where the shop's details come from. The page only draws this data, on screen and on paper.
 *
 * Run: node tests/lite/print.test.js
 */
'use strict';

var assert = require('assert');
var Core = require('../../lite/lite-core.js');
var Sale = require('../../lite/lite-sale.js');
var Barcode = require('../../lite/lite-barcode.js');
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
var BUSINESS = { businessName: 'Mama Mboga', address: 'Tom Mboya St, Nairobi', phone: '0700 111 222', receiptFooter: 'Come again!', currency: 'KES', paperWidthMm: 80 };
function catalogBody(business) {
  return {
    success: true, shop_id: 7, device_id: 'x', server_time: '2026-03-07T10:00:00Z', cursor: 5,
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
function till(business, done, withBarcode) {
  var storage = fakeStorage();
  var clock = { now: NOW };
  var http = fakeServer({
    'POST register_device': function () { return { status: 201, body: { success: true, api_key: 'key-1' } }; },
    'POST join_shop': function () { return { status: 200, body: { success: true } }; },
    'GET lite_catalog': function () { return { status: 200, body: catalogBody(business) }; },
    'POST push_changes': function () { return { status: 200, body: { success: true } }; }
  });
  var core = Core.create({ baseUrl: BASE, http: http, storage: storage, bcrypt: bcrypt, sale: Sale, barcode: withBarcode === false ? null : Barcode, now: function () { return clock.now; }, randomHex: randomHex });
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
function rows(list) { return list.map(function (r) { return r.label + '=' + r.value; }); }

test('a cash sale has everything the native receipt has, in its order', function (done) {
  till(BUSINESS, function (t) {
    var receipt = sell(t, { cashReceivedCents: 20000 });
    var sheet = t.core.receiptSheet(receipt, false);
    assert.strictEqual(sheet.shopName, 'Mama Mboga');
    assert.strictEqual(sheet.poweredBy, 'Powered by NEXAPOS');
    assert.strictEqual(sheet.address, 'Tom Mboya St, Nairobi');
    assert.strictEqual(sheet.phone, '0700 111 222');
    assert.strictEqual(sheet.widthMm, 80);
    assert.strictEqual(sheet.reprint, false);
    var d = new Date(NOW);
    var time = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    assert.deepStrictEqual(rows(sheet.meta), ['Receipt #=' + receipt.saleNumber, 'Date=7 Mar 2026 ' + time, 'Cashier=Wanjiru']);
    assert.deepStrictEqual(sheet.lines, [{ name: 'Soda', quantity: 2, unit: 'KES 60.00', total: 'KES 120.00' }]);
    assert.deepStrictEqual(sheet.totals, [
      { label: 'Subtotal', value: 'KES 120.00' },
      { label: 'Discount', value: 'KES 0.00' },
      { label: 'TOTAL', value: 'KES 120.00', grand: true }
    ]);
    assert.deepStrictEqual(sheet.payment, [
      { label: 'Payment', value: 'Cash', text: true },
      { label: 'Cash received', value: 'KES 200.00' },
      { label: 'Change due', value: 'KES 80.00' },
      { label: 'Sale type', value: 'Retail', text: true },
      { label: 'Status', value: 'PAID', text: true }
    ]);
    assert.strictEqual(sheet.thanks, 'Thank you for shopping with us!');
    assert.strictEqual(sheet.support, 'Support / Installation: 0768415017');
    assert.strictEqual(sheet.footer, 'Come again!');
    done();
  });
});

test('Subtotal and Discount are always shown, like the apps; a discount is shown as a plain amount', function (done) {
  till(BUSINESS, function (t) {
    var sheet = t.core.receiptSheet(sell(t, { discountCents: 1000 }), false);
    assert.deepStrictEqual(sheet.totals, [
      { label: 'Subtotal', value: 'KES 120.00' },
      { label: 'Discount', value: 'KES 10.00' },
      { label: 'TOTAL', value: 'KES 110.00', grand: true }
    ]);
    done();
  });
});

test('cash that does not cover the sale says "Still owed"; exact cash is change 0; no cash typed shows no cash lines', function (done) {
  till(BUSINESS, function (t) {
    assert.deepStrictEqual(rows(t.core.receiptSheet(sell(t, { cashReceivedCents: 10000 }), false).payment),
      ['Payment=Cash', 'Cash received=KES 100.00', 'Still owed=KES 20.00', 'Sale type=Retail', 'Status=PAID']);
    assert.deepStrictEqual(rows(t.core.receiptSheet(sell(t, { cashReceivedCents: 12000 }), false).payment),
      ['Payment=Cash', 'Cash received=KES 120.00', 'Change due=KES 0.00', 'Sale type=Retail', 'Status=PAID']);
    assert.deepStrictEqual(rows(t.core.receiptSheet(sell(t, {}), false).payment), ['Payment=Cash', 'Sale type=Retail', 'Status=PAID']);
    done();
  });
});

test('M-Pesa is called M-Pesa (the customer never sees "Paystack"), and a manual one is labelled and shows its reference', function (done) {
  till(BUSINESS, function (t) {
    var manual = t.core.receiptSheet(sell(t, { paymentMethod: 'mpesa_manual', referenceNote: 'QWE123XYZ' }), false);
    assert.deepStrictEqual(rows(manual.payment), ['Payment=M-Pesa (Manual)', 'Reference=QWE123XYZ', 'Sale type=Retail', 'Status=PAID']);
    assert.deepStrictEqual(rows(t.core.receiptSheet(sell(t, { paymentMethod: 'mpesa_manual' }), false).payment), ['Payment=M-Pesa (Manual)', 'Sale type=Retail', 'Status=PAID']);
    var online = t.core.receiptSheet({ saleId: 'x', saleNumber: 'S-1', createdAt: NOW, customerName: 'Walk-in customer', saleType: 'retail', paymentMethod: 'paystack',
      lines: [{ name: 'Soda', quantity: 1, unitPriceCents: 6000, lineTotalCents: 6000 }], subtotalCents: 6000, discountCents: 0, totalCents: 6000,
      cashReceivedCents: null, changeDueCents: null, referenceNote: 'S-1' }, false);
    assert.deepStrictEqual(rows(online.payment), ['Payment=M-Pesa', 'Sale type=Retail', 'Status=PAID'], 'the sale number is not repeated as a reference');
    done();
  });
});

test('a wholesale sale says so', function (done) {
  till(BUSINESS, function (t) {
    var sheet = t.core.receiptSheet(sell(t, { saleType: 'wholesale' }), false);
    assert.ok(rows(sheet.payment).indexOf('Sale type=Wholesale') >= 0);
    done();
  });
});

test('the date is "d MMM yyyy HH:mm" like the apps, with the day not padded', function (done) {
  till(BUSINESS, function (t) {
    var receipt = sell(t, {});
    receipt.createdAt = new Date(2026, 10, 3, 9, 4).getTime();
    assert.strictEqual(rows(t.core.receiptSheet(receipt, false).meta)[1], 'Date=3 Nov 2026 09:04');
    receipt.createdAt = new Date(2026, 11, 25, 18, 30).getTime();
    assert.strictEqual(rows(t.core.receiptSheet(receipt, false).meta)[1], 'Date=25 Dec 2026 18:30');
    done();
  });
});

test('a named customer is shown, a walk-in is not', function (done) {
  till(BUSINESS, function (t) {
    assert.ok(rows(t.core.receiptSheet(sell(t, { customerName: 'Mama Njeri' }), false).meta).indexOf('Customer=Mama Njeri') >= 0);
    assert.ok(!rows(t.core.receiptSheet(sell(t, {}), false).meta).some(function (r) { return /^Customer=/.test(r); }));
    done();
  });
});

test('a reprint is marked as one, and only a reprint', function (done) {
  till(BUSINESS, function (t) {
    var receipt = sell(t, {});
    assert.strictEqual(t.core.receiptSheet(receipt, true).reprint, true);
    assert.strictEqual(t.core.receiptSheet(receipt, false).reprint, false);
    assert.strictEqual(t.core.receiptSheet(receipt).reprint, false);
    done();
  });
});

test('the barcode is the apps\' number for this receipt, and is left empty when no barcode code is available', function (done) {
  till(BUSINESS, function (t) {
    var receipt = sell(t, {});
    var sheet = t.core.receiptSheet(receipt, false);
    assert.strictEqual(sheet.barcodeValue, Barcode.receiptBarcodeValue(receipt.saleNumber));
    assert.ok(/^\d{24}$/.test(sheet.barcodeValue));
    till(BUSINESS, function (t2) {
      assert.strictEqual(t2.core.receiptSheet(sell(t2, {}), false).barcodeValue, '', 'no barcode code, no barcode - the receipt still works');
      done();
    }, false);
  });
});

test('the cashier who rang the sale up is kept on the saved receipt, and an old receipt without one still prints', function (done) {
  till(BUSINESS, function (t) {
    var receipt = sell(t, {});
    assert.strictEqual(receipt.cashierName, 'Wanjiru');
    assert.strictEqual(t.core.history()[0].receipt.cashierName, 'Wanjiru');
    delete receipt.cashierName;
    var sheet = t.core.receiptSheet(receipt, false);
    assert.ok(!rows(sheet.meta).some(function (r) { return /^Cashier=/.test(r); }));
    assert.strictEqual(sheet.lines.length, 1);
    done();
  });
});

test('shop details: missing ones are blank, a currency other than KES is carried, and a silly paper width falls back to 58 mm', function (done) {
  till({ businessName: 'Plain Shop', currency: 'usd' }, function (t) {
    assert.deepStrictEqual(t.core.shopInfo(), { name: 'Plain Shop', address: '', phone: '', footer: '', currency: 'USD', paperWidthMm: 58 });
    var sheet = t.core.receiptSheet(sell(t, {}), false);
    assert.strictEqual(sheet.address, '');
    assert.strictEqual(sheet.footer, '');
    assert.strictEqual(sheet.totals[2].value, 'USD 120.00');
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

test('a shop with no name set still gets a receipt, as just "Shop"', function (done) {
  till({ businessName: '', currency: 'KES' }, function (t) {
    assert.strictEqual(t.core.shopInfo().name, 'Shop');
    assert.strictEqual(t.core.receiptSheet(sell(t, {}), false).shopName, 'Shop');
    done();
  });
});

test('making a receipt changes nothing: no stock, no sale, nothing queued', function (done) {
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
    console.log('Lite receipt tests passed: ' + tests.length + ' tests.');
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
