/*
 * "A new version is available" for the Lite till: how the page tells that the server has a newer version than the one
 * running, and a release guard that fails when the Lite files change without the build label being bumped (otherwise
 * an iPad would never be told about that release).
 *
 * Run:    node tests/lite/update.test.js
 * Record: node tests/lite/update.test.js --record      (after bumping the build label in lite/index.html)
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var Core = require('../../lite/lite-core.js');

var LITE = path.join(__dirname, '..', '..', 'lite');
var MANIFEST = path.join(__dirname, 'fixtures', 'lite-build.json');
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function page(build, scripts, order) {
  var meta = order === 'content-first'
    ? '<meta content="' + build + '" name="lite-build">'
    : '<meta name="lite-build" content="' + build + '">';
  var tags = scripts.map(function (s) { return '<script src="' + s + '"></script>'; }).join('\n');
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' + meta + '</head><body><div>till</div>' + tags + '</body></html>';
}

test('a page declares its build in a meta tag, whichever way round the attributes are written', function () {
  assert.strictEqual(Core.pageBuild(page('2026-11-12.1', [])), '2026-11-12.1');
  assert.strictEqual(Core.pageBuild(page('2026-11-12.1', [], 'content-first')), '2026-11-12.1');
  assert.strictEqual(Core.pageBuild("<meta name='lite-build' content='x y'>"), 'x y', 'single quotes too');
  assert.strictEqual(Core.pageBuild('<META NAME="lite-build" CONTENT="UP">'), 'UP', 'upper case too');
  assert.strictEqual(Core.pageBuild('<meta name="robots" content="noindex">'), null, 'other meta tags are not it');
  assert.strictEqual(Core.pageBuild('<html>an error page</html>'), null);
  assert.strictEqual(Core.pageBuild(''), null);
  assert.strictEqual(Core.pageBuild(null), null);
  assert.strictEqual(Core.pageBuild(undefined), null);
});

test('the signature is the build plus each script\'s version, in a fixed order', function () {
  var a = Core.pageSignature(page('B1', ['lite.js?v=3', 'lite-core.js?v=4']));
  assert.strictEqual(a, 'B1|lite-core.js=4|lite.js=3');
  assert.strictEqual(Core.pageSignature(page('B1', ['lite-core.js?v=4', 'lite.js?v=3'])), a, 'order of the tags does not matter');
  assert.strictEqual(Core.pageSignature(page('B1', ['/lite/lite.js?v=3', 'https://nexapos.cc/lite/lite-core.js?v=4'])), a, 'the folder does not matter');
  assert.strictEqual(Core.pageSignature(page('B1', ['lite.js', 'lite-core.js?v=4'])), 'B1|lite-core.js=4|lite.js=', 'a script without a version still counts');
  assert.strictEqual(Core.pageSignature(page('B1', ['lite.js?v=3', 'lite-core.js?v=4']).replace('</body>', '<script>var inline = 1;</script></body>')), a, 'an inline script (no src) is not part of the version and does not break it');
  assert.strictEqual(Core.pageSignature('<html></html>'), null);
  assert.strictEqual(Core.pageSignature('<script src="a.js?v=1"></script>'), null, 'no build label: not a till page');
});

test('a page that is not a till page is never reported as a new version (error page, login wall, empty answer)', function () {
  var running = page('B1', ['lite.js?v=3']);
  assert.strictEqual(Core.updateAvailable(running, '<html><title>503 Service Unavailable</title></html>'), false);
  assert.strictEqual(Core.updateAvailable(running, '<html><body>Just a moment...</body></html>'), false);
  assert.strictEqual(Core.updateAvailable(running, ''), false);
  assert.strictEqual(Core.updateAvailable(running, null), false);
  assert.strictEqual(Core.updateAvailable('<html></html>', page('B2', ['lite.js?v=3'])), false, 'when what is running cannot be read, nothing is claimed');
});

test('the same version is not an update, even if the page text differs in ways that do not matter', function () {
  var running = page('B1', ['lite.js?v=3', 'lite-core.js?v=4']);
  assert.strictEqual(Core.updateAvailable(running, running), false);
  assert.strictEqual(Core.updateAvailable(running, running.replace('<div>till</div>', '<div>till</div>\n\n<!-- a comment -->')), false);
  assert.strictEqual(Core.updateAvailable(running, page('B1', ['lite-core.js?v=4', 'lite.js?v=3'], 'content-first')), false);
});

test('a new build label, or a new script version, or a new script, is an update', function () {
  var running = page('B1', ['lite.js?v=3', 'lite-core.js?v=4']);
  assert.strictEqual(Core.updateAvailable(running, page('B2', ['lite.js?v=3', 'lite-core.js?v=4'])), true, 'new build label');
  assert.strictEqual(Core.updateAvailable(running, page('B1', ['lite.js?v=4', 'lite-core.js?v=4'])), true, 'one script bumped');
  assert.strictEqual(Core.updateAvailable(running, page('B1', ['lite.js?v=3', 'lite-core.js?v=4', 'extra.js?v=1'])), true, 'a script added');
  assert.strictEqual(Core.updateAvailable(running, page('B1', ['lite.js?v=3'])), true, 'a script removed');
});

// ---- the real page and the release guard ---------------------------------------------------------------------------
function normalised(text) { return text.split('\r\n').join('\n'); }

/** One fingerprint of everything the page runs: all html/js files in lite/, the build label itself left out. */
function liteFingerprint() {
  var names = fs.readdirSync(LITE).filter(function (n) { return /\.(html|js)$/.test(n); }).sort();
  var hash = crypto.createHash('sha256');
  names.forEach(function (name) {
    var text = normalised(fs.readFileSync(path.join(LITE, name), 'utf8'));
    if (name === 'index.html') { text = text.replace(/[ \t]*<meta name="lite-build"[^>]*>\n?/, ''); }
    hash.update(name + '\0' + text + '\0');
  });
  return hash.digest('hex');
}
function indexHtml() { return fs.readFileSync(path.join(LITE, 'index.html'), 'utf8'); }

