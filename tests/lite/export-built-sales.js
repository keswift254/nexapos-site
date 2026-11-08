/*
 * Rings up sales with the Lite page's code and writes them, with the results they SHOULD produce worked out
 * independently here, to fixtures/lite_built_sales.json. The NexaPOS app's own test
 * (test/tool/lite_rows_roundtrip_test.dart in the mobile repo) loads that file, applies the rows through the app's real
 * sync code exactly as another device would on pulling them, and checks the app's database ends up right (sales,
 * lines, payment, and the stock it works out from the movements).
 *
 * Run: node tests/lite/export-built-sales.js   (then copy the file to the mobile repo's test/fixtures/sync/)
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var Sale = require('../../lite/lite-sale.js');

var DEVICE = 'lite-0123456789abcdef01234567';
var STAMP = '2026-11-08T10:00:00.000000Z';
var uid = (function () { var n = 0; return function () { n += 1; return '00000000-0000-4000-8000-' + ('000000000000' + n.toString(16)).slice(-12); }; }());

var context = {
  deviceId: DEVICE,
  category: { id: uid(), name: 'Drinks', status: 'active' },
  products: [], users: []
};
function common(id, extra) {
  var base = { id: id, createdAt: STAMP, updatedAt: STAMP, deletedAt: null, localRev: 1, createdByDeviceId: 'main-device', syncState: 'local_only' };
  for (var k in extra) { base[k] = extra[k]; }
  return base;
}
var soda = common(uid(), { sku: 'SKU-1', name: 'Soda 500ml', categoryId: context.category.id, imagePath: null, barcode: '6001', retailPriceCents: 6000, wholesalePriceCents: 5000, costPriceCents: 4000, stockQty: 0, reorderLevel: 5, status: 'active' });
var bread = common(uid(), { sku: 'SKU-2', name: 'Bread', categoryId: context.category.id, imagePath: null, barcode: null, retailPriceCents: 7500, wholesalePriceCents: 7000, costPriceCents: 6000, stockQty: 0, reorderLevel: 2, status: 'active' });
context.products = [soda, bread];
var cashier = common(uid(), { roleId: '00000000-0000-4000-8000-000000000003', name: 'Wanjiru', username: 'wanjiru', email: null, passwordHash: '$2a$10$irrelevantirrelevantirrelevantirrelevantirrelevan', phone: null, status: 'active' });
context.users = [cashier];
context.category = common(context.category.id, { name: 'Drinks', status: 'active' });
context.openingStock = 100; // each product starts with 100 in stock, by a purchase movement

var catalog = {};
context.products.forEach(function (p) { catalog[p.id] = { id: p.id, name: p.name, status: 'active', stockQty: 100, costPriceCents: p.costPriceCents }; });

var scenarios = [];
var rev = 1;
function ring(name, request, expected) {
  var result = Sale.build({
    cart: request.cart, products: catalog, saleType: request.saleType, paymentMethod: request.paymentMethod, discountCents: request.discountCents || 0,
    customerName: request.customerName || '', customerPhone: request.customerPhone || '', referenceNote: request.referenceNote || '', cashReceivedCents: request.cashReceivedCents || null,
    userId: cashier.id, deviceId: DEVICE, now: function () { return Date.parse('2026-11-08T10:00:00Z'); }, nextRev: rev, randomHex: function (n) { return crypto.randomBytes(n).toString('hex'); }
  });
  if (!result.ok) { throw new Error(name + ': ' + result.message); }
  rev = result.nextRev;
  scenarios.push({ name: name, changes: result.changes, expect: expected });
}

// Expected results are worked out by hand from the cart here, NOT from the builder's output.
ring('cash_two_lines', { cart: [{ productId: soda.id, name: 'Soda 500ml', unitPriceCents: 6000, quantity: 2 }, { productId: bread.id, name: 'Bread', unitPriceCents: 7500, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash', cashReceivedCents: 20000 },
  { subtotalCents: 19500, discountCents: 0, totalCents: 19500, status: 'paid', paymentMethod: 'cash', itemCount: 2, payment: null, stockSold: [[soda.id, 2], [bread.id, 1]] });
ring('cash_discount', { cart: [{ productId: soda.id, name: 'Soda 500ml', unitPriceCents: 6000, quantity: 3 }], saleType: 'retail', paymentMethod: 'cash', discountCents: 1500, customerName: 'Wanjiru K', cashReceivedCents: 20000 },
  { subtotalCents: 18000, discountCents: 1500, totalCents: 16500, status: 'paid', paymentMethod: 'cash', itemCount: 1, payment: null, stockSold: [[soda.id, 3]] });
ring('mpesa_manual', { cart: [{ productId: bread.id, name: 'Bread', unitPriceCents: 7500, quantity: 2 }], saleType: 'retail', paymentMethod: 'mpesa_manual', customerPhone: '0712345678', referenceNote: 'QWE123XYZ9' },
  { subtotalCents: 15000, discountCents: 0, totalCents: 15000, status: 'paid', paymentMethod: 'mpesa_manual', itemCount: 1, payment: { method: 'mpesa_manual', amountCents: 15000, status: 'paid', referenceNote: 'QWE123XYZ9' }, stockSold: [[bread.id, 2]] });
ring('wholesale', { cart: [{ productId: soda.id, name: 'Soda 500ml', unitPriceCents: 5000, quantity: 10 }], saleType: 'wholesale', paymentMethod: 'cash', cashReceivedCents: 50000 },
  { subtotalCents: 50000, discountCents: 0, totalCents: 50000, status: 'paid', paymentMethod: 'cash', itemCount: 1, payment: null, stockSold: [[soda.id, 10]] });
ring('manual_line', { cart: [{ productId: soda.id, name: 'Soda 500ml', unitPriceCents: 6000, quantity: 1 }, { productId: null, name: 'Delivery', unitPriceCents: 20000, quantity: 1 }], saleType: 'retail', paymentMethod: 'cash', cashReceivedCents: 30000 },
  { subtotalCents: 26000, discountCents: 0, totalCents: 26000, status: 'paid', paymentMethod: 'cash', itemCount: 2, payment: null, stockSold: [[soda.id, 1]] });

var out = path.join(__dirname, 'fixtures', 'lite_built_sales.json');
fs.writeFileSync(out, JSON.stringify({ made_by: 'tests/lite/export-built-sales.js (the Lite page\'s sale builder)', context: context, scenarios: scenarios }, null, 2) + '\n');
console.log('Wrote ' + out + ' (' + scenarios.length + ' sales).');
