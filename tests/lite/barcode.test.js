/*
 * The Lite receipt barcode must be the SAME barcode the apps print: the 24-digit number worked out from the receipt number
 * and the Code 128 bars. The expected values in fixtures/receipt_barcodes.json were produced by the app's own code
 * (receiptBarcodeValue and the barcode package), so a difference here means the iPad's receipt would not match.
 *
 * Run: node tests/lite/barcode.test.js
 */
'use strict';

var assert = require('assert');
var crypto = require('crypto');
var Barcode = require('../../lite/lite-barcode.js');
var golden = require('./fixtures/receipt_barcodes.json').cases;
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('SHA-256 matches the standard vectors, including a message that needs two blocks', function () {
  assert.strictEqual(Barcode.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.strictEqual(Barcode.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.strictEqual(Barcode.sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.strictEqual(Barcode.sha256Hex(new Array(1001).join('a')), crypto.createHash('sha256').update(new Array(1001).join('a')).digest('hex'));
});

test('SHA-256 agrees with the platform for many texts, including long ones and non-English letters', function () {
  var seed = 7;
  function next() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; }
  for (var i = 0; i < 300; i++) {
    var length = next() % 200;
    var text = '';
    for (var j = 0; j < length; j++) { text += String.fromCharCode(32 + next() % 95); }
    assert.strictEqual(Barcode.sha256Hex(text), crypto.createHash('sha256').update(text, 'utf8').digest('hex'), 'text of ' + length);
  }
  ['é', 'Mama Mboga ñ', '€ 100', '日本語'].forEach(function (text) {
    assert.strictEqual(Barcode.sha256Hex(text), crypto.createHash('sha256').update(text, 'utf8').digest('hex'), text);
  });
});

test('every length around the block edges is right (55, 56, 63, 64, 65 bytes)', function () {
  [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128].forEach(function (n) {
    var text = new Array(n + 1).join('x');
    assert.strictEqual(Barcode.sha256Hex(text), crypto.createHash('sha256').update(text).digest('hex'), n + ' bytes');
  });
});

test('hex to decimal is exact for numbers far beyond what a double can hold', function () {
  assert.strictEqual(Barcode.hexToDecimal('0'), '0');
  assert.strictEqual(Barcode.hexToDecimal('ff'), '255');
  assert.strictEqual(Barcode.hexToDecimal('10000'), '65536');
  assert.strictEqual(Barcode.hexToDecimal('ffffffffffffffffffff'), BigInt('0xffffffffffffffffffff').toString());
  ['0123456789abcdef012', 'fedcba9876543210fed', '7a5b1c9d3e2f4a6b8c0'].forEach(function (hex) {
    assert.strictEqual(Barcode.hexToDecimal(hex), BigInt('0x' + hex).toString(), hex);
  });
});

test('the 24-digit number is the one the app prints, for every sample receipt', function () {
  golden.filter(function (c) { return c.receipt; }).forEach(function (c) {
    assert.strictEqual(Barcode.receiptBarcodeValue(c.receipt), c.value, c.receipt);
    assert.strictEqual(c.value.length, 24);
  });
});

test('the number is always 24 digits, zero-padded when short, and never changes for the same receipt', function () {
  for (var i = 0; i < 200; i++) {
    var value = Barcode.receiptBarcodeValue('SALE-' + i);
    assert.ok(/^\d{24}$/.test(value), value);
    assert.strictEqual(Barcode.receiptBarcodeValue('SALE-' + i), value);
  }
  assert.notStrictEqual(Barcode.receiptBarcodeValue('SALE-1'), Barcode.receiptBarcodeValue('SALE-2'));
});

test('the Code 128 bars are exactly the app\'s, for the sample receipts and for every pair of digits 00 to 99', function () {
  golden.forEach(function (c) {
    assert.strictEqual(Barcode.code128Runs(c.value), c.runs, c.receipt || 'all pairs');
  });
});

test('bars: 11 modules per symbol, a 13-module stop, bars at even positions, total width adds up', function () {
  var value = golden[0].value;
  var result = Barcode.barcodeBars(value);
  var symbols = 1 + value.length / 2 + 1; // start + pairs + check
  assert.strictEqual(result.modules, symbols * 11 + 13);
  assert.strictEqual(result.bars[0].x, 0, 'starts with a bar');
  var runs = golden[0].runs;
  var total = 0;
  for (var i = 0; i < runs.length; i++) { total += Number(runs.charAt(i)); }
  assert.strictEqual(result.modules, total);
  var last = result.bars[result.bars.length - 1];
  assert.strictEqual(last.x + last.w, result.modules, 'ends with a bar');
  for (var j = 1; j < result.bars.length; j++) {
    assert.ok(result.bars[j].x >= result.bars[j - 1].x + result.bars[j - 1].w + 1, 'a space between bars');
  }
});

test('what cannot be drawn as numeric pairs is refused', function () {
  ['', 'abc', '123', '12 34', '12a4', null, undefined].forEach(function (text) {
    if (text === '') { return; }
    assert.throws(function () { Barcode.code128Runs(text); }, /even number of digits/, String(text));
  });
  assert.doesNotThrow(function () { Barcode.code128Runs('00'); });
});

test('the check symbol follows the Code 128 rule (start + position x value, modulo 103)', function () {
  // For "00": sum = 105 + 1*0 = 105 -> 105 mod 103 = 2 -> pattern 222221
  var runs = Barcode.code128Runs('00');
  assert.strictEqual(runs, '211232' + '212222' + '222221' + '2331112');
  // For "01 02": sum = 105 + 1*1 + 2*2 = 110 -> 7 -> pattern 122312
  assert.strictEqual(Barcode.code128Runs('0102'), '211232' + '222122' + '222221' + '122312' + '2331112');
});

var failed = 0;
tests.forEach(function (t) {
  try { t.fn(); } catch (error) {
    failed++;
    console.error('FAIL ' + t.name + '\n  ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n  ') : error));
  }
});
if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
console.log('Lite barcode tests passed: ' + tests.length + ' tests.');
