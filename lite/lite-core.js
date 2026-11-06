/*
 * NexaPOS Lite till - core logic.
 *
 * Written for old browsers (an iPad on iOS 10): plain ES5 only - no arrow functions, no let/const, no
 * template strings, no Promise, no fetch, no modules. tests/lite/es5.test.js refuses anything newer.
 *
 * Nothing here touches the page. The network, the storage, the password check and the clock are all handed
 * in, so the same code runs in the browser and in the tests.
 *
 * What this stage does: join a shop with an invite code, keep a copy of the shop's catalog (products,
 * categories, cashiers) up to date from the platform's lite_catalog endpoint, and let a cashier log in by
 * checking their password against the bcrypt hash the app stored - exactly what the app does.
 * It never writes anything to the shop.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NexaLiteCore = factory();
  }
}(this, function () {
  'use strict';

  var STORE_KEY = 'nexapos-lite-v1';
  var MAX_FAILED_LOGINS = 5;
  var LOCKOUT_MS = 30 * 1000;
  var ROLE_NAMES = {
    '00000000-0000-4000-8000-000000000001': 'Admin',
    '00000000-0000-4000-8000-000000000002': 'Manager',
    '00000000-0000-4000-8000-000000000003': 'Cashier'
  };

  /** Everything a result callback needs to tell the person what went wrong, in plain words. */
  function problem(code, message) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  function randomHex(bytes) {
    var out = '';
    var cryptoObject = typeof window !== 'undefined' ? (window.crypto || window.msCrypto) : null;
    if (cryptoObject && cryptoObject.getRandomValues && typeof Uint8Array !== 'undefined') {
      var array = new Uint8Array(bytes);
      cryptoObject.getRandomValues(array);
      for (var i = 0; i < array.length; i++) {
        out += (array[i] < 16 ? '0' : '') + array[i].toString(16);
      }
      return out;
    }
    for (var j = 0; j < bytes; j++) {
      var value = Math.floor(Math.random() * 256);
      out += (value < 16 ? '0' : '') + value.toString(16);
    }
    return out;
  }

  /** 125050 -> "1,250.50" (no Intl: old browsers vary). */
  function formatCents(cents) {
    var negative = cents < 0;
    var absolute = Math.abs(Math.round(cents));
    var whole = Math.floor(absolute / 100);
    var fraction = absolute % 100;
    var text = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (negative ? '-' : '') + text + '.' + (fraction < 10 ? '0' : '') + fraction;
  }

  function parseServerTime(text) {
    var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(text || '');
    if (!match) {
      return null;
    }
    return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
  }

  /**
   * options: baseUrl, http(request, cb), storage {getItem,setItem,removeItem}, bcrypt {compare}, now(), randomHex(bytes)
   * http: request = {method, url, headers, body}; cb(error, {status, text})
   */
  function create(options) {
    var baseUrl = String(options.baseUrl).replace(/\/+$/, '');
    var now = options.now || function () { return new Date().getTime(); };
    var random = options.randomHex || randomHex;
    var storage = options.storage;
    var storageOk = true;
    var memoryOnly = null;
    var session = null;
    var state = load();

    // ---- storage ----------------------------------------------------------------------------------------
    function blank() {
      return { version: 1, device: null, joined: false, catalog: null, fetchedAt: 0, serverOffset: 0, failedLogins: 0, lockedUntil: 0, revoked: false };
    }

    function load() {
      try {
        var text = storage ? storage.getItem(STORE_KEY) : null;
        if (text) {
          var parsed = JSON.parse(text);
          if (parsed && parsed.version === 1) {
            return parsed;
          }
        }
      } catch (e) {
        storageOk = false;
      }
      return blank();
    }

    function save() {
      var text = JSON.stringify(state);
      try {
        if (!storage) {
          throw new Error('no storage');
        }
        storage.setItem(STORE_KEY, text);
        storageOk = true;
      } catch (e) {
        // Private browsing or a full store: carry on in memory, and say so.
        storageOk = false;
        memoryOnly = text;
      }
    }

    // ---- network ----------------------------------------------------------------------------------------
    function call(method, action, body, cb) {
      var headers = { 'Accept': 'application/json' };
      if (body !== null) {
        headers['Content-Type'] = 'application/json';
      }
      if (state.device && state.device.apiKey) {
        headers['Authorization'] = 'Bearer ' + state.device.apiKey;
      }
      options.http({
        method: method,
        url: baseUrl + '?action=' + action,
        headers: headers,
        body: body === null ? null : JSON.stringify(body)
      }, function (error, response) {
        if (error) {
          cb(problem('offline', 'Could not reach the server. Check the internet connection and try again.'));
          return;
        }
        var parsed = null;
        try {
          parsed = JSON.parse(response.text);
        } catch (e) {
          parsed = null;
        }
        if (response.status >= 200 && response.status < 300 && parsed) {
          cb(null, parsed, response.status);
          return;
        }
        var message = parsed && parsed.message ? String(parsed.message) : 'The server could not do that (error ' + response.status + ').';
        var code = response.status === 401 ? 'unauthorized' : (response.status === 403 ? 'forbidden' : 'server');
        cb(problem(code, message), parsed, response.status);
      });
    }

    // ---- joining ----------------------------------------------------------------------------------------
    function join(inviteCode, deviceLabel, cb) {
      var code = String(inviteCode || '').replace(/\s+/g, '');
      if (!code) {
        cb(problem('input', 'Enter the invite code from the main device.'));
        return;
      }
      var label = String(deviceLabel || '').replace(/^\s+|\s+$/g, '') || 'Lite till (old iPad)';

      if (!state.device) {
        state.device = { id: 'lite-' + random(12), label: label, secret: random(16), apiKey: null };
        save();
      }
      if (state.device.apiKey) {
        joinShop();
        return;
      }
      call('POST', 'register_device', {
        device_id: state.device.id,
        device_label: state.device.label,
        registration_secret: state.device.secret,
        channel: 'lite'
      }, function (error, body) {
        if (error) {
          cb(error);
          return;
        }
        if (!body.api_key) {
          cb(problem('server', 'The server did not give this device a key.'));
          return;
        }
        state.device.apiKey = String(body.api_key);
        save();
        joinShop();
      });

      function joinShop() {
        call('POST', 'join_shop', { invite_code: code }, function (error) {
          if (error) {
            if (error.code === 'unauthorized') {
              // The key we hold is not valid any more: start over from a clean device.
              state = blank();
              save();
            }
            cb(error);
            return;
          }
          state.joined = true;
          state.revoked = false;
          save();
          refresh(function (refreshError) {
            cb(refreshError, getStatus());
          });
        });
      }
    }

    // ---- the catalog -------------------------------------------------------------------------------------
    function refresh(cb) {
      if (!state.device || !state.device.apiKey || !state.joined) {
        cb(problem('input', 'This device has not joined a shop yet.'));
        return;
      }
      var startedAt = now();
      call('GET', 'lite_catalog', null, function (error, body) {
        if (error) {
          if (error.code === 'unauthorized' || error.code === 'forbidden') {
            state.revoked = true;
            save();
            cb(problem(error.code, 'This device is no longer allowed to use the shop. Ask the owner to check Connected devices, or forget it here and join again.'));
            return;
          }
          cb(error);
          return;
        }
        var serverMs = parseServerTime(body.server_time);
        state.serverOffset = serverMs === null ? 0 : serverMs - startedAt;
        state.catalog = {
          shopId: body.shop_id,
          business: body.business || null,
          categories: body.categories || [],
          products: body.products || [],
          users: body.users || [],
          roles: body.roles || [],
          license: body.license || null,
          cursor: body.cursor || 0
        };
        state.fetchedAt = now();
        state.revoked = false;
        save();
        cb(null, getStatus());
      });
    }

    // ---- logging in --------------------------------------------------------------------------------------
    function login(username, password, cb) {
      var name = String(username || '').replace(/^\s+|\s+$/g, '');
      if (!name) {
        cb(problem('input', 'Enter your username.'));
        return;
      }
      if (!password) {
        cb(problem('input', 'Enter your password.'));
        return;
      }
      if (!state.catalog) {
        cb(problem('input', 'The shop\'s cashiers have not been loaded yet. Connect to the internet and refresh.'));
        return;
      }
      if (state.lockedUntil > now()) {
        var seconds = Math.ceil((state.lockedUntil - now()) / 1000);
        cb(problem('locked', 'Too many wrong passwords. Try again in ' + seconds + ' seconds.'));
        return;
      }
      var users = state.catalog.users;
      var found = null;
      for (var i = 0; i < users.length; i++) {
        if (users[i].username === name) {
          found = users[i];
          break;
        }
      }
      if (!found) {
        failedAttempt(cb);
        return;
      }
      if (found.status !== 'active') {
        cb(problem('disabled', 'This account is not active. Ask the owner.'));
        return;
      }
      options.bcrypt.compare(String(password), found.passwordHash, function (error, matches) {
        if (error || !matches) {
          failedAttempt(cb);
          return;
        }
        state.failedLogins = 0;
        state.lockedUntil = 0;
        save();
        session = {
          id: found.id,
          name: found.name,
          username: found.username,
          roleId: found.roleId,
          roleName: ROLE_NAMES[found.roleId] || 'Staff'
        };
        cb(null, session);
      });
    }

    function failedAttempt(cb) {
      state.failedLogins += 1;
      if (state.failedLogins >= MAX_FAILED_LOGINS) {
        state.failedLogins = 0;
        state.lockedUntil = now() + LOCKOUT_MS;
        save();
        cb(problem('locked', 'Too many wrong passwords. Try again in ' + (LOCKOUT_MS / 1000) + ' seconds.'));
        return;
      }
      save();
      cb(problem('credentials', 'Wrong username or password.'));
    }

    function logout() {
      session = null;
    }

    // ---- reading the catalog -----------------------------------------------------------------------------
    function searchProducts(query, categoryId, includeInactive) {
      var catalog = state.catalog;
      if (!catalog) {
        return [];
      }
      var needle = String(query || '').toLowerCase().replace(/^\s+|\s+$/g, '');
      var out = [];
      for (var i = 0; i < catalog.products.length; i++) {
        var p = catalog.products[i];
        if (!includeInactive && p.status !== 'active') {
          continue;
        }
        if (categoryId && p.categoryId !== categoryId) {
          continue;
        }
        if (needle && (p.name || '').toLowerCase().indexOf(needle) < 0
            && (p.sku || '').toLowerCase().indexOf(needle) < 0
            && (p.barcode || '').toLowerCase().indexOf(needle) < 0) {
          continue;
        }
        out.push(p);
      }
      return out;
    }

    function categoryName(id) {
      var list = state.catalog ? state.catalog.categories : [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          return list[i].name;
        }
      }
      return '';
    }

    /** Whether the shop's licence lets the till work, by the SERVER's clock (a wrong iPad clock must not matter). */
    function licenseStatus() {
      var license = state.catalog ? state.catalog.license : null;
      if (!license || !license.state) {
        return { state: 'unknown', ok: true, message: 'The shop\'s licence has not been checked yet.' };
      }
      if (license.state === 'revoked') {
        return { state: 'revoked', ok: false, message: 'This shop\'s licence has been revoked.' };
      }
      if (license.never_expires === true) {
        return { state: 'ok', ok: true, message: 'Licence active.' };
      }
      var until = parseServerTime(license.valid_until);
      var serverNow = now() + (state.serverOffset || 0);
      if (until !== null && until < serverNow) {
        return { state: 'expired', ok: false, message: 'This shop\'s licence has expired. Ask the owner to renew it.' };
      }
      if (license.state !== 'active') {
        return { state: license.state, ok: false, message: 'This shop\'s licence is not active.' };
      }
      var days = until === null ? null : Math.ceil((until - serverNow) / 86400000);
      return { state: 'ok', ok: true, daysLeft: days, message: days === null ? 'Licence active.' : 'Licence active, ' + days + ' day' + (days === 1 ? '' : 's') + ' left.' };
    }

    function getStatus() {
      var catalog = state.catalog;
      return {
        hasDevice: !!state.device,
        joined: !!state.joined,
        revoked: !!state.revoked,
        hasCatalog: !!catalog,
        shopName: catalog && catalog.business ? catalog.business.businessName : '',
        currency: catalog && catalog.business ? catalog.business.currency : 'KES',
        fetchedAt: state.fetchedAt,
        productCount: catalog ? catalog.products.length : 0,
        license: licenseStatus(),
        storageOk: storageOk,
        deviceLabel: state.device ? state.device.label : ''
      };
    }

    function forget() {
      session = null;
      state = blank();
      memoryOnly = null;
      try {
        if (storage) {
          storage.removeItem(STORE_KEY);
        }
      } catch (e) {
        storageOk = false;
      }
    }

    return {
      join: join,
      refresh: refresh,
      login: login,
      logout: logout,
      currentUser: function () { return session; },
      searchProducts: searchProducts,
      categoryName: categoryName,
      categories: function () { return state.catalog ? state.catalog.categories : []; },
      getStatus: getStatus,
      forget: forget,
      formatCents: formatCents,
      _memoryOnly: function () { return memoryOnly; }
    };
  }

  return { create: create, formatCents: formatCents, randomHex: randomHex, STORE_KEY: STORE_KEY };
}));
