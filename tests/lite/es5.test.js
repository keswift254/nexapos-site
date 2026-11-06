/*
 * The Lite till must run on Safari 10 (iPad, iOS 10): no arrow functions, let/const, template strings,
 * classes, Promise, fetch, async/await, modules, or newer built-ins. This test parses every script
 * of the lite page as strict ES5 (so any newer syntax is a parse error) and scans for newer APIs, which a
 * syntax check cannot see (a missing function only fails at run time, on the iPad).
 *
 * Run: node tests/lite/es5.test.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var acorn = require('./vendor/acorn.js');

var liteDir = path.join(__dirname, '..', '..', 'lite');

// Built-ins that do not exist (or behave differently) in Safari 10, used as a global name...
var BANNED_GLOBALS = ['Promise', 'fetch', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'BigInt',
  'TextEncoder', 'TextDecoder', 'URLSearchParams', 'AbortController', 'IntersectionObserver', 'ResizeObserver',
  'BroadcastChannel', 'requestIdleCallback', 'globalThis', 'queueMicrotask', 'structuredClone'];
// ...or as a method/property after a dot.
var BANNED_MEMBERS = ['includes', 'startsWith', 'endsWith', 'padStart', 'padEnd', 'find', 'findIndex', 'assign', 'entries',
  'values', 'repeat', 'fromEntries', 'flat', 'flatMap', 'codePointAt', 'trimStart', 'trimEnd', 'finally', 'matchAll',
  'replaceAll', 'at', 'isInteger', 'isNaN', 'isFinite', 'from', 'of', 'sign', 'trunc', 'log2', 'log10', 'hypot'];

// Vendored library: parsed as ES5 like everything else. Its Promise is only reached when no callback is passed.
var VENDORED = { 'bcrypt.min.js': { allowGlobals: ['Promise'] } };

function scriptsOf(file) {
  var text = fs.readFileSync(file, 'utf8');
  if (/\.html$/i.test(file)) {
    var found = [];
    var pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    var match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1].replace(/\s+/g, '') !== '') {
        found.push({ source: match[1], label: file + ' (inline script ' + (found.length + 1) + ')' });
      }
    }
    return found;
  }
  return [{ source: text, label: file }];
}

var failures = [];
var scanned = 0;

fs.readdirSync(liteDir).forEach(function (name) {
  if (!/\.(js|html)$/i.test(name)) {
    return;
  }
  var allowGlobals = (VENDORED[name] && VENDORED[name].allowGlobals) || [];
  scriptsOf(path.join(liteDir, name)).forEach(function (script) {
    scanned += 1;
    try {
      acorn.parse(script.source, { ecmaVersion: 5, sourceType: 'script' });
    } catch (error) {
      failures.push(script.label + ': not ES5 - ' + error.message);
      return;
    }
    var previous = null;
    var tokens = acorn.tokenizer(script.source, { ecmaVersion: 5 });
    var token;
    while ((token = tokens.getToken()).type !== acorn.tokTypes.eof) {
      if (token.type === acorn.tokTypes.name) {
        var word = script.source.slice(token.start, token.end);
        var afterDot = previous && previous.type === acorn.tokTypes.dot;
        if (afterDot && BANNED_MEMBERS.indexOf(word) >= 0) {
          failures.push(script.label + ': ".' + word + '" is not available in old Safari (offset ' + token.start + ')');
        }
        if (!afterDot && BANNED_GLOBALS.indexOf(word) >= 0 && allowGlobals.indexOf(word) < 0) {
          failures.push(script.label + ': "' + word + '" is not available in old Safari (offset ' + token.start + ')');
        }
      }
      previous = token;
    }
  });
});

if (scanned === 0) {
  failures.push('Found no scripts to check in ' + liteDir);
}

// The checker itself must work: prove it rejects what it is meant to reject.
var shouldReject = ['var f = () => 1;', 'let a = 1;', 'const b = 2;', 'var s = `x`;', 'class A {}', 'async function f() {}', 'import x from "y";'];
shouldReject.forEach(function (code) {
  try {
    acorn.parse(code, { ecmaVersion: 5, sourceType: 'script' });
    failures.push('The ES5 checker accepted: ' + code);
  } catch (error) {
    // expected
  }
});

if (failures.length) {
  console.error('ES5 CHECK FAILED:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('ES5 check passed: ' + scanned + ' scripts parse as strict ES5 and use no newer built-ins.');
