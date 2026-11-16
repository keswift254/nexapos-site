/*
 * NexaPOS Lite - the receipt barcode, the same one the apps print: a 24-digit number worked out from the receipt number
 * (SHA-256, the first 19 hex digits read as one big number, written in decimal and padded with zeros), drawn as Code 128
 * (numeric pairs, "Code C"). Plain ES5 (old iPads); checked against the app's own output in tests/lite/barcode.test.js.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NexaLiteBarcode = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- SHA-256 -------------------------------------------------------------------------------------------------------
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  /** The text as UTF-8 bytes. */
  function utf8Bytes(text) {
    var encoded = unescape(encodeURIComponent(String(text)));
    var bytes = [];
    for (var i = 0; i < encoded.length; i++) {
      bytes.push(encoded.charCodeAt(i));
    }
    return bytes;
  }

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  /** SHA-256 of a text, as 64 lower-case hex digits. */
  function sha256Hex(text) {
    var bytes = utf8Bytes(text);
    var bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) {
      bytes.push(0);
    }
    // the length as a 64-bit big-endian number (lengths here never reach 2^32 bits)
    bytes.push(0, 0, 0, 0, (bitLength >>> 24) & 255, (bitLength >>> 16) & 255, (bitLength >>> 8) & 255, bitLength & 255);

    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    for (var offset = 0; offset < bytes.length; offset += 64) {
      var i;
      for (i = 0; i < 16; i++) {
        w[i] = ((bytes[offset + i * 4] << 24) | (bytes[offset + i * 4 + 1] << 16) | (bytes[offset + i * 4 + 2] << 8) | bytes[offset + i * 4 + 3]) | 0;
      }
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    var out = '';
    for (var k = 0; k < 8; k++) {
      var hex = (h[k] >>> 0).toString(16);
      out += ('00000000' + hex).slice(-8);
    }
    return out;
  }

  // ---- the receipt's number ---------------------------------------------------------------------------------------------
  /** Hex digits read as one big number, written in decimal (no big-number type is needed: digits are multiplied by 16 in turn). */
  function hexToDecimal(hex) {
    var digits = [0]; // least significant first
    for (var i = 0; i < hex.length; i++) {
      var carry = parseInt(hex.charAt(i), 16);
      for (var j = 0; j < digits.length; j++) {
        var value = digits[j] * 16 + carry;
        digits[j] = value % 10;
        carry = Math.floor(value / 10);
      }
      while (carry > 0) {
        digits.push(carry % 10);
        carry = Math.floor(carry / 10);
      }
    }
    var text = '';
    for (var k = digits.length - 1; k >= 0; k--) {
      text += digits[k];
    }
    return text;
  }

  /** The 24 digits the apps print under the barcode for a receipt number (the same number, so a scanner reads either). */
  function receiptBarcodeValue(receiptNumber) {
    var decimal = hexToDecimal(sha256Hex(receiptNumber).substring(0, 19));
    return ('000000000000000000000000' + decimal).slice(-24);
  }

  // ---- Code 128, numeric pairs ("Code C") ---------------------------------------------------------------------------------
  // Each symbol is six runs (bar, space, bar, space, bar, space) of 1-4 modules; the stop symbol has seven.
  var PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232'
  ];
  var START_C = 105;
  var STOP = '2331112';

  /**
   * The run lengths (in modules, black first) of an all-digit, even-length text drawn as Code 128 C, as one string of
   * digits like the app's - start symbol, one symbol per pair of digits, check symbol, stop. Throws for anything else.
   */
  function code128Runs(digits) {
    var text = String(digits);
    if (!/^\d+$/.test(text) || text.length % 2 !== 0) {
      throw new Error('Only an even number of digits can be drawn as a numeric barcode.');
    }
    var runs = PATTERNS[START_C];
    var sum = START_C;
    for (var i = 0; i < text.length; i += 2) {
      var value = parseInt(text.substr(i, 2), 10);
      runs += PATTERNS[value];
      sum += (i / 2 + 1) * value;
    }
    runs += PATTERNS[sum % 103] + STOP;
    return runs;
  }

  /** The black bars of a barcode: [{x, w}] in modules, and the total width in modules (including the stop bar). */
  function barcodeBars(digits) {
    var runs = code128Runs(digits);
    var bars = [];
    var x = 0;
    for (var i = 0; i < runs.length; i++) {
      var width = parseInt(runs.charAt(i), 10);
      if (i % 2 === 0) {
        bars.push({ x: x, w: width });
      }
      x += width;
    }
    return { bars: bars, modules: x };
  }

  return { sha256Hex: sha256Hex, hexToDecimal: hexToDecimal, receiptBarcodeValue: receiptBarcodeValue, code128Runs: code128Runs, barcodeBars: barcodeBars };
}));