test('the real page has a build label and every script it loads carries a version', function () {
  var html = indexHtml();
  var build = Core.pageBuild(html);
  assert.ok(build && /^\d{4}-\d{2}-\d{2}\.\d+$/.test(build), 'build label like 2026-11-12.1, got: ' + build);
  var tags = html.match(/<script\b[^>]*\bsrc=[^>]*>/gi) || [];
  assert.ok(tags.length >= 5, 'the till loads its scripts');
  tags.forEach(function (tag) { assert.ok(/\.js\?v=\d+/.test(tag), 'script without ?v= : ' + tag); });
  var signature = Core.pageSignature(html);
  ['lite.js', 'lite-core.js', 'lite-sale.js', 'lite-barcode.js', 'qrcode.js', 'bcrypt.min.js'].forEach(function (name) {
    assert.ok(signature.indexOf(name + '=') > 0, name + ' is part of the version');
  });
});

test('the real page has the update bar and the version label the till code looks for', function () {
  var html = indexHtml();
  ['id="update-bar"', 'id="update-now"', 'id="update-later"', 'id="update-message"', 'id="version-label"'].forEach(function (needle) {
    assert.ok(html.indexOf(needle) > 0, 'index.html is missing ' + needle);
  });
});

test('release guard: the Lite files changed => the build label must have been bumped and recorded', function () {
  if (process.env.LITE_SKIP_GUARD === '1') { return; } // only for the mutation harness, which edits lite-core.js on purpose
  var manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  var build = Core.pageBuild(indexHtml());
  var hash = liteFingerprint();
  if (manifest.hash !== hash) {
    throw new Error('The files in lite/ changed since the last recorded release (build ' + manifest.build + '). Bump <meta name="lite-build"> in lite/index.html' +
      (build === manifest.build ? ' (it is still ' + build + ')' : '') + ', bump the ?v= of the scripts you changed, then run: node tests/lite/update.test.js --record');
  }
  assert.strictEqual(build, manifest.build, 'the recorded build and the label in index.html agree');
});

if (process.argv.indexOf('--record') >= 0) {
  var manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  var label = Core.pageBuild(indexHtml());
  var fingerprint = liteFingerprint();
  if (manifest.hash === fingerprint && manifest.build === label) {
    console.log('Nothing to record: build ' + label + ' is already recorded.');
  } else if (manifest.hash !== fingerprint && manifest.build === label) {
    console.error('The files changed but the build label is still ' + label + '. Bump <meta name="lite-build"> in lite/index.html first.');
    process.exit(1);
  } else {
    fs.writeFileSync(MANIFEST, JSON.stringify({ build: label, hash: fingerprint }, null, 2) + '\n');
    console.log('Recorded build ' + label + '.');
  }
  process.exit(0);
}

var failed = 0;
tests.forEach(function (t) {
  try {
    t.fn();
  } catch (error) {
    failed++;
    console.error('FAIL ' + t.name + '\n  ' + (error && error.message ? error.message : error));
  }
});
if (failed) { console.error(failed + ' of ' + tests.length + ' tests FAILED'); process.exit(1); }
console.log('Lite update-notice tests passed: ' + tests.length + ' tests.');
