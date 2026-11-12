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
 * Selling: a sale is built by lite-sale.js (a port of the app's checkout), saved on the iPad FIRST (the outbox), and
 * sent to the shop when the network allows. It is never lost: no internet means it waits and retries; if the server
 * refuses it, it stays on the iPad marked "not recorded" for the owner, never silently dropped.
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

  /**
   * What a cashier typed as an amount, in cents: "1250", "1,250.50", "12.5" -> 125000, 125050, 1250.
   * Anything else (letters, negatives, more than two decimals, above 1,000,000) gives null - never a guess.
   */
  function parseCents(text) {
    var cleaned = String(text === undefined || text === null ? '' : text).replace(/[,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
      return null;
    }
    var parts = cleaned.split('.');
    var cents = parseInt(parts[0], 10) * 100 + (parts[1] ? parseInt((parts[1] + '0').substring(0, 2), 10) : 0);
    return cents > 100000000 ? null : cents;
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
      return { version: 1, device: null, joined: false, catalog: null, fetchedAt: 0, serverOffset: 0, failedLogins: 0, lockedUntil: 0, revoked: false, nextRev: 1, outbox: [], history: [], online: [], notices: [], held: [] };
    }

    function load() {
      try {
        var text = storage ? storage.getItem(STORE_KEY) : null;
        if (text) {
          var parsed = JSON.parse(text);
          if (parsed && parsed.version === 1) {
            parsed.nextRev = parsed.nextRev || 1;
            parsed.outbox = parsed.outbox || [];
            parsed.history = parsed.history || [];
            parsed.online = parsed.online || [];
            parsed.notices = parsed.notices || [];
            parsed.held = parsed.held || [];
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
        applyPendingToCatalog();
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

    /**
     * Paying on the iPad itself takes the page away to Paystack and back, which reloads the till and so logs the
     * cashier out. This gives the login back, and ONLY for the cashier who started a payment that is still waiting
     * (a payment started by someone else, an unknown or already settled one, or a cashier who has since been
     * switched off gets nothing). The page decides how long such a hand-back stays valid.
     */
    function restoreSession(userId, saleId) {
      if (!state.joined || !state.catalog || state.revoked) {
        return null;
      }
      var item = findOnline(saleId);
      if (!item) {
        return null;
      }
      var saleUser = null;
      for (var i = 0; i < item.original.length; i++) {
        if (item.original[i].table_name === 'sales') {
          saleUser = item.original[i].payload.userId;
        }
      }
      if (!userId || saleUser !== userId) {
        return null;
      }
      var users = state.catalog.users;
      for (var u = 0; u < users.length; u++) {
        if (users[u].id === userId && users[u].status === 'active') {
          session = {
            id: users[u].id,
            name: users[u].name,
            username: users[u].username,
            roleId: users[u].roleId,
            roleName: ROLE_NAMES[users[u].roleId] || 'Staff'
          };
          return session;
        }
      }
      return null;
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

    // ---- selling -----------------------------------------------------------------------------------------
    function productMap() {
      var map = {};
      var list = state.catalog ? state.catalog.products : [];
      for (var i = 0; i < list.length; i++) {
        map[list[i].id] = list[i];
      }
      return map;
    }

    /** Why selling is not possible right now, or null. */
    function sellBlock() {
      if (!session) {
        return 'Log in first.';
      }
      if (!state.joined || !state.catalog) {
        return 'This iPad has not loaded the shop yet.';
      }
      if (state.revoked) {
        return 'This iPad is no longer allowed to use the shop.';
      }
      var license = licenseStatus();
      if (!license.ok) {
        return license.message;
      }
      return null;
    }

    /** The unsent sales are real sales the shop's server has not seen: they still take stock out. */
    function applyPendingToCatalog() {
      var map = productMap();
      for (var i = 0; i < state.outbox.length; i++) {
        if (state.outbox[i].status !== 'pending') {
          continue;
        }
        var changes = state.outbox[i].changes;
        for (var j = 0; j < changes.length; j++) {
          if (changes[j].table_name === 'stock_movements' && map[changes[j].payload.productId]) {
            map[changes[j].payload.productId].stockQty += changes[j].payload.quantity;
          }
        }
      }
    }

    function historyEntry(saleId) {
      for (var i = 0; i < state.history.length; i++) {
        if (state.history[i].receipt.saleId === saleId) {
          return state.history[i];
        }
      }
      return null;
    }

    /**
     * request: {cart, saleType, paymentMethod, discountCents, customerName, customerPhone, referenceNote, cashReceivedCents}
     * -> {ok:true, receipt} | {ok:false, message}. Saved on the iPad before anything is sent.
     */
    function sell(request) {
      var blocked = sellBlock();
      if (blocked) {
        return { ok: false, message: blocked };
      }
      var built = options.sale.build({
        cart: request.cart,
        products: productMap(),
        saleType: request.saleType,
        paymentMethod: request.paymentMethod,
        discountCents: request.discountCents,
        customerName: request.customerName,
        customerPhone: request.customerPhone,
        referenceNote: request.referenceNote,
        cashReceivedCents: request.cashReceivedCents,
        userId: session.id,
        deviceId: state.device.id,
        now: now,
        nextRev: state.nextRev,
        randomHex: random
      });
      if (!built.ok) {
        return built;
      }
      built.receipt.cashierName = session.name;
      commitBuilt(built, null);
      return { ok: true, receipt: built.receipt };
    }

    /** Saves a built sale on the iPad (outbox, history, stock). Shared by cash/M-Pesa sales and online ones. */
    function commitBuilt(built, onlineInfo) {
      state.nextRev = built.nextRev;
      state.outbox.push({ id: built.receipt.saleId, changes: built.changes, receipt: built.receipt, createdAt: now(), attempts: 0, status: 'pending', error: null, kind: 'sale' });
      state.history.unshift({ receipt: built.receipt, status: 'queued', error: null, payment: onlineInfo ? 'awaiting' : null });
      if (state.history.length > 100) {
        state.history.length = 100;
      }
      adjustStock(built.changes);
      if (onlineInfo) {
        onlineInfo.original = built.changes;
        onlineInfo.receipt = built.receipt;
        state.online.push(onlineInfo);
      }
      save();
    }

    /** Moves the iPad's own stock figures by the stock movements of a batch (a sale takes out, a return puts back). */
    function adjustStock(changes) {
      var map = productMap();
      for (var i = 0; i < changes.length; i++) {
        if (changes[i].table_name === 'stock_movements' && map[changes[i].payload.productId]) {
          map[changes[i].payload.productId].stockQty += changes[i].payload.quantity;
        }
      }
    }

    // ---- online (Paystack) payments -----------------------------------------------------------------------
    function currencyCode() {
      var business = state.catalog ? state.catalog.business : null;
      return business && business.currency ? String(business.currency).toUpperCase() : 'KES';
    }

    // ---- today's totals on this iPad ----------------------------------------------------------------------------
    var HISTORY_LIMIT = 100;

    /**
     * What this iPad sold today (since midnight, the iPad's own clock), from the sales it remembers: finished sales only -
     * an online payment still waiting, a cancelled one, and sales the shop refused or the owner removed are left out.
     * complete is false when the iPad may already have forgotten some of today's sales (it keeps the latest 100).
     */
    function todaySummary() {
      var start = new Date(now());
      start.setHours(0, 0, 0, 0);
      var from = start.getTime();
      var out = { sales: 0, items: 0, totalCents: 0, cashCents: 0, mpesaCents: 0, onlineCents: 0, complete: true };
      for (var i = 0; i < state.history.length; i++) {
        var entry = state.history[i];
        var receipt = entry.receipt;
        if (receipt.createdAt < from) {
          continue;
        }
        if ((entry.status !== 'queued' && entry.status !== 'sent') || entry.payment === 'awaiting' || entry.payment === 'cancelled') {
          continue;
        }
        out.sales += 1;
        out.totalCents += receipt.totalCents;
        for (var j = 0; j < receipt.lines.length; j++) {
          out.items += receipt.lines[j].quantity;
        }
        if (receipt.paymentMethod === 'cash') {
          out.cashCents += receipt.totalCents;
        } else if (receipt.paymentMethod === 'paystack') {
          out.onlineCents += receipt.totalCents;
        } else {
          out.mpesaCents += receipt.totalCents;
        }
      }
      var oldest = state.history.length > 0 ? state.history[state.history.length - 1].receipt.createdAt : 0;
      out.complete = state.history.length < HISTORY_LIMIT || oldest < from;
      return out;
    }

    // ---- printing a receipt -------------------------------------------------------------------------------------
    /** The shop's details for the top and bottom of a receipt (from the shop data the iPad already has). */
    function shopInfo() {
      var business = state.catalog && state.catalog.business ? state.catalog.business : {};
      var width = Number(business.paperWidthMm);
      return {
        name: business.businessName ? String(business.businessName) : 'Shop',
        address: business.address ? String(business.address) : '',
        phone: business.phone ? String(business.phone) : '',
        footer: business.receiptFooter ? String(business.receiptFooter) : '',
        currency: currencyCode(),
        paperWidthMm: width >= 40 && width <= 120 ? width : 58
      };
    }

    function two(n) {
      return (n < 10 ? '0' : '') + n;
    }

    /** What goes on the printed receipt, as plain data (the page only has to draw it). A reprint says so at the top. */
    function receiptSheet(receipt, reprint) {
      var shop = shopInfo();
      var d = new Date(receipt.createdAt);
      var meta = [
        { label: 'Receipt #', value: receipt.saleNumber },
        { label: 'Date', value: two(d.getDate()) + '/' + two(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) }
      ];
      if (receipt.cashierName) {
        meta.push({ label: 'Cashier', value: receipt.cashierName });
      }
      if (receipt.customerName && receipt.customerName !== 'Walk-in customer') {
        meta.push({ label: 'Customer', value: receipt.customerName });
      }
      var lines = [];
      for (var i = 0; i < receipt.lines.length; i++) {
        var line = receipt.lines[i];
        lines.push({ name: line.name, detail: line.quantity + ' x ' + formatCents(line.unitPriceCents), total: formatCents(line.lineTotalCents) });
      }
      var totals = [];
      if (receipt.discountCents > 0) {
        totals.push({ label: 'Subtotal', value: formatCents(receipt.subtotalCents) });
        totals.push({ label: 'Discount', value: '-' + formatCents(receipt.discountCents) });
      }
      totals.push({ label: 'TOTAL (' + shop.currency + ')', value: formatCents(receipt.totalCents), grand: true });
      var payment = [];
      payment.push({ label: 'Paid by', value: receipt.paymentMethod === 'cash' ? 'Cash' : (receipt.paymentMethod === 'paystack' ? 'Online (Paystack)' : 'M-Pesa') });
      if (receipt.paymentMethod !== 'cash' && receipt.paymentMethod !== 'paystack' && receipt.referenceNote) {
        payment.push({ label: 'Reference', value: receipt.referenceNote });
      }
      if (receipt.paymentMethod === 'cash' && receipt.cashReceivedCents !== null && receipt.cashReceivedCents !== undefined) {
        payment.push({ label: 'Cash received', value: formatCents(receipt.cashReceivedCents) });
        if (receipt.changeDueCents >= 0) {
          payment.push({ label: 'Change', value: formatCents(receipt.changeDueCents) });
        } else {
          payment.push({ label: 'Balance owed', value: formatCents(-receipt.changeDueCents) });
        }
      }
      return {
        widthMm: shop.paperWidthMm,
        shopName: shop.name,
        address: shop.address,
        phone: shop.phone,
        footer: shop.footer,
        title: reprint ? 'RECEIPT - REPRINT' : 'RECEIPT',
        meta: meta,
        lines: lines,
        totals: totals,
        payment: payment
      };
    }

    function addNotice(kind, text) {
      state.notices.unshift({ id: random(6), kind: kind, text: text, at: now() });
      if (state.notices.length > 20) {
        state.notices.length = 20;
      }
    }

    /** What an online sale was (items, type, discount), kept with it so a declined prompt can be sent again. */
    function rememberRequest(request) {
      var cart = [];
      for (var i = 0; i < request.cart.length; i++) {
        var line = request.cart[i];
        cart.push({ productId: line.productId, name: line.name, unitPriceCents: line.unitPriceCents, quantity: line.quantity });
      }
      return { cart: cart, saleType: request.saleType, discountCents: request.discountCents || 0, customerName: request.customerName || '' };
    }

    /**
     * Starts an online payment, in the app's order: Paystack is asked FIRST (it needs the internet), and only when it
     * has accepted the payment is the sale recorded as pending (stock reserved). Nothing is recorded if Paystack
     * does not accept it. cb(error) or cb(null, {receipt, authorizationUrl, reference}).
     *
     * Two ways to collect: Paystack's payment page (a link/QR the customer opens), or - when request.mpesaPhone is
     * given - an M-Pesa PIN prompt sent straight to that phone by the shop's server, with no page at all (the way
     * that works on an old iPad whose browser cannot open Paystack's page). Either way the sale is pending until the
     * payment is confirmed, and the rest of the flow (check, settle, cancel) is the same.
     */
    function startOnline(request, cb) {
      var blocked = sellBlock();
      if (blocked) {
        cb(problem('blocked', blocked));
        return;
      }
      var saleNumber = options.sale.newSaleNumber(state.device.id, now(), random);
      var cashierId = session.id; // the cashier may log out (idle) while Paystack answers; the sale is still theirs
      var cashierName = session.name;
      function buildNow() {
        var result = options.sale.build({
          cart: request.cart, products: productMap(), saleType: request.saleType, paymentMethod: 'paystack',
          discountCents: request.discountCents, customerName: request.customerName, customerPhone: request.customerPhone,
          userId: cashierId, deviceId: state.device.id, now: now, nextRev: state.nextRev, randomHex: random, saleNumber: saleNumber
        });
        if (result.ok) { result.receipt.cashierName = cashierName; }
        return result;
      }
      var built = buildNow();
      if (!built.ok) {
        cb(problem('input', built.message));
        return;
      }
      var startedAtRev = state.nextRev;
      var prompt = String(request.mpesaPhone || '').replace(/^\s+|\s+$/g, '');
      var body;
      if (prompt) {
        body = { amount: built.receipt.totalCents, currency: currencyCode(), reference: saleNumber, phone: prompt };
      } else {
        body = { email: 'till@nexapos.cc', amount: built.receipt.totalCents, currency: currencyCode(), reference: saleNumber, return_to: 'lite' };
        var phone = String(request.customerPhone || '').replace(/[^0-9+]/g, '');
        if (phone) {
          body.customer_phone = phone;
        }
      }
      call('POST', prompt ? 'charge_mobile_money' : 'initialize_transaction', body, function (error, response) {
        if (error) {
          cb(error.code === 'offline'
            ? problem('offline', 'Paying online needs the internet. Check the connection, or take cash instead.')
            : error);
          return;
        }
        var data = response && response.data ? response.data : null;
        if (prompt) {
          var asked = data ? String(data.status || '') : '';
          if (!response || response.status !== true || (asked !== 'pay_offline' && asked !== 'pending' && asked !== 'success')) {
            cb(problem('server', 'The M-Pesa prompt could not be sent. Nothing was charged. Check the number and try again.'));
            return;
          }
        } else if (!response || response.status !== true || !data || !data.authorization_url) {
          cb(problem('server', 'The payment service did not give a payment page. Nothing was charged. Try again.'));
          return;
        }
        // Something else may have used revision numbers while Paystack was answering: build again on the current ones.
        if (state.nextRev !== startedAtRev) {
          built = buildNow();
          if (!built.ok) {
            cb(problem('input', built.message));
            return;
          }
        }
        var link = prompt ? '' : String(data.authorization_url);
        commitBuilt(built, {
          saleId: built.receipt.saleId, saleNumber: saleNumber, amountCents: built.receipt.totalCents, currency: body.currency,
          authorizationUrl: link, viaPrompt: !!prompt, phone: prompt, ended: false, createdAt: now(),
          request: rememberRequest(request)
        });
        cb(null, { receipt: built.receipt, authorizationUrl: link, reference: saleNumber, viaPrompt: !!prompt });
      });
    }

    function findOnline(saleId) {
      for (var i = 0; i < state.online.length; i++) {
        if (state.online[i].saleId === saleId) {
          return state.online[i];
        }
      }
      return null;
    }

    /** Turns a waiting online sale into its settling batch (paid or cancelled), queued behind the sale itself. */
    function settleOnline(item, outcome) {
      if (state.online.indexOf(item) < 0) {
        return { ok: false, message: 'That payment was already settled.' };
      }
      var settled = options.sale.settle({ original: item.original, outcome: outcome, deviceId: state.device.id, now: now, nextRev: state.nextRev, randomHex: random });
      if (!settled.ok) {
        return settled;
      }
      state.nextRev = settled.nextRev;
      state.outbox.push({ id: item.saleId + ':' + outcome, changes: settled.changes, receipt: item.receipt, createdAt: now(), attempts: 0, status: 'pending', error: null, kind: 'settle-' + outcome });
      adjustStock(settled.changes.filter(function (c) { return c.table_name === 'stock_movements'; }));
      var shown = historyEntry(item.saleId);
      if (shown) {
        shown.payment = outcome;
      }
      state.online.splice(state.online.indexOf(item), 1);
      addNotice(outcome === 'paid' ? 'ok' : 'warn', outcome === 'paid'
        ? 'Payment received for sale ' + item.saleNumber + ' (' + currencyCode() + ' ' + formatCents(item.amountCents) + ').'
        : 'Sale ' + item.saleNumber + ' was cancelled and its stock put back.');
      save();
      return { ok: true };
    }

    /** Asks the server what Paystack says about one reference. cb(error) or cb(null, {paid, status}). */
    function verifyOne(item, cb) {
      call('GET', 'verify_transaction&reference=' + encodeURIComponent(item.saleNumber), null, function (error, response) {
        if (error) {
          cb(error.code === 'offline' ? error : problem(error.code, 'Could not check the payment yet.'));
          return;
        }
        var data = response && response.data ? response.data : {};
        var amountOk = Number(data.amount) === item.amountCents;
        var currencyOk = String(data.currency || '').toUpperCase() === item.currency;
        cb(null, { paid: response.status === true && String(data.status || '').toLowerCase() === 'success' && amountOk && currencyOk, status: String(data.status || ''), mismatch: String(data.status || '').toLowerCase() === 'success' && !(amountOk && currencyOk) });
      });
    }

    var checking = false;

    /**
     * Checks every online payment still waiting; a confirmed one is settled as paid. Not paid yet is NOT a failure:
     * the customer may still pay, so only the cashier cancelling ends a payment. cb(error|null, {paid, waiting}).
     */
    function checkOnline(cb) {
      cb = cb || function () {};
      if (checking) {
        cb(null, { paid: 0, waiting: state.online.length, busy: true });
        return;
      }
      var items = state.online.slice(0);
      var paid = 0;
      var stoppedBy = null;
      checking = true;
      (function next(index) {
        if (index >= items.length) {
          checking = false;
          cb(stoppedBy, { paid: paid, waiting: state.online.length });
          return;
        }
        verifyOne(items[index], function (error, result) {
          if (error) {
            stoppedBy = error;
            next(index + 1);
            return;
          }
          if (items[index].viaPrompt && /^(failed|abandoned|reversed|cancelled)$/.test(String(result.status || '').toLowerCase()) && !items[index].ended) {
            // The customer cancelled the prompt on their phone or it ran out (about 3 minutes): it will not be paid.
            // The sale still waits for the cashier to cancel it (which puts the stock back); this only says so.
            items[index].ended = true;
            save();
          }
          if (result.mismatch) {
            if (!items[index].mismatchNoticed) {
              // Said once per payment, not on every check.
              items[index].mismatchNoticed = true;
              addNotice('bad', 'Paystack reports a payment for sale ' + items[index].saleNumber + ' that does not match the amount. Tell the owner. The sale was NOT completed.');
              save();
            }
          } else if (result.paid && findOnline(items[index].saleId)) {
            if (settleOnline(items[index], 'paid').ok) {
              paid += 1;
            }
          }
          next(index + 1);
        });
      }(0));
    }

    /**
     * The cashier gives up on a waiting online payment. One last check first, so a payment that has just arrived is
     * never cancelled; with no internet it is refused (nothing can be checked), and the sale simply keeps waiting.
     */
    function cancelOnline(saleId, cb) {
      var item = findOnline(saleId);
      if (!item) {
        cb(problem('input', 'That payment is not waiting.'));
        return;
      }
      verifyOne(item, function (error, result) {
        if (error) {
          cb(problem(error.code, 'Cannot cancel until the payment can be checked. Check the internet connection, then try again.'));
          return;
        }
        if (!findOnline(saleId)) {
          // A check running at the same time has already settled it; there is nothing left to cancel.
          cb(problem('input', 'That payment was already settled.'));
          return;
        }
        if (result.paid) {
          settleOnline(item, 'paid');
          cb(null, { outcome: 'paid' });
          return;
        }
        if (result.mismatch) {
          cb(problem('input', 'Paystack shows a payment for this sale that does not match its amount, so it cannot be cancelled here. Tell the owner.'));
          return;
        }
        var cancelled = settleOnline(item, 'cancelled');
        if (!cancelled.ok) {
          cb(problem('input', cancelled.message));
          return;
        }
        cb(null, { outcome: 'cancelled' });
      });
    }

    /**
     * The customer did not approve an M-Pesa prompt (it was declined or ran out): send it again in one step.
     * Paystack wants a fresh reference for a fresh prompt, so the declined sale is cancelled (after the usual last
     * check - if the customer HAS paid in the meantime that is what happens, and no second prompt is sent) and the
     * same items are rung up again with a new prompt to [phone] (a corrected number is fine).
     * cb(error) | cb(null, {outcome:'paid', saleId}) | cb(null, {outcome:'started', started}) |
     * cb(null, {outcome:'restart-failed', message, request}) - the old sale is cancelled but the new prompt could
     * not be sent; request lets the screen put the cart back so nothing has to be typed again.
     */
    function retryPrompt(saleId, phone, cb) {
      var item = findOnline(saleId);
      if (!item || !item.viaPrompt) {
        cb(problem('input', 'That is not an M-Pesa prompt that is waiting.'));
        return;
      }
      if (!item.ended) {
        cb(problem('input', 'The customer can still approve the first prompt. Wait for it to end, or cancel it.'));
        return;
      }
      if (!item.request) {
        cb(problem('input', 'This sale cannot be repeated automatically. Cancel it and ring the sale up again.'));
        return;
      }
      var request = item.request;
      cancelOnline(saleId, function (error, outcome) {
        if (error) {
          cb(error);
          return;
        }
        if (outcome.outcome === 'paid') {
          cb(null, { outcome: 'paid', saleId: saleId });
          return;
        }
        startOnline({
          cart: request.cart, saleType: request.saleType, discountCents: request.discountCents,
          customerName: request.customerName, customerPhone: phone, mpesaPhone: phone
        }, function (startError, started) {
          if (startError) {
            cb(null, { outcome: 'restart-failed', message: startError.message, request: request });
            return;
          }
          cb(null, { outcome: 'started', started: started });
        });
      });
    }

    // ---- held sales: a sale set aside to serve someone else first ------------------------------------------------
    // Like the app's: kept only on this iPad (never sent to the shop), takes no stock and records no payment. It is a
    // saved cart - exactly what the screen had (items, sale type, discount, payment choice, number, cash typed) - so it
    // survives a reload and a log out, and is shown to whoever logs in next.
    var MAX_HELD = 50;

    /** The screen's cart, checked and trimmed to just what is kept; null when there is nothing sensible to hold. */
    function cleanDraft(draft) {
      if (!draft || typeof draft !== 'object' || !draft.cart || typeof draft.cart.length !== 'number' || draft.cart.length < 1 || draft.cart.length > 200) {
        return null;
      }
      var cart = [];
      for (var i = 0; i < draft.cart.length; i++) {
        var line = draft.cart[i];
        var qty = line ? Number(line.qty) : NaN;
        if (!line || typeof line.name !== 'string' || line.name === '' || !(qty >= 1) || qty > 100000 || Math.floor(qty) !== qty) {
          return null;
        }
        var productId = line.productId === null || line.productId === undefined ? null : String(line.productId);
        var kept = { productId: productId, name: line.name.slice(0, 200), qty: qty };
        if (productId === null) {
          var price = Number(line.priceCents);
          if (!(price >= 1) || Math.floor(price) !== price) {
            return null;
          }
          kept.priceCents = price;
        }
        cart.push(kept);
      }
      return {
        cart: cart,
        saleType: draft.saleType === 'wholesale' ? 'wholesale' : 'retail',
        discount: String(draft.discount || '').slice(0, 20),
        payment: draft.payment === 'paystack' ? 'paystack' : 'cash',
        phone: String(draft.phone || '').slice(0, 30),
        cashReceived: String(draft.cashReceived || '').slice(0, 20)
      };
    }

    function heldLabelUsed(label) {
      for (var i = 0; i < state.held.length; i++) {
        if (state.held[i].label === label) {
          return true;
        }
      }
      return false;
    }

    /** Sets the screen's cart aside. label is optional ("Held sale 1", 2, 3... when empty). {ok, held} | {ok:false, message}. */
    function holdSale(label, draft) {
      if (!session) {
        return { ok: false, message: 'Log in first.' };
      }
      var clean = cleanDraft(draft);
      if (!clean) {
        return { ok: false, message: 'There is nothing to hold.' };
      }
      if (state.held.length >= MAX_HELD) {
        return { ok: false, message: 'Too many held sales. Finish or throw away some first.' };
      }
      var text = String(label || '').replace(/^\s+|\s+$/g, '').slice(0, 60);
      if (!text) {
        var n = 1;
        while (heldLabelUsed('Held sale ' + n)) {
          n += 1;
        }
        text = 'Held sale ' + n;
      }
      var held = { id: random(8), label: text, heldAt: now(), heldBy: session.name, draft: clean };
      state.held.unshift(held);
      save();
      return { ok: true, held: held };
    }

    function heldList() {
      return state.held.slice(0);
    }

    /** Takes a held sale back (it leaves the list): {ok, held} | {ok:false}. */
    function resumeHeld(id) {
      for (var i = 0; i < state.held.length; i++) {
        if (state.held[i].id === id) {
          var held = state.held.splice(i, 1)[0];
          save();
          return { ok: true, held: held };
        }
      }
      return { ok: false, message: 'That held sale is not there any more.' };
    }

    function discardHeld(id) {
      for (var i = 0; i < state.held.length; i++) {
        if (state.held[i].id === id) {
          state.held.splice(i, 1);
          save();
          return { ok: true };
        }
      }
      return { ok: false, message: 'That held sale is not there any more.' };
    }

    function onlineList() {
      var out = [];
      for (var i = 0; i < state.online.length; i++) {
        out.push({ saleId: state.online[i].saleId, saleNumber: state.online[i].saleNumber, amountCents: state.online[i].amountCents, createdAt: state.online[i].createdAt, authorizationUrl: state.online[i].authorizationUrl, viaPrompt: !!state.online[i].viaPrompt, phone: state.online[i].phone || '', ended: !!state.online[i].ended, canRetry: !!(state.online[i].viaPrompt && state.online[i].ended && state.online[i].request) });
      }
      return out;
    }

    function dismissNotice(id) {
      for (var i = 0; i < state.notices.length; i++) {
        if (state.notices[i].id === id) {
          state.notices.splice(i, 1);
          save();
          return;
        }
      }
    }

    var flushing = false;
    var flushWaiting = [];

    /** A settle refused only because the sale is already in the very state it was settling to. */
    function alreadySettled(entry, message) {
      return (entry.kind === 'settle-paid' && String(message).indexOf("'paid' to 'paid'") >= 0)
        || (entry.kind === 'settle-cancelled' && String(message).indexOf("'cancelled' to 'cancelled'") >= 0);
    }

    function firstPending() {
      for (var i = 0; i < state.outbox.length; i++) {
        if (state.outbox[i].status === 'pending') {
          return state.outbox[i];
        }
      }
      return null;
    }

    function outboxSummary() {
      var pending = 0;
      var rejected = [];
      for (var i = 0; i < state.outbox.length; i++) {
        var entry = state.outbox[i];
        if (entry.status === 'pending') {
          pending += 1;
        } else if (entry.status === 'rejected') {
          rejected.push({ id: entry.id, saleNumber: entry.receipt.saleNumber, totalCents: entry.receipt.totalCents, message: entry.error, createdAt: entry.createdAt });
        }
      }
      return { pending: pending, rejected: rejected };
    }

    /**
     * Sends every waiting sale, oldest first. A sale the shop already holds is harmless to send again (the
     * server recognises it), so a lost reply cannot double-record anything. No internet or a server hiccup:
     * the sale stays and is tried again later. The server refusing it (422): it stays on the iPad as "not
     * recorded" - never deleted - and the next sale is still sent.
     */
    function flush(cb) {
      cb = cb || function () {};
      if (flushing) {
        flushWaiting.push(cb);
        return;
      }
      flushing = true;
      var sent = 0;
      var refused = 0;
      var stoppedBy = null;
      next();

      function finish() {
        flushing = false;
        var result = outboxSummary();
        result.sent = sent;
        result.refused = refused;
        var waiting = flushWaiting;
        flushWaiting = [];
        cb(stoppedBy && !sent ? stoppedBy : null, result);
        for (var w = 0; w < waiting.length; w++) {
          waiting[w](null, result);
        }
      }

      function next() {
        var entry = firstPending();
        if (!entry) {
          finish();
          return;
        }
        entry.attempts += 1;
        call('POST', 'push_changes', { changes: entry.changes }, function (error, body, status) {
          if (!error) {
            sent += 1;
            var index = state.outbox.indexOf(entry);
            if (index >= 0) {
              state.outbox.splice(index, 1);
            }
            var done = historyEntry(entry.receipt.saleId);
            if (done) {
              done.status = 'sent';
            }
            save();
            next();
            return;
          }
          if (error.code === 'unauthorized' || error.code === 'forbidden') {
            state.revoked = true;
            stoppedBy = error;
            save();
            finish();
            return;
          }
          if (error.code === 'offline' || status >= 500 || status === 429 || status === 408) {
            stoppedBy = error;
            save();
            finish();
            return;
          }
          if (alreadySettled(entry, error.message)) {
            // Another device already recorded this very outcome: nothing is missing from the books.
            sent += 1;
            state.outbox.splice(state.outbox.indexOf(entry), 1);
            save();
            next();
            return;
          }
          entry.status = 'rejected';
          entry.error = error.message;
          refused += 1;
          var shown = historyEntry(entry.receipt.saleId);
          if (shown) {
            shown.status = 'rejected';
            shown.error = error.message;
          }
          save();
          next();
        });
      }
    }

    /** Send what is waiting, then bring the catalog (and so the stock) up to date. */
    function sync(cb) {
      flush(function (flushError, flushed) {
        if (flushError && flushError.code === 'offline') {
          cb(flushError, flushed);
          return;
        }
        refresh(function (refreshError, status) {
          cb(refreshError || null, flushed, status);
        });
      });
    }

    /** Only the owner may let go of a sale the server refused: it is a real sale that is not in the books. */
    function discardRejected(saleId) {
      if (!session || session.roleName !== 'Admin') {
        return { ok: false, message: 'Only an owner (Admin) can remove a sale that was not recorded.' };
      }
      for (var i = 0; i < state.outbox.length; i++) {
        if (state.outbox[i].id === saleId && state.outbox[i].status === 'rejected') {
          state.outbox.splice(i, 1);
          var shown = historyEntry(saleId);
          if (shown) {
            shown.status = 'discarded';
          }
          save();
          return { ok: true };
        }
      }
      return { ok: false, message: 'That sale is not waiting.' };
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
        deviceLabel: state.device ? state.device.label : '',
        pendingSales: outboxSummary().pending,
        onlineWaiting: state.online.length,
        heldSales: state.held.length,
        rejectedSales: outboxSummary().rejected.length,
        sellBlockedReason: sellBlock()
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
      restoreSession: restoreSession,
      currentUser: function () { return session; },
      searchProducts: searchProducts,
      categoryName: categoryName,
      categories: function () { return state.catalog ? state.catalog.categories : []; },
      getStatus: getStatus,
      forget: forget,
      sell: sell,
      startOnline: startOnline,
      checkOnline: checkOnline,
      cancelOnline: cancelOnline,
      retryPrompt: retryPrompt,
      holdSale: holdSale,
      shopInfo: shopInfo,
      todaySummary: todaySummary,
      receiptSheet: receiptSheet,
      heldList: heldList,
      resumeHeld: resumeHeld,
      discardHeld: discardHeld,
      online: onlineList,
      notices: function () { return state.notices; },
      dismissNotice: dismissNotice,
      flush: flush,
      sync: sync,
      outbox: outboxSummary,
      history: function () { return state.history; },
      discardRejected: discardRejected,
      sellBlockedReason: sellBlock,
      formatCents: formatCents,
      parseCents: parseCents,
      _memoryOnly: function () { return memoryOnly; }
    };
  }

  // ---- is there a newer version of the till? -------------------------------------------------------------------
  /** The build label a page declares in <meta name="lite-build" content="...">, or null when it has none. */
  function pageBuild(html) {
    var metas = String(html || '').match(/<meta\b[^>]*>/gi) || [];
    for (var i = 0; i < metas.length; i++) {
      if (/\bname\s*=\s*["']lite-build["']/i.test(metas[i])) {
        var found = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(metas[i]);
        return found ? found[1] : null;
      }
    }
    return null;
  }

  /**
   * What identifies one released version of the till page: its build label plus the ?v= number on each script. Read the
   * same way from the page that is running and from the page on the server. null when the text is not a till page (an
   * error page, a login wall) - then nothing is claimed about it.
   */
  function pageSignature(html) {
    var build = pageBuild(html);
    if (build === null) {
      return null;
    }
    var tags = String(html).match(/<script\b[^>]*>/gi) || [];
    var parts = [];
    for (var i = 0; i < tags.length; i++) {
      var src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tags[i]);
      if (src) {
        var pieces = /^([^?#]*)(?:\?v=([^&#]*))?/.exec(src[1]);
        var file = pieces[1].split('/').pop();
        parts.push(file + '=' + (pieces[2] || ''));
      }
    }
    parts.sort();
    return build + '|' + parts.join('|');
  }

  /** True only when both pages are till pages and they are different versions. */
  function updateAvailable(runningHtml, latestHtml) {
    var running = pageSignature(runningHtml);
    var latest = pageSignature(latestHtml);
    return running !== null && latest !== null && running !== latest;
  }

  return { create: create, formatCents: formatCents, parseCents: parseCents, randomHex: randomHex, STORE_KEY: STORE_KEY, pageBuild: pageBuild, pageSignature: pageSignature, updateAvailable: updateAvailable };
}));
