/*
 * NexaPOS Lite till - the screens. ES5 only (iOS 10 Safari). All the real work is in lite-core.js and lite-sale.js
 * (tested against the real app); this file only moves text between the page and them.
 */
(function () {
  'use strict';

  var API = 'https://sync.nexapos.cc/index.php';
  var IDLE_LOGOUT_MS = 10 * 60 * 1000;
  var SYNC_EVERY_MS = 30 * 1000;
  var MAX_ROWS = 100;
  var PICKER_ROWS = 30;

  function el(id) { return document.getElementById(id); }
  function show(id, visible) {
    var kept = el(id).className.replace(/\bhidden\b/g, '').replace(/\s+$/, '');
    el(id).className = visible ? kept : (kept ? kept + ' hidden' : 'hidden');
  }
  function setText(id, text) {
    var node = el(id);
    node.innerHTML = '';
    node.appendChild(document.createTextNode(text));
  }
  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.appendChild(document.createTextNode(text)); }
    return node;
  }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function timeText(ms) {
    var d = new Date(ms);
    return d.getDate() + '/' + (d.getMonth() + 1) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }

  // ---- is this browser able to run the till? -----------------------------------------------------------------
  var storage = null;
  try {
    storage = window.localStorage;
    storage.setItem('nexapos-lite-probe', '1');
    storage.removeItem('nexapos-lite-probe');
  } catch (e) {
    storage = null; // private browsing: carries on in memory, and the page says so
  }
  var missing = [];
  if (typeof XMLHttpRequest === 'undefined') { missing.push('network requests'); }
  if (typeof JSON === 'undefined') { missing.push('JSON'); }
  if (typeof window.NexaLiteCore === 'undefined') { missing.push('the till code'); }
  if (typeof window.NexaLiteSale === 'undefined') { missing.push('the sales code'); }
  var bcryptLib = window.dcodeIO && window.dcodeIO.bcrypt ? window.dcodeIO.bcrypt : (window.bcrypt || null);
  if (!bcryptLib) { missing.push('the password checker'); }
  if (missing.length) {
    setText('compat', 'This browser cannot run NexaPOS Lite (missing: ' + missing.join(', ') + '). Try Safari, or update the iPad if it can be updated.');
    show('compat', true);
    return;
  }

  function xhrHttp(request, cb) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    function done(error, response) {
      if (finished) { return; }
      finished = true;
      cb(error, response);
    }
    xhr.open(request.method, request.url, true);
    for (var name in request.headers) {
      if (Object.prototype.hasOwnProperty.call(request.headers, name)) {
        xhr.setRequestHeader(name, request.headers[name]);
      }
    }
    xhr.timeout = 30000;
    xhr.onload = function () { done(null, { status: xhr.status, text: xhr.responseText }); };
    xhr.onerror = function () { done(new Error('network')); };
    xhr.ontimeout = function () { done(new Error('timeout')); };
    xhr.send(request.body);
  }

  var Sale = window.NexaLiteSale;
  /**
   * Quick sign in's door to the device: WebAuthn (the face / finger / passcode question) and WebCrypto (the signature check),
   * their promises made into the callbacks the core uses. Null where the browser has no passkeys (an old iPad): the till then
   * simply does not offer quick sign in.
   */
  function browserPasskeys() {
    try {
      var c = window.crypto;
      if (!window.PublicKeyCredential || window.isSecureContext === false || !navigator.credentials || !c || !c.subtle || !c.getRandomValues) { return null; }
    } catch (e) {
      return null;
    }
    function u8(buffer) { return buffer ? new Uint8Array(buffer) : null; }
    return {
      rpId: window.location.hostname,
      origin: window.location.origin || (window.location.protocol + '//' + window.location.host),
      supported: function () { return true; },
      randomBytes: function (n) { var out = new Uint8Array(n); window.crypto.getRandomValues(out); return out; },
      create: function (publicKey, cb) {
        navigator.credentials.create({ publicKey: publicKey }).then(function (made) {
          var response = made && made.response;
          var key = response && typeof response.getPublicKey === 'function' ? response.getPublicKey() : null;
          var alg = response && typeof response.getPublicKeyAlgorithm === 'function' ? response.getPublicKeyAlgorithm() : null;
          cb(null, made ? { rawId: u8(made.rawId), publicKey: u8(key), algorithm: alg } : null);
        }, function (error) { cb(error || new Error('failed')); });
      },
      get: function (publicKey, cb) {
        navigator.credentials.get({ publicKey: publicKey }).then(function (answer) {
          var r = answer && answer.response;
          cb(null, r ? { rawId: u8(answer.rawId), authenticatorData: u8(r.authenticatorData), clientDataJSON: u8(r.clientDataJSON), signature: u8(r.signature) } : null);
        }, function (error) { cb(error || new Error('failed')); });
      },
      sha256: function (data, cb) {
        window.crypto.subtle.digest('SHA-256', data).then(function (hash) { cb(null, u8(hash)); }, function (error) { cb(error); });
      },
      verify: function (spki, signed, rawSignature, cb) {
        var subtle = window.crypto.subtle;
        subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).then(function (key) {
          return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, rawSignature, signed);
        }).then(function (ok) { cb(null, ok === true); }, function (error) { cb(error); });
      }
    };
  }

  var core = window.NexaLiteCore.create({ baseUrl: API, http: xhrHttp, storage: storage, bcrypt: bcryptLib, sale: Sale, barcode: window.NexaLiteBarcode || null, passkeys: browserPasskeys() });

  // What the cashier is doing right now (kept in memory only).
  var ui = { tab: 'home', home: null, homeAt: 0, homeLoading: false, hideFigures: false, lowOnly: false, reportMode: 'day', reportsReady: false, report: null, cart: [], saleType: 'retail', payment: 'cash', receiptId: null, lastSyncProblem: '', syncing: false, payingId: null, payTimer: null, starting: false };
  var PAY_POLL_MS = 3000;
  var BACKGROUND_PAY_CHECK_MS = 15 * 1000;
  // Paying on the iPad itself leaves this page for Paystack and comes back to it (a fresh page load, so the login is
  // gone). This note, kept for this browser tab only, says which cashier was paying for which sale, so the till can
  // pick up exactly where it left off. It expires, and lite/paid.html reads it to know it should send the tab back here.
  // Paystack's own payment page sits behind a browser check that a very old iPad cannot pass (the page stays blank), so
  // the "Pay on this iPad instead" button is NOT offered. The way back from that page is built and tested, though:
  // set this to true to offer it again (for example on a newer tablet).
  var OFFER_PAY_ON_THIS_DEVICE = false;
  var RETURN_KEY = 'nexapos-lite-return';
  var RETURN_VALID_MS = 30 * 60 * 1000;
  ui.view = 'pick';
  var ENDED_TEXT = 'The customer did not approve the prompt (they cancelled it, or it ran out of time). Send it again below (you can correct the number), or cancel the payment.';

  function methodLabel(method) {
    return method === 'cash' ? 'Cash' : (method === 'paystack' ? 'Online (Paystack)' : 'M-Pesa');
  }

  // ---- small helpers -----------------------------------------------------------------------------------------
  function say(containerId, kind, text) {
    var box = el(containerId);
    box.innerHTML = '';
    if (!text) { return; }
    box.appendChild(make('div', 'notice ' + kind, text));
  }

  function setBusy(buttonId, busy, label) {
    el(buttonId).disabled = busy;
    if (label) { setText(buttonId, label); }
  }

  function updatedText(status) {
    if (!status.fetchedAt) { return ''; }
    return 'Shop data updated ' + timeText(status.fetchedAt) + '.';
  }

  function licenseNotice(containerId, status) {
    var license = status.license;
    if (license.state === 'unknown') { say(containerId, 'warn', license.message); }
    else if (!license.ok) { say(containerId, 'bad', license.message); }
    else if (license.daysLeft !== undefined && license.daysLeft !== null && license.daysLeft <= 14) { say(containerId, 'warn', license.message); }
    else { el(containerId).innerHTML = ''; }
  }

  function catalogMap() {
    var map = {};
    var all = core.searchProducts('', null, true);
    for (var i = 0; i < all.length; i++) { map[all[i].id] = all[i]; }
    return map;
  }

  function priceOf(item, map) {
    if (!item.productId) { return item.priceCents; }
    var product = map[item.productId];
    return product ? Sale.priceFor(product, ui.saleType) : 0;
  }

  // ---- banners: unsent / refused sales -----------------------------------------------------------------------
  function renderBanner(containerId) {
    var status = core.getStatus();
    var box = el(containerId);
    box.innerHTML = '';
    if (status.rejectedSales > 0) {
      box.appendChild(make('div', 'notice bad', status.rejectedSales + (status.rejectedSales === 1 ? ' sale was' : ' sales were') + ' NOT recorded by the shop. The money was taken but the shop has no record of it. Tell the owner now. Details are on the Sales tab.'));
    }
    if (status.onlineWaiting > 0 && containerId === 'login-sales') {
      box.appendChild(make('div', 'notice warn', status.onlineWaiting + (status.onlineWaiting === 1 ? ' online payment is' : ' online payments are') + ' waiting for the customer to pay. Log in to see ' + (status.onlineWaiting === 1 ? 'it' : 'them') + '.'));
    }
    if (status.heldSales > 0 && containerId === 'login-sales') {
      box.appendChild(make('div', 'notice warn', status.heldSales + (status.heldSales === 1 ? ' sale is' : ' sales are') + ' on hold on this iPad. Log in to open ' + (status.heldSales === 1 ? 'it' : 'them') + '.'));
    }
    if (status.rejectedRefunds > 0) {
      box.appendChild(make('div', 'notice bad', status.rejectedRefunds + (status.rejectedRefunds === 1 ? ' refund was' : ' refunds were') + ' NOT recorded by the shop. Tell the owner now before any money is paid back. Details are on the Sales tab.'));
    }
    if (status.pendingRefunds > 0 && containerId !== 'login-sales') {
      var refundWarn = make('div', 'notice warn', status.pendingRefunds + (status.pendingRefunds === 1 ? ' refund is' : ' refunds are') + ' saved on this iPad and waiting to be sent to the shop. ');
      var refundSend = make('button', 'small secondary', 'Send now');
      refundSend.type = 'button';
      refundSend.onclick = function () { doSync(true); };
      refundWarn.appendChild(refundSend);
      box.appendChild(refundWarn);
    }
    if (status.rejectedExpenses > 0 && containerId !== 'login-sales') {
      box.appendChild(make('div', 'notice bad', status.rejectedExpenses + (status.rejectedExpenses === 1 ? ' expense was' : ' expenses were') + ' NOT recorded by the shop. Open Expenses (on the Dashboard) to see why.'));
    }
    if (status.pendingExpenses > 0 && containerId !== 'login-sales') {
      var expenseWarn = make('div', 'notice warn', status.pendingExpenses + (status.pendingExpenses === 1 ? ' expense is' : ' expenses are') + ' saved on this iPad and waiting to be sent to the shop. ');
      var expenseSend = make('button', 'small secondary', 'Send now');
      expenseSend.type = 'button';
      expenseSend.onclick = function () { doSync(true); };
      expenseWarn.appendChild(expenseSend);
      box.appendChild(expenseWarn);
    }
    if (status.pendingSales > 0) {
      var warn =make('div', 'notice warn', status.pendingSales + (status.pendingSales === 1 ? ' sale is' : ' sales are') + ' saved on this iPad and waiting to be sent to the shop. ' + (ui.lastSyncProblem ? ui.lastSyncProblem + ' ' : ''));
      var send = make('button', 'small secondary', 'Send now');
      send.type = 'button';
      send.onclick = function () { doSync(true); };
      warn.appendChild(send);
      box.appendChild(warn);
    }
  }

  // ---- routing -----------------------------------------------------------------------------------------------
  function route() {
    var status = core.getStatus();
    var user = core.currentUser();
    show('screen-setup', false);
    show('screen-login', false);
    show('screen-till', false);
    if (!status.joined || !status.hasCatalog) {
      show('screen-setup', true);
      if (!status.storageOk) {
        say('setup-message', 'warn', 'This browser is not saving data (private browsing?). The till will forget everything when you close the page.');
      }
      return;
    }
    if (!user) {
      show('screen-login', true);
      setText('login-shop', status.shopName || 'NexaPOS Lite');
      setText('login-updated', updatedText(status));
      licenseNotice('login-license', status);
      renderBanner('login-sales');
      say('login-revoked', 'bad', status.revoked ? 'This iPad is no longer allowed to use the shop. Ask the owner to check Connected devices, or disconnect it here and connect again.' : '');
      drawQuickLogin();
      return;
    }
    show('screen-till', true);
    setText('till-shop', status.shopName || 'NexaPOS Lite');
    setText('till-user', user.name + ' (' + user.roleName + ')');
    setText('home-who', user.name);
    setText('till-updated', updatedText(status));
    licenseNotice('till-license', status);
    renderAll();
  }

  function renderAll() {
    renderBanner('till-sales');
    renderNotices();
    renderOnline();
    renderPicker();
    renderCart();
    renderHeld();
    fillCategories();
    renderProducts();
    renderSales();
    updateReceiptStatus();
    pollSupportBadge(false);
  }

  // ---- tabs --------------------------------------------------------------------------------------------------
  var TAB_NAMES = ['home', 'sell', 'products', 'reports', 'sales'];
  function showTab(name) {
    ui.tab = name;
    for (var i = 0; i < TAB_NAMES.length; i++) {
      show('panel-' + TAB_NAMES[i], TAB_NAMES[i] === name);
    }
    show('panel-expenses', name === 'expenses');
    show('panel-refund', name === 'refund');
    show('panel-settings', name === 'settings');
    show('panel-support', name === 'support');
    if (name === 'settings') { renderSettings(); }
    if (name === 'support') { renderSupport(); }
    if (name !== 'support') { stopSupportPoll(); closeSheet(); }
    if (name !== 'settings') { stopLicenseTicker(); closeTillPhonePage(); }
    if (name === 'home') { renderHome(); refreshHome(false); }
    if (name === 'expenses') { openExpenses(); }
    if (name === 'products') { renderProducts(); }
    if (name === 'reports') { initReports(); }
    if (name === 'sales') { renderSales(); }
  }

  // ---- selling: picking products -----------------------------------------------------------------------------
  function stockBadge(cell, p) {
    if (p.stockQty <= 0) { cell.appendChild(make('span', 'badge out', 'Out')); }
    else if (p.stockQty <= p.reorderLevel) { cell.appendChild(make('span', 'badge low', 'Low')); }
  }

  function renderPicker() {
    var found = core.searchProducts(el('sell-search').value, null, false);
    var body = el('sell-picker');
    body.innerHTML = '';
    var shown = Math.min(found.length, PICKER_ROWS);
    for (var i = 0; i < shown; i++) {
      (function (p) {
        var row = make('tr');
        var name = make('td', '', p.name);
        name.appendChild(make('div', 'sku', p.sku));
        row.appendChild(name);
        row.appendChild(make('td', 'num', core.formatCents(Sale.priceFor(p, ui.saleType))));
        var stock = make('td', 'num', String(p.stockQty));
        stockBadge(stock, p);
        row.appendChild(stock);
        var action = make('td', 'num');
        var add = make('button', 'small', 'Add');
        add.type = 'button';
        add.disabled = p.stockQty < 1;
        add.onclick = function () { addToCart(p); };
        action.appendChild(add);
        row.appendChild(action);
        body.appendChild(row);
      }(found[i]));
    }
    setText('sell-picker-note', found.length === 0 ? 'No products match.' : (found.length > shown ? 'Showing ' + shown + ' of ' + found.length + '. Type to narrow it down.' : ''));
  }
  el('sell-search').oninput = (function () {
    var timer = null;
    return function () {
      if (timer) { window.clearTimeout(timer); }
      timer = window.setTimeout(renderPicker, 250);
    };
  }());

  function addToCart(product) {
    for (var i = 0; i < ui.cart.length; i++) {
      if (ui.cart[i].productId === product.id) {
        if (ui.cart[i].qty + 1 > product.stockQty) {
          say('pick-message', 'warn', 'Only ' + product.stockQty + ' ' + product.name + ' in stock.');
          return;
        }
        ui.cart[i].qty += 1;
        say('pick-message', '', '');
        renderCart();
        return;
      }
    }
    ui.cart.push({ productId: product.id, name: product.name, qty: 1 });
    say('pick-message', '', '');
    renderCart();
  }

  el('manual-add').onclick = function () {
    var name = el('manual-name').value.replace(/^\s+|\s+$/g, '');
    var price = core.parseCents(el('manual-price').value);
    var qty = parseInt(el('manual-qty').value, 10);
    if (!name) { say('sell-message', 'warn', 'Enter the item name.'); return; }
    if (price === null || price < 1) { say('sell-message', 'warn', 'Enter the price as a number, like 150 or 150.50.'); return; }
    if (!(qty >= 1) || qty > 100000) { say('sell-message', 'warn', 'Enter how many (1 or more).'); return; }
    ui.cart.push({ productId: null, name: name, qty: qty, priceCents: price });
    el('manual-name').value = '';
    el('manual-price').value = '';
    el('manual-qty').value = '1';
    say('sell-message', '', '');
    renderCart();
  };

  // ---- selling: the cart and totals (the app's Cart & Checkout) ---------------------------------------------
  function totals() {
    var map = catalogMap();
    var subtotal = 0;
    var lines = [];
    for (var i = 0; i < ui.cart.length; i++) {
      var unit = priceOf(ui.cart[i], map);
      var lineTotal = unit * ui.cart[i].qty;
      subtotal += lineTotal;
      lines.push({ item: ui.cart[i], unit: unit, total: lineTotal });
    }
    var typed = el('discount').value.replace(/^\s+|\s+$/g, '');
    var discount = typed === '' ? 0 : core.parseCents(typed);
    var discountOk = discount !== null;
    if (!discountOk) { discount = 0; }
    if (discount > subtotal) { discount = subtotal; }
    return { map: map, lines: lines, subtotal: subtotal, discount: discount, discountOk: discountOk, total: subtotal - discount };
  }

  function cartCount() {
    var n = 0;
    for (var i = 0; i < ui.cart.length; i++) { n += ui.cart[i].qty; }
    return n;
  }

  /** Two steps, as in the app: pick products, then Cart & Checkout. */
  function showView(name) {
    ui.view = name;
    show('view-pick', name === 'pick');
    show('view-cart', name === 'cart');
    show('view-held', name === 'held');
    if (name === 'cart') { renderCart(); }
    if (name === 'held') { renderHeld(); }
  }
  el('view-cart-button').onclick = function () { showView('cart'); };
  el('back-to-products').onclick = function () { showView('pick'); };

  function renderCart() {
    var t = totals();
    var body = el('cart-lines');
    body.innerHTML = '';
    show('cart-empty', ui.cart.length === 0);
    for (var i = 0; i < t.lines.length; i++) {
      (function (line, index) {
        var row = make('tr');
        var name = make('td', '', line.item.name);
        name.appendChild(make('div', 'sku', core.formatCents(line.unit) + ' each'));
        row.appendChild(name);
        var controls = make('td', 'num');
        var minus = make('button', 'small secondary', '-');
        minus.type = 'button';
        minus.onclick = function () {
          ui.cart[index].qty -= 1;
          if (ui.cart[index].qty < 1) { ui.cart.splice(index, 1); }
          renderCart();
        };
        var plus = make('button', 'small secondary', '+');
        plus.type = 'button';
        plus.onclick = function () {
          var product = t.map[ui.cart[index].productId];
          if (product && ui.cart[index].qty + 1 > product.stockQty) {
            say('sell-message', 'warn', 'Only ' + product.stockQty + ' ' + product.name + ' in stock.');
            return;
          }
          ui.cart[index].qty += 1;
          say('sell-message', '', '');
          renderCart();
        };
        controls.appendChild(minus);
        controls.appendChild(make('span', 'qty', String(line.item.qty)));
        controls.appendChild(plus);
        row.appendChild(controls);
        row.appendChild(make('td', 'num', core.formatCents(line.total)));
        var remove = make('td', 'num');
        var x = make('button', 'small secondary', '\u00d7');
        x.type = 'button';
        x.onclick = function () {
          // As in the app: a stray tap must not drop a line without asking.
          if (window.confirm('Remove "' + ui.cart[index].name + '" from this sale?')) { ui.cart.splice(index, 1); renderCart(); }
        };
        remove.appendChild(x);
        row.appendChild(remove);
        body.appendChild(row);
      }(t.lines[i], i));
    }

    var tbody = el('totals');
    tbody.innerHTML = '';
    function totalRow(label, value, className) {
      var row = make('tr', className || '');
      row.appendChild(make('td', '', label));
      row.appendChild(make('td', 'num', value));
      tbody.appendChild(row);
    }
    totalRow('Subtotal', core.formatCents(t.subtotal));
    totalRow('Discount', core.formatCents(t.discount));
    totalRow('Total', core.formatCents(t.total), 'grand');
    var received = ui.payment === 'cash' ? core.parseCents(el('cash-received').value) : null;
    if (received !== null && received >= t.total && ui.cart.length > 0) { totalRow('Change due', core.formatCents(received - t.total)); }
    if (received !== null && received < t.total && ui.cart.length > 0) { totalRow('Still owed', core.formatCents(t.total - received)); }

    var count = cartCount();
    setText('view-cart-button', count === 0 ? 'View cart' : 'View cart (' + count + ') \u00b7 ' + core.formatCents(t.total));
    var blocked = core.sellBlockedReason();
    el('complete-button').disabled = ui.cart.length === 0 || !!blocked || !t.discountOk || ui.starting;
    el('show-qr-button').disabled = ui.cart.length === 0 || !!blocked || !t.discountOk || ui.starting;
    el('hold-button').disabled = ui.cart.length === 0 || ui.starting;
    if (blocked) { say('sell-message', 'bad', blocked); }
    else if (!t.discountOk) { say('sell-message', 'warn', 'The discount must be a number, like 50 or 50.50.'); }
    if (ui.payment === 'till' && tillList && tillList.payments) { drawTillList(); } // which payment fits the total changes with the cart
  }

  el('discount').oninput = renderCart;
  el('cash-received').oninput = renderCart;
  el('type-retail').onclick = function () { setSaleType('retail'); };
  el('type-wholesale').onclick = function () { setSaleType('wholesale'); };
  function setSaleType(type) {
    ui.saleType = type;
    el('type-retail').className = type === 'retail' ? 'on' : '';
    el('type-wholesale').className = type === 'wholesale' ? 'on' : '';
    renderPicker();
    renderCart();
  }
  // Payment methods, as in the app: Cash, or an M-Pesa Prompt sent to the customer's phone.
  el('pay-cash').onclick = function () { setPayment('cash'); };
  el('pay-paystack').onclick = function () { setPayment('paystack'); };
  el('pay-till').onclick = function () { setPayment('till'); };
  function completeLabel() { return ui.payment === 'paystack' ? 'Send M-Pesa Prompt' : 'Complete Sale'; }
  function setPayment(method) {
    ui.payment = method;
    el('pay-cash').className = method === 'cash' ? 'on' : '';
    el('pay-paystack').className = method === 'paystack' ? 'on' : '';
    el('pay-till').className = method === 'till' ? 'on' : '';
    show('pay-cash-box', method === 'cash');
    show('pay-paystack-box', method === 'paystack');
    show('pay-till-box', method === 'till');
    if (method === 'till') { startTillList(); } else { stopTillList(); }
    setText('complete-button', completeLabel());
    say('sell-message', '', '');
    renderCart();
  }

  function resetSale() {
    ui.cart = [];
    el('discount').value = '';
    el('cash-received').value = '';
    el('paystack-phone').value = '';
    el('till-code').value = '';
    say('sell-message', '', '');
    say('pick-message', '', '');
    setSaleType('retail');
    setPayment('cash');
    showView('pick');
  }
  el('clear-button').onclick = function () {
    if (ui.cart.length === 0 || window.confirm('Clear this whole sale?')) { resetSale(); }
  };

  // ---- held sales: set a sale aside to serve someone else (like the app's Hold sale) -------------------------
  /** Everything the screen has for the sale in progress, as the till code keeps it for a held sale. */
  function currentDraft() {
    return {
      cart: ui.cart,
      saleType: ui.saleType,
      discount: el('discount').value,
      payment: ui.payment,
      phone: el('paystack-phone').value,
      cashReceived: el('cash-received').value
    };
  }

  /** What a held sale looks like now: item count, a short list of the items, and the total at today's prices. */
  function heldSummary(held, map) {
    var cart = held.draft.cart;
    var count = 0;
    var subtotal = 0;
    var missing = false;
    var names = [];
    for (var i = 0; i < cart.length; i++) {
      var unit = 0;
      if (cart[i].productId === null) {
        unit = cart[i].priceCents;
      } else if (map[cart[i].productId]) {
        unit = Sale.priceFor(map[cart[i].productId], held.draft.saleType);
      } else {
        missing = true;
      }
      count += cart[i].qty;
      subtotal += unit * cart[i].qty;
      names.push(cart[i].qty + ' \u00d7 ' + cart[i].name);
    }
    var typed = held.draft.discount.replace(/^\s+|\s+$/g, '');
    var discount = typed === '' ? 0 : core.parseCents(typed);
    if (discount === null) { discount = 0; }
    if (discount > subtotal) { discount = subtotal; }
    var list = names.join(', ');
    if (list.length > 110) { list = list.slice(0, 107) + '...'; }
    return { count: count, total: subtotal - discount, missing: missing, list: list };
  }

  function renderHeld() {
    var list = core.heldList();
    var buttons = ['held-button-pick', 'held-button-cart'];
    for (var b = 0; b < buttons.length; b++) {
      show(buttons[b], list.length > 0);
      if (list.length > 0) { setText(buttons[b], 'Held sales (' + list.length + ')'); }
    }
    if (ui.view !== 'held') { return; }
    var box = el('held-list');
    box.innerHTML = '';
    show('held-empty', list.length === 0);
    var map = catalogMap();
    for (var i = 0; i < list.length; i++) {
      (function (held) {
        var info = heldSummary(held, map);
        var card = make('div', 'card');
        card.appendChild(make('div', 'heldname', held.label));
        card.appendChild(make('div', 'muted', 'Held by ' + held.heldBy + ' \u00b7 ' + timeText(held.heldAt)));
        card.appendChild(make('div', 'heldlist', info.list));
        card.appendChild(make('div', 'muted', info.count + (info.count === 1 ? ' item' : ' items') + ' \u00b7 ' + core.formatCents(info.total) + ' at today\'s prices'));
        if (info.missing) { card.appendChild(make('div', 'notice warn', 'Some of these items are no longer in the shop\'s list. They will be left out when you open it.')); }
        var open = make('button', 'small', 'Open');
        open.type = 'button';
        open.onclick = function () { openHeld(held); };
        var drop = make('button', 'small secondary', 'Throw away');
        drop.type = 'button';
        drop.style.marginTop = '10px';
        open.style.marginTop = '10px';
        drop.onclick = function () { throwAwayHeld(held); };
        card.appendChild(open);
        card.appendChild(drop);
        box.appendChild(card);
      }(list[i]));
    }
  }

  function showHeld() {
    ui.heldFrom = ui.view === 'cart' ? 'cart' : 'pick';
    say('held-message', '', '');
    showView('held');
  }
  el('held-button-pick').onclick = showHeld;
  el('held-button-cart').onclick = showHeld;
  el('held-back').onclick = function () { showView(ui.heldFrom === 'cart' && ui.cart.length > 0 ? 'cart' : 'pick'); };

  el('hold-button').onclick = function () {
    if (ui.cart.length === 0 || ui.starting) { return; }
    var name = window.prompt('Name this held sale so you can find it again, for example the customer. You can leave this empty.', '');
    if (name === null) { return; }
    var result = core.holdSale(name, currentDraft());
    if (!result.ok) { say('sell-message', 'bad', result.message); return; }
    resetSale();
    renderHeld();
    say('pick-message', 'ok', '"' + result.held.label + '" is on hold. Open it again from Held sales.');
  };

  /** Puts a held sale back on the screen. Items that are gone from the shop's list, or sold out, are left out and the cashier is told. */
  function restoreDraft(draft) {
    var map = catalogMap();
    var cart = [];
    var left = [];
    var cut = [];
    for (var i = 0; i < draft.cart.length; i++) {
      var line = draft.cart[i];
      if (line.productId === null) {
        cart.push({ productId: null, name: line.name, qty: line.qty, priceCents: line.priceCents });
        continue;
      }
      var product = map[line.productId];
      if (!product || product.stockQty < 1) { left.push(line.name); continue; }
      var qty = Math.min(line.qty, product.stockQty);
      if (qty < line.qty) { cut.push(line.name); }
      cart.push({ productId: line.productId, name: line.name, qty: qty });
    }
    ui.cart = cart;
    el('discount').value = draft.discount;
    el('cash-received').value = draft.cashReceived;
    el('paystack-phone').value = draft.phone;
    setSaleType(draft.saleType);
    setPayment(draft.payment);
    renderAll();
    showTab('sell');
    showView('cart');
    var notes = [];
    if (left.length) { notes.push('Left out (not in the shop\'s list any more, or out of stock): ' + left.join(', ') + '.'); }
    if (cut.length) { notes.push('Less in stock than before, so the quantity was lowered for: ' + cut.join(', ') + '.'); }
    say('sell-message', notes.length ? 'warn' : '', notes.join(' '));
  }

  function openHeld(held) {
    if (ui.cart.length > 0) {
      // The sale in progress is put on hold first, so opening another one never loses it.
      if (!window.confirm('You have a sale in progress. Put it on hold and open "' + held.label + '"?')) { return; }
      var kept = core.holdSale('', currentDraft());
      if (!kept.ok) { say('held-message', 'bad', kept.message); return; }
    }
    var opened = core.resumeHeld(held.id);
    if (!opened.ok) { say('held-message', 'warn', opened.message); renderHeld(); return; }
    restoreDraft(opened.held.draft);
  }

  function throwAwayHeld(held) {
    if (!window.confirm('Throw away "' + held.label + '"? Nothing will be sold, and it cannot be brought back.')) { return; }
    var result = core.discardHeld(held.id);
    say('held-message', result.ok ? 'ok' : 'warn', result.ok ? '"' + held.label + '" was thrown away.' : result.message);
    renderHeld();
  }

  // ---- completing a sale -------------------------------------------------------------------------------------
  function buildCart(t) {
    var cart = [];
    for (var i = 0; i < t.lines.length; i++) {
      cart.push({ productId: t.lines[i].item.productId, name: t.lines[i].item.name, unitPriceCents: t.lines[i].unit, quantity: t.lines[i].item.qty });
    }
    return cart;
  }

  el('complete-button').onclick = function () {
    if (ui.starting) { return; }
    var t = totals();
    var cart = buildCart(t);
    if (ui.payment === 'paystack') {
      startOnlineSale(t, cart, 'prompt');
      return;
    }
    if (ui.payment === 'till') {
      completeTillSale(t, cart, false);
      return;
    }
    var cashTyped = el('cash-received').value.replace(/^\s+|\s+$/g, '');
    var result = core.sell({
      cart: cart,
      saleType: ui.saleType,
      paymentMethod: 'cash',
      discountCents: t.discount,
      customerName: '',
      customerPhone: '',
      referenceNote: '',
      cashReceivedCents: cashTyped !== '' ? core.parseCents(cashTyped) : null
    });
    if (!result.ok) {
      say('sell-message', 'bad', result.message);
      return;
    }
    resetSale();
    ui.receiptId = result.receipt.saleId;
    showReceipt(result.receipt);
    renderAll();
    core.flush(function (error) {
      ui.lastSyncProblem = error ? error.message : '';
      renderBanner('till-sales');
      updateReceiptStatus();
      renderSales();
    });
  };
  // ---- M-Pesa Till/Paybill: the customer paid the shop's own till or paybill -------------------------------------------------
  // The payments the shop phone passed on are listed (newest first, the ones no sale has used yet); a tap puts the code in the
  // box. Complete Sale asks the shop to use that code on this sale, and only then is the sale saved.
  var tillList = { timer: null, payments: null, phones: null, token: 0 };
  var TILL_LIST_REFRESH_MS = 8000;

  function stopTillList() {
    if (!tillList) { return; } // called while the page is still starting up
    if (tillList.timer) { window.clearInterval(tillList.timer); tillList.timer = null; }
    tillList.token += 1;
  }

  function startTillList() {
    stopTillList();
    tillList.payments = null;
    drawTillList();
    loadTillList();
    tillList.timer = window.setInterval(function () {
      if (ui.payment !== 'till' || ui.tab !== 'sell' || !core.currentUser()) { stopTillList(); return; }
      loadTillList();
    }, TILL_LIST_REFRESH_MS);
  }

  function loadTillList() {
    var token = tillList.token;
    core.unusedTillPayments(6, function (error, payments, phones) {
      if (token !== tillList.token) { return; }
      if (el('till-pay-refresh')) { setBusy('till-pay-refresh', false, 'Refresh'); }
      if (error) {
        say('till-pay-message', error.code === 'offline' ? 'warn' : 'bad', error.message);
        if (tillList.payments === null) { tillList.payments = []; drawTillList(); }
        return;
      }
      tillList.payments = payments;
      tillList.phones = phones;
      say('till-pay-message', phones === 0 ? 'warn' : '', phones === 0 ? 'No shop phone passes M-Pesa messages on yet, so payments cannot be checked. An administrator sets one up in Settings > M-Pesa Till Phone.' : '');
      drawTillList();
    });
  }

  /**
   * Lets [row] be swiped to the left with a finger. A swipe far enough asks [ask]() and, on yes, calls [done](); anything
   * else slides the row back. A swipe never counts as a tap on the row. Plain touch events: what Safari 10 on an old iPad has.
   */
  function swipeLeft(wrap, row, ask, done) {
    var start = null;
    var dx = 0;
    var sideways = null;
    var swiped = false;
    // the red Archive behind the row shows only while the row is moved (its round corners would show it otherwise)
    var hideRed = null;
    function showRed(on) {
      if (hideRed) { window.clearTimeout(hideRed); hideRed = null; }
      if (on) { wrap.className = 'swipewrap swiping'; return; }
      hideRed = window.setTimeout(function () { wrap.className = 'swipewrap'; }, 250);
    }
    function slide(px, animate) {
      if (px < 0) { showRed(true); } else { showRed(false); }
      row.style.webkitTransition = animate ? '-webkit-transform .2s' : 'none';
      row.style.transition = animate ? 'transform .2s' : 'none';
      row.style.webkitTransform = 'translateX(' + px + 'px)';
      row.style.transform = 'translateX(' + px + 'px)';
    }
    row.addEventListener('touchstart', function (event) {
      if (event.touches.length !== 1) { start = null; return; }
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      dx = 0;
      sideways = null;
      swiped = false;
      slide(0, false);
    }, false);
    row.addEventListener('touchmove', function (event) {
      if (!start || event.touches.length !== 1) { return; }
      var mx = event.touches[0].clientX - start.x;
      var my = event.touches[0].clientY - start.y;
      if (sideways === null) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) { return; }
        sideways = Math.abs(mx) > Math.abs(my);
      }
      if (!sideways) { return; } // scrolling the page up or down
      event.preventDefault();
      dx = Math.min(0, mx);
      slide(dx, false);
    }, false);
    function end() {
      if (!start) { return; }
      start = null;
      if (!sideways) { return; }
      swiped = true;
      var far = dx < -Math.max(70, wrap.offsetWidth * 0.3);
      if (!far) { slide(0, true); return; }
      slide(-wrap.offsetWidth * 0.4, true);
      // let the row show where it went before the question covers the screen
      window.setTimeout(function () {
        if (ask()) { done(function () { slide(0, true); }); } else { slide(0, true); }
      }, 220);
    }
    row.addEventListener('touchend', end, false);
    row.addEventListener('touchcancel', function () { start = null; slide(0, true); }, false);
    // the tap that follows a swipe is not a tap
    row.addEventListener('click', function (event) {
      if (swiped) { swiped = false; event.preventDefault(); event.stopPropagation(); }
    }, true);
  }

  function archiveFromCheckout(p, slideBack) {
    core.archiveTillPayment(p.code, true, function (error) {
      if (error) {
        slideBack();
        say('till-pay-message', error.code === 'offline' ? 'warn' : 'bad', error.message);
        return;
      }
      if (core.mpesaCode(el('till-code').value) === p.code) { el('till-code').value = ''; }
      var kept = [];
      for (var i = 0; i < (tillList.payments || []).length; i++) { if (tillList.payments[i].code !== p.code) { kept.push(tillList.payments[i]); } }
      tillList.payments = kept;
      drawTillList();
      say('till-pay-message', 'ok', 'Archived: ' + (p.payerName || p.code) + '. It is no longer suggested here. You can still see it in Settings > M-Pesa Till Phone.');
    });
  }

  function drawTillList() {
    var list = el('till-pay-list');
    list.innerHTML = '';
    if (tillList.payments === null) { list.appendChild(make('p', 'muted', 'Loading the payments...')); return; }
    if (tillList.payments.length === 0) { list.appendChild(make('p', 'muted', 'No new payment yet. It shows here a few seconds after the M-Pesa message reaches the shop phone.')); return; }
    var total = totals().total;
    var picked = core.mpesaCode(el('till-code').value);
    for (var i = 0; i < tillList.payments.length; i++) {
      (function (p) {
        var row = make('button', 'ticket' + (p.code === picked ? ' on' : ''));
        row.type = 'button';
        row.appendChild(make('span', 'amt', p.amountCents === null ? '?' : money(p.amountCents)));
        row.appendChild(make('div', 'subject', p.payerName || 'M-Pesa payment'));
        var meta = make('div', 'meta', [p.code, p.paidAtText || (p.receivedAt ? timeText(p.receivedAt) : '')].join(' \u00b7 '));
        if (p.amountCents !== null && p.amountCents === total) { meta.appendChild(document.createTextNode(' \u00b7 ')); meta.appendChild(make('span', 'fits', 'the sale total')); }
        row.appendChild(meta);
        row.onclick = function () {
          el('till-code').value = p.code;
          say('sell-message', '', '');
          drawTillList();
        };
        var wrap = make('div', 'swipewrap');
        wrap.appendChild(make('span', 'swipeback', 'Archive'));
        wrap.appendChild(row);
        swipeLeft(wrap, row, function () {
          return window.confirm('Are you sure you want to archive this payment?\n' + (p.payerName || 'M-Pesa payment') + ', ' + (p.amountCents === null ? '' : money(p.amountCents) + ', ') + p.code +
            '\n\nIt will no longer be suggested at checkout. You can still see it in Settings > M-Pesa Till Phone.');
        }, function (slideBack) { archiveFromCheckout(p, slideBack); });
        list.appendChild(wrap);
      }(tillList.payments[i]));
    }
    list.appendChild(make('p', 'muted', 'Swipe a payment to the left to archive it: it is no longer suggested here.'));
  }
  el('till-code').oninput = function () { drawTillList(); };
  el('till-pay-refresh').onclick = function () { setBusy('till-pay-refresh', true, 'Refreshing...'); loadTillList(); };

  function completeTillSale(t, cart, acceptAmount) {
    ui.starting = true;
    renderCart();
    setText('complete-button', 'Checking the payment...');
    say('sell-message', '', '');
    core.sellTill({ cart: cart, saleType: ui.saleType, discountCents: t.discount, code: el('till-code').value, acceptAmount: acceptAmount }, function (result) {
      ui.starting = false;
      setText('complete-button', completeLabel());
      renderCart();
      if (result.ok) {
        var extra = result.payment.amountCents !== null && result.payment.amountCents > result.receipt.totalCents ? result.payment.amountCents - result.receipt.totalCents : 0;
        resetSale();
        ui.receiptId = result.receipt.saleId;
        showReceipt(result.receipt);
        if (extra > 0) { el('receipt-box').insertBefore(make('div', 'notice ok', 'The customer paid ' + money(result.payment.amountCents) + '. Give back ' + money(extra) + ' in cash.'), el('receipt-box').firstChild); }
        renderAll();
        core.flush(function (error) {
          ui.lastSyncProblem = error ? error.message : '';
          renderBanner('till-sales');
          updateReceiptStatus();
          renderSales();
        });
        return;
      }
      if (result.code === 'amount_differs') {
        if (window.confirm('The customer paid ' + money(result.paidCents) + ' for a sale of ' + money(result.totalCents) + '.\nGive back ' + money(result.paidCents - result.totalCents) + ' in cash and complete the sale?')) {
          completeTillSale(t, cart, true);
        }
        return;
      }
      if (result.code === 'amount_unknown') {
        if (window.confirm('The amount in this M-Pesa message could not be read.\nCheck the message on the shop phone. Did the customer pay at least ' + money(result.totalCents) + '?')) {
          completeTillSale(t, cart, true);
        }
        return;
      }
      say('sell-message', result.code === 'offline' || result.code === 'not_received' || result.code === 'busy' ? 'warn' : 'bad', result.message);
      if (result.code === 'used' || result.code === 'not_received') { loadTillList(); }
    });
  }

  // The other way to take an online payment: a code on the screen that the customer scans with their own phone.
  el('show-qr-button').onclick = function () {
    if (ui.starting) { return; }
    var t = totals();
    startOnlineSale(t, buildCart(t), 'qr');
  };

  function receiptStatusLine(saleId) {
    var list = core.history();
    for (var i = 0; i < list.length; i++) {
      if (list[i].receipt.saleId === saleId) {
        if (list[i].status === 'sent') { return { kind: 'ok', text: 'Recorded by the shop.' }; }
        if (list[i].status === 'rejected') { return { kind: 'bad', text: 'NOT recorded by the shop: ' + list[i].error + ' Tell the owner now.' }; }
        if (list[i].status === 'discarded') { return { kind: 'warn', text: 'Removed by the owner.' }; }
        return { kind: 'warn', text: ui.lastSyncProblem ? 'Saved on this iPad. It could not be sent yet - it will be sent automatically when the internet is back.' : 'Saved on this iPad. Sending to the shop...' };
      }
    }
    return { kind: 'warn', text: '' };
  }

  // ---- the receipt, drawn like the apps' (monospace paper), on screen and on paper ---------------------------------
  /** Draws a receipt sheet (what core.receiptSheet decided) into [box]. */
  function drawSheet(box, sheet) {
    box.innerHTML = '';
    function line(className, text) { box.appendChild(make('div', className, text)); }
    function rule(dashed) { box.appendChild(make('div', dashed ? 'pp-dash' : 'pp-solid')); }
    function pair(className, left, right) {
      var row = make('div', 'pp-row' + (className ? ' ' + className : ''));
      row.appendChild(make('span', '', left));
      row.appendChild(make('span', '', right));
      box.appendChild(row);
    }
    var i;
    if (sheet.reprint) { line('pp-reprint', 'REPRINT'); }
    line('pp-center pp-shop', sheet.shopName);
    line('pp-center', sheet.poweredBy);
    if (sheet.address) { line('pp-center', sheet.address); }
    if (sheet.phone) { line('pp-center', sheet.phone); }
    if (sheet.title) { line('pp-title', sheet.title); }
    rule(false);
    for (i = 0; i < sheet.meta.length; i++) { line('', sheet.meta[i].label + ': ' + sheet.meta[i].value); }
    rule(false);
    for (i = 0; i < sheet.lines.length; i++) {
      pair('', sheet.lines[i].name + '      ' + sheet.lines[i].quantity + ' x ' + sheet.lines[i].unit, sheet.lines[i].total);
    }
    rule(true);
    for (i = 0; i < sheet.totals.length; i++) { pair(sheet.totals[i].grand ? 'pp-total' : '', sheet.totals[i].label, sheet.totals[i].value); }
    rule(false);
    for (i = 0; i < sheet.payment.length; i++) {
      if (sheet.payment[i].text) { line('', sheet.payment[i].label + ': ' + sheet.payment[i].value); } else { pair('', sheet.payment[i].label, sheet.payment[i].value); }
    }
    rule(false);
    line('pp-center', sheet.thanks);
    line('pp-center', sheet.support);
    if (sheet.footer) { line('pp-center pp-italic', sheet.footer); }
    if (sheet.barcodeValue && window.NexaLiteBarcode) { box.appendChild(barcodeSvg(sheet.barcodeValue)); line('pp-center pp-digits', sheet.barcodeValue); }
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgNode(tag, attributes) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var name in attributes) {
      if (Object.prototype.hasOwnProperty.call(attributes, name)) { node.setAttribute(name, attributes[name]); }
    }
    return node;
  }

  /** The receipt's barcode, drawn from the bars NexaLiteBarcode worked out (the same bars the apps print). */
  function barcodeSvg(digits) {
    var made = window.NexaLiteBarcode.barcodeBars(digits);
    var quiet = 10;
    var root = svgNode('svg', { 'class': 'pp-barcode', viewBox: '0 0 ' + (made.modules + quiet * 2) + ' 60', width: String((made.modules + quiet * 2) * 2), height: '120', role: 'img', 'aria-label': 'Receipt barcode ' + digits });
    for (var i = 0; i < made.bars.length; i++) {
      root.appendChild(svgNode('rect', { x: String(made.bars[i].x + quiet), y: '0', width: String(made.bars[i].w), height: '60', fill: '#000' }));
    }
    return root;
  }

  // ---- printing (AirPrint from the browser's own print sheet) ----------------------------------------------------
  /** Draws the receipt and opens the print sheet. */
  function printReceipt(receipt, reprint) {
    if (typeof window.print !== 'function') {
      window.alert('This browser cannot print.');
      return;
    }
    var sheet = core.receiptSheet(receipt, reprint);
    var box = el('print-receipt');
    box.className = 'paper';
    box.style.width = sheet.widthMm + 'mm';
    drawSheet(box, sheet);
    window.print();
  }

  function showReceipt(receipt) {
    var box = el('receipt-box');
    box.innerHTML = '';
    if (receipt.changeDueCents !== null && receipt.changeDueCents >= 0 && receipt.paymentMethod === 'cash') {
      box.appendChild(make('div', 'notice ok', 'Change to give: ' + money(receipt.changeDueCents)));
    } else if (receipt.changeDueCents !== null && receipt.paymentMethod === 'cash') {
      box.appendChild(make('div', 'notice warn', 'The customer still owes ' + money(-receipt.changeDueCents) + '.'));
    }
    var paper = make('div', 'paper');
    drawSheet(paper, core.receiptSheet(receipt, false));
    box.appendChild(paper);
    var statusBox = make('div');
    statusBox.id = 'receipt-status';
    box.appendChild(statusBox);
    var next = make('button', 'big', 'New sale');
    next.type = 'button';
    next.onclick = function () { ui.receiptId = null; show('receipt-box', false); show('sell-form', true); };
    var printIt = make('button', 'outlined wide', 'Print receipt');
    printIt.type = 'button';
    printIt.onclick = function () { printReceipt(receipt, false); };
    box.appendChild(next);
    box.appendChild(printIt);
    show('receipt-box', true);
    show('sell-form', false);
    updateReceiptStatus();
  }

  function updateReceiptStatus() {
    updateRefundReceiptStatus();
    if (!ui.receiptId || !el('receipt-status')) { return; }
    var line = receiptStatusLine(ui.receiptId);
    say('receipt-status', line.kind, line.text);
  }

  // ---- online (Paystack) payments ----------------------------------------------------------------------------
  function findWaiting(saleId) {
    var list = core.online();
    for (var i = 0; i < list.length; i++) {
      if (list[i].saleId === saleId) { return list[i]; }
    }
    return null;
  }

  function historyFor(saleId) {
    var list = core.history();
    for (var i = 0; i < list.length; i++) {
      if (list[i].receipt.saleId === saleId) { return list[i]; }
    }
    return null;
  }

  function sendWaitingSales() {
    core.flush(function (error) {
      ui.lastSyncProblem = error ? error.message : '';
      if (core.currentUser()) {
        renderBanner('till-sales');
        updateReceiptStatus();
        renderSales();
      } else {
        route();
      }
    });
  }

  /** mode 'prompt': an M-Pesa PIN prompt goes to the customer's phone; mode 'qr': a code on this screen for the customer to scan. */
  function startOnlineSale(t, cart, mode) {
    var phone = el('paystack-phone').value.replace(/^\s+|\s+$/g, '');
    if (mode === 'prompt') {
      var digits = phone.replace(/[^0-9]/g, '');
      if (digits.length < 9 || digits.length > 13) {
        say('sell-message', 'warn', 'Enter the customer\'s M-Pesa number, like 0712 345 678.');
        return;
      }
    }
    ui.starting = true;
    setBusy('complete-button', true, mode === 'prompt' ? 'Sending the prompt...' : completeLabel());
    setBusy('show-qr-button', true, mode === 'qr' ? 'Contacting Paystack...' : null);
    say('sell-message', '', '');
    core.startOnline({
      cart: cart,
      saleType: ui.saleType,
      discountCents: t.discount,
      customerName: '',
      customerPhone: phone,
      mpesaPhone: mode === 'prompt' ? phone : ''
    }, function (error, started) {
      ui.starting = false;
      setBusy('complete-button', false, completeLabel());
      setBusy('show-qr-button', false, 'Show a code instead (the customer scans it)');
      if (error) {
        renderCart();
        say('sell-message', 'bad', error.message);
        return;
      }
      resetSale();
      renderAll();
      openPayScreen(started.receipt.saleId);
      sendWaitingSales();
    });
  }

  // ---- paying on this iPad: away to Paystack and back --------------------------------------------------------
  function writeReturnToken(saleId) {
    var user = core.currentUser();
    try {
      window.sessionStorage.setItem(RETURN_KEY, JSON.stringify({ saleId: saleId, userId: user ? user.id : null, when: new Date().getTime() }));
      return true;
    } catch (e) {
      return false; // private browsing: still goes, but the cashier will have to log in again on the way back
    }
  }

  function readReturnToken() {
    try {
      var raw = window.sessionStorage.getItem(RETURN_KEY);
      if (!raw) { return null; }
      var token = JSON.parse(raw);
      if (token && token.saleId && token.userId && (new Date().getTime() - token.when) < RETURN_VALID_MS) { return token; }
    } catch (e) {
      // unreadable: treated as none
    }
    clearReturnToken();
    return null;
  }

  function clearReturnToken() {
    try { window.sessionStorage.removeItem(RETURN_KEY); } catch (e) { /* nothing to clear */ }
  }

  /** Leaves the till for the Paystack payment page (the sale is already saved as waiting on this iPad). */
  function goToPaymentPage(saleId) {
    var item = findWaiting(saleId);
    if (!item) { return; }
    writeReturnToken(saleId);
    say('sell-message', 'warn', 'Opening the payment page...');
    window.location.href = item.authorizationUrl;
  }

  /** Back from Paystack (or from pressing Back there): show where that payment stands, and the receipt if it is paid. */
  function resumePayment(saleId) {
    ui.tab = 'sell';
    showTab('sell');
    openPayScreen(saleId);
    say('pay-status', 'warn', 'Checking the payment...');
    payPoll(false);
  }

  function stopPayPoll() {
    if (ui.payTimer) { window.clearTimeout(ui.payTimer); }
    ui.payTimer = null;
  }

  function schedulePayPoll(delay) {
    stopPayPoll();
    ui.payTimer = window.setTimeout(function () { payPoll(false); }, delay);
  }

  function closePayScreen() {
    stopPayPoll();
    clearReturnToken();
    ui.payingId = null;
    show('retry-box', false);
    show('pay-screen', false);
    show('receipt-box', false);
    show('sell-form', true);
  }

  /** A prompt the customer did not approve can be sent again, to the same or a corrected number. */
  function showRetry(item) {
    var can = !!(item && item.canRetry);
    show('retry-box', can);
    if (can && el('retry-phone').value === '') { el('retry-phone').value = item.phone; }
  }

  function openPayScreen(saleId) {
    var item = findWaiting(saleId);
    if (!item) { return; }
    ui.payingId = saleId;
    el('retry-phone').value = '';
    renderOnline();
    setText('pay-amount', core.formatCents(item.amountCents));
    setText('pay-number', 'Sale ' + item.saleNumber);
    var drawn = false;
    if (!item.viaPrompt && typeof window.qrcode === 'function') {
      try {
        var qr = window.qrcode(0, 'M');
        qr.addData(item.authorizationUrl);
        qr.make();
        el('pay-qr').src = qr.createDataURL(7, 2);
        drawn = true;
      } catch (e) {
        drawn = false;
      }
    }
    show('pay-qr', drawn);
    show('pay-open', !item.viaPrompt && OFFER_PAY_ON_THIS_DEVICE);
    setText('pay-title', item.viaPrompt ? 'Waiting for the customer to approve' : 'Waiting for the customer to pay');
    if (item.viaPrompt) {
      setText('pay-help', 'An M-Pesa prompt was sent to ' + item.phone + '. Ask the customer to enter their M-Pesa PIN on their phone. This screen updates by itself when the payment arrives.');
    } else {
      setText('pay-help', drawn
        ? 'Ask the customer to scan this code with their phone camera, then pay on their phone (M-Pesa or card). This screen updates by itself when the payment arrives.'
        : 'The payment code could not be drawn on this iPad. Use "Pay on this iPad instead".');
    }
    say('pay-status', item.ended ? 'bad' : 'warn', item.ended ? ENDED_TEXT : 'Waiting for the payment...');
    showRetry(item);
    show('receipt-box', false);
    show('sell-form', false);
    show('pay-screen', true);
    showTab('sell');
    schedulePayPoll(PAY_POLL_MS);
  }

  /** The payment was confirmed: leave the waiting screen and show the receipt. */
  function paidNow(saleId) {
    var entry = historyFor(saleId);
    stopPayPoll();
    clearReturnToken();
    ui.payingId = null;
    show('retry-box', false);
    show('pay-screen', false);
    renderAll();
    if (entry && entry.payment === 'paid') {
      ui.receiptId = saleId;
      showReceipt(entry.receipt);
      sendWaitingSales();
    } else {
      show('sell-form', true);
    }
  }

  function payPoll(manual) {
    if (!ui.payingId) { return; }
    var id = ui.payingId;
    if (manual) { setBusy('pay-check', true, 'Checking...'); }
    core.checkOnline(function (error) {
      if (manual) { setBusy('pay-check', false, 'Check now'); }
      if (ui.payingId !== id) { return; }
      var waiting = findWaiting(id);
      if (!waiting) {
        paidNow(id);
        return;
      }
      showRetry(waiting);
      if (waiting.ended) {
        say('pay-status', 'bad', ENDED_TEXT);
      } else if (error) {
        say('pay-status', 'warn', error.code === 'offline' ? 'No internet right now. The payment is still waiting; checking again...' : 'Waiting for the payment... (' + error.message + ')');
      } else {
        say('pay-status', 'warn', 'Waiting for the payment...');
      }
      schedulePayPoll(PAY_POLL_MS);
    });
  }

  /** Ends a payment the customer is not going to make. Needs the internet: one last check first, so money that just arrived is never thrown away. */
  function cancelPayment(saleId, messageBoxId) {
    if (!window.confirm('Cancel this payment? Tell the customer NOT to pay. The items go back into stock.')) { return; }
    core.cancelOnline(saleId, function (error, outcome) {
      if (error) {
        say(messageBoxId, 'bad', error.message);
        return;
      }
      if (outcome.outcome === 'paid') {
        say('till-message', 'ok', 'The customer had just paid, so the sale was completed instead of cancelled.');
        paidNow(saleId);
        return;
      }
      if (ui.payingId === saleId) { closePayScreen(); }
      renderAll();
      sendWaitingSales();
    });
  }

  el('pay-check').onclick = function () { payPoll(true); };
  el('pay-cancel').onclick = function () { if (ui.payingId) { cancelPayment(ui.payingId, 'pay-status'); } };
  el('pay-later').onclick = function () { closePayScreen(); renderAll(); };

  function plainMoney(cents) {
    var whole = Math.floor(cents / 100);
    var rest = cents % 100;
    return String(whole) + (rest ? '.' + (rest < 10 ? '0' : '') + rest : '');
  }

  /** Puts a sale's items back in the cart (when a new prompt could not be sent), so nothing has to be typed again. */
  function restoreCart(request, phone) {
    ui.cart = [];
    for (var i = 0; i < request.cart.length; i++) {
      var line = request.cart[i];
      ui.cart.push(line.productId ? { productId: line.productId, name: line.name, qty: line.quantity } : { productId: null, name: line.name, qty: line.quantity, priceCents: line.unitPriceCents });
    }
    el('discount').value = request.discountCents > 0 ? plainMoney(request.discountCents) : '';
    el('cash-received').value = '';
    el('paystack-phone').value = phone;
    setSaleType(request.saleType === 'wholesale' ? 'wholesale' : 'retail');
    setPayment('paystack');
  }

  el('retry-button').onclick = function () {
    if (ui.starting || !ui.payingId) { return; }
    var phone = el('retry-phone').value.replace(/^\s+|\s+$/g, '');
    var digits = phone.replace(/[^0-9]/g, '');
    if (digits.length < 9 || digits.length > 13) {
      say('pay-status', 'warn', 'Enter the customer\'s M-Pesa number, like 0712 345 678.');
      return;
    }
    var oldId = ui.payingId;
    ui.starting = true;
    setBusy('retry-button', true, 'Sending the prompt...');
    core.retryPrompt(oldId, phone, function (error, result) {
      ui.starting = false;
      setBusy('retry-button', false, 'Send the prompt again');
      if (error) {
        say('pay-status', 'bad', error.message);
        return;
      }
      if (result.outcome === 'paid') {
        // The customer had approved it after all: that sale stands, and no second prompt was sent.
        paidNow(oldId);
        return;
      }
      if (result.outcome === 'started') {
        renderAll();
        openPayScreen(result.started.receipt.saleId);
        sendWaitingSales();
        return;
      }
      // The first sale is cancelled and the new prompt could not be sent: back to the cart with the same items.
      stopPayPoll();
      clearReturnToken();
      ui.payingId = null;
      show('pay-screen', false);
      show('retry-box', false);
      show('sell-form', true);
      restoreCart(result.request, phone);
      renderAll();
      showTab('sell');
      showView('cart');
      say('sell-message', 'bad', (/[.!?]$/.test(result.message) ? result.message : result.message + '.') + ' The items are back in the cart.');
      sendWaitingSales();
    });
  };
  // "Pay on this iPad instead" (from the code screen, or to try again): straight to the payment page; the till
  // comes back by itself when it is done.
  el('pay-open').onclick = function () {
    if (ui.payingId && findWaiting(ui.payingId)) { goToPaymentPage(ui.payingId); }
  };

  function renderNotices() {
    var box = el('till-notices');
    box.innerHTML = '';
    var list = core.notices();
    for (var i = 0; i < list.length; i++) {
      (function (notice) {
        var node = make('div', 'notice ' + notice.kind, notice.text + ' ');
        var done = make('button', 'small secondary', 'OK');
        done.type = 'button';
        done.onclick = function () { core.dismissNotice(notice.id); renderNotices(); };
        node.appendChild(done);
        box.appendChild(node);
      }(list[i]));
    }
  }

  function renderOnline() {
    var box = el('till-online');
    box.innerHTML = '';
    var list = [];
    var all = core.online();
    for (var w = 0; w < all.length; w++) {
      // The payment on the screen right now is already shown there in full.
      if (all[w].saleId !== ui.payingId) { list.push(all[w]); }
    }
    if (list.length === 0) { return; }
    var card = make('div', 'card');
    card.appendChild(make('h2', '', list.length === 1 ? 'A payment is waiting' : list.length + ' payments are waiting'));
    var table = make('table');
    var body = make('tbody');
    for (var i = 0; i < list.length; i++) {
      (function (item) {
        var row = make('tr', 'waitrow');
        var info = make('td', '', item.saleNumber);
        info.appendChild(make('div', 'sku', timeText(item.createdAt) + ' · ' + (item.ended ? 'not approved by the customer' : (item.viaPrompt ? 'prompt sent to ' + item.phone : 'waiting for the customer'))));
        row.appendChild(info);
        row.appendChild(make('td', 'num', core.formatCents(item.amountCents)));
        var actions = make('td', 'num');
        var showIt = make('button', 'small secondary', 'Show');
        showIt.type = 'button';
        showIt.onclick = function () { openPayScreen(item.saleId); };
        var cancelIt = make('button', 'small secondary', 'Cancel');
        cancelIt.type = 'button';
        cancelIt.onclick = function () { cancelPayment(item.saleId, 'till-message'); };
        actions.appendChild(showIt);
        actions.appendChild(cancelIt);
        row.appendChild(actions);
        body.appendChild(row);
      }(list[i]));
    }
    table.appendChild(body);
    card.appendChild(table);
    box.appendChild(card);
  }

  /** In the background (and when the page opens): has any waiting payment been made? */
  function checkWaitingPayments() {
    if (!core.getStatus().onlineWaiting) { return; }
    core.checkOnline(function (error, outcome) {
      if (outcome && outcome.paid > 0) { sendWaitingSales(); }
      if (ui.payingId && !findWaiting(ui.payingId)) { paidNow(ui.payingId); return; }
      if (core.currentUser()) { renderAll(); } else { route(); }
    });
  }

  // ---- the Sales tab -----------------------------------------------------------------------------------------
  /** The "Today on this iPad" card: what was sold since midnight, split by how it was paid. */
  function renderToday() {
    var s = core.todaySummary();
    var info = core.shopInfo();
    var body = el('today-rows');
    body.innerHTML = '';
    function row(label, value, className) {
      var tr = make('tr', className || '');
      tr.appendChild(make('td', '', label));
      tr.appendChild(make('td', 'num', value));
      body.appendChild(tr);
    }
    row('Sales', s.sales + (s.sales === 1 ? ' sale' : ' sales') + ' \u00b7 ' + s.items + (s.items === 1 ? ' item' : ' items'));
    row('Cash', core.formatCents(s.cashCents));
    row('M-Pesa', core.formatCents(s.mpesaCents));
    row('Online (Paystack)', core.formatCents(s.onlineCents));
    if (s.refunds > 0) { row('Refunds', s.refunds + (s.refunds === 1 ? ' refund' : ' refunds') + ' \u00b7 -' + core.formatCents(s.refundCents)); }
    row('Total (' + info.currency + ')', core.formatCents(s.totalCents), 'grand');
    setText('today-note', s.complete
      ? 'Only sales made on this iPad since midnight. Other devices are not included.'
      : 'This iPad keeps only its latest ' + 100 + ' sales, so today\'s figures may be missing some. Only sales made on this iPad are included.');
  }

  function renderSales() {
    renderToday();
    var body = el('sales-rows');
    body.innerHTML = '';
    var list = core.history();
    var user = core.currentUser();
    for (var i = 0; i < Math.min(list.length, 50); i++) {
      (function (entry) {
        var row = make('tr');
        var info = make('td', '', entry.receipt.saleNumber);
        info.appendChild(make('div', 'sku', timeText(entry.receipt.createdAt) + ' · ' + (entry.receipt.isRefund ? 'Refund of ' + entry.receipt.refundOfSaleNumber : methodLabel(entry.receipt.paymentMethod))));
        if (entry.status === 'rejected') { info.appendChild(make('div', 'sku', entry.error)); }
        row.appendChild(info);
        row.appendChild(make('td', 'num', (entry.receipt.isRefund ? '-' : '') + core.formatCents(entry.receipt.totalCents)));
        var state = make('td', 'num');
        var label = entry.status === 'sent' ? ['sent', 'Sent'] : (entry.status === 'rejected' ? ['lost', 'NOT recorded'] : (entry.status === 'discarded' ? ['waiting', 'Removed'] : ['waiting', 'Waiting']));
        if (entry.payment === 'awaiting') { label = ['waiting', 'Awaiting payment']; }
        else if (entry.payment === 'cancelled' && entry.status !== 'rejected') { label = ['cancel', 'Cancelled']; }
        state.appendChild(make('span', 'badge ' + label[0], label[1]));
        if ((entry.status === 'queued' || entry.status === 'sent') && entry.payment !== 'awaiting' && entry.payment !== 'cancelled') {
          var printAgain = make('button', 'small secondary', 'Print');
          printAgain.type = 'button';
          printAgain.style.marginTop = '6px';
          printAgain.onclick = function () { printReceipt(entry.receipt, true); };
          state.appendChild(make('div'));
          state.appendChild(printAgain);
        }
        if (entry.status === 'sent' && !entry.receipt.isRefund && entry.payment !== 'awaiting' && entry.payment !== 'cancelled' && canRefund()) {
          var refundIt = make('button', 'small secondary', 'Refund');
          refundIt.type = 'button';
          refundIt.style.marginTop = '6px';
          refundIt.onclick = function () { openRefund(entry.receipt.saleId, 'sales'); };
          state.appendChild(make('div'));
          state.appendChild(refundIt);
        }
        if (entry.status === 'rejected' && user && user.roleName === 'Admin') {
          var remove = make('button', 'small secondary', 'Remove');
          remove.type = 'button';
          remove.style.marginTop = '6px';
          remove.onclick = function () {
            if (window.confirm(entry.receipt.isRefund ? 'Remove this refund from the iPad? The shop has NO record of it. Only do this after the owner has dealt with it.' : 'Remove this sale from the iPad? It is a real sale that the shop has NO record of. Only do this after the owner has dealt with it.')) {
              core.discardRejected(entry.receipt.saleId);
              renderAll();
            }
          };
          state.appendChild(make('div'));
          state.appendChild(remove);
        }
        row.appendChild(state);
        body.appendChild(row);
      }(list[i]));
    }
    setText('sales-note', list.length === 0 ? 'No sales made on this iPad yet.' : 'The latest ' + Math.min(list.length, 50) + ' sales made on this iPad.');
  }

  // ---- the Products tab --------------------------------------------------------------------------------------
  function fillCategories() {
    var select = el('category');
    var chosen = select.value;
    select.innerHTML = '';
    var all = make('option', '', 'All categories');
    all.value = '';
    select.appendChild(all);
    var list = core.categories();
    for (var i = 0; i < list.length; i++) {
      var option = make('option', '', list[i].name);
      option.value = list[i].id;
      select.appendChild(option);
    }
    select.value = chosen;
  }

  function renderProducts() {
    var status = core.getStatus();
    var found = core.searchProducts(el('search').value, el('category').value || null, false);
    if (ui.lowOnly) {
      found = found.filter(function (p) { return p.stockQty <= p.reorderLevel; });
    }
    var note = el('product-note');
    note.innerHTML = '';
    if (ui.lowOnly) {
      var filterNotice = make('div', 'notice ok', 'Showing only the products at or below their reorder level. ');
      var showAll = make('button', 'small secondary', 'Show all');
      showAll.type = 'button';
      showAll.onclick = function () { ui.lowOnly = false; renderProducts(); };
      filterNotice.appendChild(showAll);
      note.appendChild(filterNotice);
    }
    var body = el('product-rows');
    body.innerHTML = '';
    var shown = Math.min(found.length, MAX_ROWS);
    for (var i = 0; i < shown; i++) {
      var p = found[i];
      var row = make('tr');
      var name = make('td', '', p.name);
      name.appendChild(make('div', 'sku', p.sku + (p.barcode ? '  ·  ' + p.barcode : '')));
      row.appendChild(name);
      row.appendChild(make('td', 'num', core.formatCents(p.retailPriceCents)));
      var stock = make('td', 'num', String(p.stockQty));
      stockBadge(stock, p);
      row.appendChild(stock);
      body.appendChild(row);
    }
    setText('product-count', found.length === 0
      ? 'No products match.'
      : (found.length > shown ? 'Showing the first ' + shown + ' of ' + found.length + ' products. Type in the search box to narrow it down.' : found.length + ' product' + (found.length === 1 ? '' : 's') + '. Prices in ' + status.currency + '.'));
  }
  el('search').oninput = (function () {
    var timer = null;
    return function () {
      if (timer) { window.clearTimeout(timer); }
      timer = window.setTimeout(renderProducts, 250);
    };
  }());
  el('category').onchange = renderProducts;

  // ---- actions -----------------------------------------------------------------------------------------------
  el('join-button').onclick = function () {
    say('setup-message', '', '');
    setBusy('join-button', true, 'Connecting...');
    core.join(el('invite').value, el('label').value, function (error) {
      setBusy('join-button', false, 'Connect');
      if (error) {
        // A failed connect can reset the device (e.g. the shop no longer knows it): show whatever screen is now right.
        route();
        say('setup-message', 'bad', error.message);
        return;
      }
      el('invite').value = '';
      route();
    });
  };

  /** The quick sign in button on the login screen: only when it is set up here and this browser can do it. */
  function drawQuickLogin() {
    var quick = core.quickSignInStatus();
    var on = quick.supported && !!quick.setUpFor;
    show('quick-login-button', on);
    if (on) { setText('quick-login-button', 'Sign in as ' + quick.setUpFor.name + ' with Face ID or passcode'); }
  }

  el('quick-login-button').onclick = function () {
    say('login-message', '', '');
    var label = el('quick-login-button').innerText;
    setBusy('quick-login-button', true, 'Waiting for Face ID or passcode...');
    core.quickLogin(function (error) {
      setBusy('quick-login-button', false, label);
      if (error) { say('login-message', error.code === 'cancelled' ? 'warn' : 'bad', error.message); return; }
      el('username').value = '';
      el('password').value = '';
      ui.tab = 'home';
      route();
      showTab('home');
      armIdleTimer();
    });
  };

  el('login-button').onclick = function () {
    say('login-message', '', '');
    setBusy('login-button', true, 'Checking...');
    core.login(el('username').value, el('password').value, function (error) {
      setBusy('login-button', false, 'Log in');
      el('password').value = '';
      if (error) { say('login-message', 'bad', error.message); return; }
      el('username').value = '';
      ui.tab = 'home';
      route();
      showTab('home');
      armIdleTimer();
    });
  };

  /** Send waiting sales, then refresh the shop data. Quiet in the background; the buttons show the result. */
  function doSync(manual, buttonId, messageId) {
    if (ui.syncing) { return; }
    ui.syncing = true;
    if (buttonId) { say(messageId, '', ''); setBusy(buttonId, true, 'Working...'); }
    core.sync(function (error) {
      ui.syncing = false;
      ui.lastSyncProblem = error ? error.message : '';
      if (buttonId) {
        setBusy(buttonId, false, buttonId === 'till-refresh' ? 'Send sales and update shop data' : 'Update shop data');
        if (error) { say(messageId, error.code === 'offline' ? 'warn' : 'bad', error.message); }
      }
      if (core.currentUser()) {
        setText('till-updated', updatedText(core.getStatus()));
        renderAll();
        if (ui.tab === 'expenses' && canUseExpenses()) { loadExpenseDay(ui.expDay); }
      } else {
        route();
      }
    });
  }
  el('login-refresh').onclick = function () { doSync(true, 'login-refresh', 'login-message'); };
  el('till-refresh').onclick = function () { doSync(true, 'till-refresh', 'till-message'); };

  function leaveTill() {
    // Logging out (or the idle timer) with a sale in progress puts it on hold instead of losing it.
    if (core.currentUser() && ui.cart.length > 0) { core.holdSale('Unfinished sale', currentDraft()); }
    resetSale();
    el('print-receipt').innerHTML = '';
    el('report-result').innerHTML = '';
    ui.home = null;
    ui.homeAt = 0;
    ui.report = null;
    ui.lowOnly = false;
    ui.expList = null;
    ui.expDay = null;
    ui.expToken += 1;
    clearSupportState();
    closeTillPhonePage();
    stopTillList();
    el('settings-page').innerHTML = '';
    ui.refund = null;
    ui.refundReceiptId = null;
    el('refund-password').value = '';
    el('refund-reason').value = '';
    el('refund-lines').innerHTML = '';
    el('refund-done').innerHTML = '';
    if (ui.tab === 'refund' || ui.tab === 'settings' || ui.tab === 'support') { ui.tab = 'home'; }
    el('exp-list').innerHTML = '';
    el('exp-refused').innerHTML = '';
    show('exp-form', false);
    core.logout();
    ui.receiptId = null;
    clearReturnToken();
    stopPayPoll();
    ui.payingId = null;
    show('pay-screen', false);
    route();
  }
  el('logout-button').onclick = leaveTill;
  el('forget-button').onclick = function () {
    var pending = core.getStatus().pendingSales + core.getStatus().rejectedSales;
    var pendingExpenses = core.getStatus().pendingExpenses + core.getStatus().rejectedExpenses;
    var held = core.getStatus().heldSales;
    var warning = pending > 0 || pendingExpenses > 0
      ? 'This iPad still holds ' + (pending > 0 ? pending + ' sale(s)' : '') + (pending > 0 && pendingExpenses > 0 ? ' and ' : '') + (pendingExpenses > 0 ? pendingExpenses + ' expense(s)' : '') + ' that the shop has not recorded. Disconnecting will DELETE them. Are you sure?'
      : (held > 0
        ? 'This iPad has ' + held + ' held sale(s). Disconnecting will throw them away. Are you sure?'
        : 'Disconnect this iPad from the shop? You will need a new invite code to connect again.');
    if (window.confirm(warning)) {
      core.forget();
      route();
    }
  };

  // ---- log out after 10 minutes with no touch -----------------------------------------------------------------
  var idleTimer = null;
  // While a new phone's key is on show the till waits at least this long: the administrator is busy on the phone, setting up
  // the shortcut, and a log out would hide the key for good.
  var KEY_ON_SHOW_IDLE_MINUTES = 30;
  function idleMinutesNow() {
    var minutes = ui.idleMinutes > 0 ? ui.idleMinutes : 10;
    if (tillPhone && tillPhone.key && minutes < KEY_ON_SHOW_IDLE_MINUTES) { minutes = KEY_ON_SHOW_IDLE_MINUTES; }
    return minutes;
  }
  function armIdleTimer() {
    if (idleTimer) { window.clearTimeout(idleTimer); }
    if (!core.currentUser()) { return; }
    idleTimer = window.setTimeout(leaveTill, idleMinutesNow() * 60 * 1000);
  }
  var activity = ['touchstart', 'click', 'keydown'];
  for (var a = 0; a < activity.length; a++) {
    document.addEventListener(activity[a], armIdleTimer, false);
  }

  // ---- keep sending: on load, every 30 seconds, and when the internet comes back ------------------------------
  window.setInterval(function () {
    if (core.getStatus().joined) { doSync(false); }
  }, SYNC_EVERY_MS);
  window.addEventListener('online', function () { if (core.getStatus().joined) { doSync(false); checkWaitingPayments(); } }, false);
  window.setInterval(checkWaitingPayments, BACKGROUND_PAY_CHECK_MS);

  // ---- money, dates and small helpers for the Dashboard and Reports -------------------------------------------------
  var MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /** "KES 1,250.00" - amounts are written with the currency, as in the apps. */
  function money(cents) { return core.shopInfo().currency + ' ' + core.formatCents(cents); }
  function clockText(date) { return two(date.getHours()) + ':' + two(date.getMinutes()); }
  function dayText(date) { return date.getFullYear() + '-' + two(date.getMonth() + 1) + '-' + two(date.getDate()); }
  /** The server writes times with 6 decimals ("...:06.123456Z"); an old Safari only understands 3. */
  function parseIso(text) {
    var ms = Date.parse(String(text || '').replace(/(\.\d{3})\d+Z$/, '$1Z'));
    return isNaN(ms) ? null : new Date(ms);
  }
  function parseDayText(text) {
    var found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
    return found ? new Date(Number(found[1]), Number(found[2]) - 1, Number(found[3])) : null;
  }
  function timeInReport(text, withDay) {
    var date = parseIso(text);
    if (!date) { return ''; }
    return withDay ? date.getDate() + ' ' + MONTHS3[date.getMonth()] + ' ' + clockText(date) : clockText(date);
  }
  function reportMethodLabel(method) { return method === 'cash' ? 'Cash' : (method === 'mpesa_manual' ? 'M-Pesa (Manual)' : 'M-Pesa'); }
  function capital(word) { return word ? word.charAt(0).toUpperCase() + word.slice(1) : ''; }

  // The "hide the figures" eye, remembered on this iPad.
  var UI_KEY = 'nexapos-lite-ui';
  try {
    var savedPrefs = storage ? storage.getItem(UI_KEY) : null;
    var parsedPrefs = savedPrefs ? JSON.parse(savedPrefs) : {};
    ui.hideFigures = !!parsedPrefs.hideFigures;
    ui.idleMinutes = parsedPrefs.idleMinutes === 1 || parsedPrefs.idleMinutes === 5 || parsedPrefs.idleMinutes === 30 ? parsedPrefs.idleMinutes : 10;
    ui.supportEmail = typeof parsedPrefs.supportEmail === 'string' ? parsedPrefs.supportEmail : '';
    ui.supportSeen = Object.prototype.toString.call(parsedPrefs.supportSeen) === '[object Array]' ? parsedPrefs.supportSeen.slice(-50) : [];
  } catch (e) {
    ui.hideFigures = false;
    ui.idleMinutes = 10;
    ui.supportEmail = '';
    ui.supportSeen = [];
  }
  function savePrefs() {
    try { if (storage) { storage.setItem(UI_KEY, JSON.stringify({ hideFigures: ui.hideFigures, idleMinutes: ui.idleMinutes, supportEmail: ui.supportEmail, supportSeen: ui.supportSeen })); } } catch (e) { /* not remembered */ }
  }

  // ---- the Dashboard: the apps' home screen, for the whole shop ---------------------------------------------------------
  var EYE_SHOWN = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';
  var EYE_HIDDEN = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>';
  var EYE_IDS = ['eye-sales', 'eye-profit', 'eye-stock'];

  function updateEyes() {
    for (var i = 0; i < EYE_IDS.length; i++) {
      el(EYE_IDS[i]).innerHTML = ui.hideFigures ? EYE_HIDDEN : EYE_SHOWN;
    }
  }
  function toggleFigures() {
    ui.hideFigures = !ui.hideFigures;
    savePrefs();
    renderHome();
  }
  for (var eyeIndex = 0; eyeIndex < EYE_IDS.length; eyeIndex++) { el(EYE_IDS[eyeIndex]).onclick = toggleFigures; }

  /** The apps' badge: how today compares with yesterday. */
  function drawChange(boxId, change) {
    var box = el(boxId);
    box.innerHTML = '';
    if (!change || ui.hideFigures) { return; }
    var arrow = change.direction === 'up' ? '▲ ' : (change.direction === 'down' ? '▼ ' : '– ');
    box.appendChild(make('span', 'pct ' + change.direction, arrow + Math.abs(change.percent) + '%'));
  }

  /** 12500 -> "12.5K", 1200000 -> "1.2M": the short numbers down the side of the chart, as in the apps. */
  function compactNumber(value) {
    var sign = value < 0 ? '-' : '';
    var n = Math.abs(value);
    function trimmed(x) { return String(Math.round(x * 10) / 10); }
    if (n >= 1000000) { return sign + trimmed(n / 1000000) + 'M'; }
    if (n >= 1000) { return sign + trimmed(n / 1000) + 'K'; }
    return sign + String(Math.round(n));
  }

  /**
   * "Last 7 Days", like the apps' chart: for each day three bars side by side - Sales, Expenses and Net Profit - on a scale
   * from the lowest profit to the highest figure, with a heavier line at zero. Touching a day shows its exact figures.
   */
  function drawTrend(days) {
    var box = el('trend-chart');
    box.innerHTML = '';
    setText('trend-detail', 'Tap a day for the exact figures');
    if (!days || days.length < 1) {
      box.appendChild(make('p', 'muted', 'Loading...'));
      return;
    }
    var W = 600;
    var H = 250;
    var left = 54;
    var right = 10;
    var top = 12;
    var bottom = 36;
    var series = [['salesTotalCents', '#515B92', 'Sales'], ['expensesTotalCents', '#F44336', 'Expenses'], ['netProfitCents', '#4CAF50', 'Net Profit']];
    var high = 0;
    var low = 0;
    var i;
    var s;
    for (i = 0; i < days.length; i++) {
      for (s = 0; s < series.length; s++) { high = Math.max(high, days[i][series[s][0]]); }
      low = Math.min(low, days[i].netProfitCents);
    }
    var empty = high === 0 && low === 0;
    // The apps' scale: 20% of headroom above the highest bar, and below the lowest loss; 100.00 when there is nothing at all.
    var maxY = high <= 0 ? 10000 : high * 1.2;
    var minY = low >= 0 ? 0 : low * 1.2;
    function yAt(value) { return top + (H - top - bottom) * (maxY - value) / (maxY - minY); }
    var groupWidth = (W - left - right) / days.length;
    var barWidth = Math.min(20, groupWidth / 4);
    var gap = barWidth / 5;
    var rootNode = svgNode('svg', { 'class': 'chart', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Sales, expenses and net profit for the last 7 days, as bars' });
    for (i = 0; i <= 4; i++) {
      var value = maxY - (maxY - minY) * i / 4;
      var gy = yAt(value);
      var zero = Math.abs(value) < 0.5;
      rootNode.appendChild(svgNode('line', { x1: String(left), x2: String(W - right), y1: String(gy), y2: String(gy), stroke: zero ? '#767680' : '#E4E1E9', 'stroke-width': zero ? '2' : '1' }));
      if (!ui.hideFigures) {
        var axis = svgNode('text', { x: String(left - 6), y: String(gy + 6), 'text-anchor': 'end', 'font-size': '18', fill: '#46464F' });
        axis.appendChild(document.createTextNode(compactNumber(value / 100)));
        rootNode.appendChild(axis);
      }
    }
    var zeroY = yAt(0);
    var shownGroup = null;
    for (i = 0; i < days.length; i++) {
      var groupLeft = left + groupWidth * i;
      var barsWidth = series.length * barWidth + (series.length - 1) * gap;
      var first = groupLeft + (groupWidth - barsWidth) / 2;
      var highlight = svgNode('rect', { x: String(groupLeft + 2), y: String(top), width: String(groupWidth - 4), height: String(H - top - bottom), fill: '#515B92', 'fill-opacity': '0', rx: '4' });
      rootNode.appendChild(highlight);
      for (s = 0; s < series.length; s++) {
        var v = days[i][series[s][0]];
        var y = yAt(v);
        var barTop = Math.min(y, zeroY);
        var barHeight = Math.abs(zeroY - y);
        if (v !== 0 && barHeight < 1) { barHeight = 1; }
        if (barHeight > 0) {
          rootNode.appendChild(svgNode('rect', { x: (first + s * (barWidth + gap)).toFixed(1), y: barTop.toFixed(1), width: barWidth.toFixed(1), height: barHeight.toFixed(1), fill: series[s][1], rx: '2' }));
        }
      }
      var date = parseDayText(days[i].date);
      var label = svgNode('text', { x: (groupLeft + groupWidth / 2).toFixed(1), y: String(H - 10), 'text-anchor': 'middle', 'font-size': '20', fill: '#46464F' });
      label.appendChild(document.createTextNode(i === days.length - 1 ? 'Today' : (date ? WEEKDAYS[date.getDay()] : '')));
      rootNode.appendChild(label);
      // a transparent cover over the whole day: easy to touch on an iPad, and it shows that day's exact figures below the chart
      var cover = svgNode('rect', { x: String(groupLeft), y: String(top), width: String(groupWidth), height: String(H - top), fill: '#000', 'fill-opacity': '0', style: 'cursor:pointer' });
      (function (day, mark) {
        cover.onclick = function () {
          if (shownGroup) { shownGroup.setAttribute('fill-opacity', '0'); }
          mark.setAttribute('fill-opacity', '0.1');
          shownGroup = mark;
          var when = parseDayText(day.date);
          var title = when ? WEEKDAYS[when.getDay()] + ', ' + when.getDate() + ' ' + MONTHS3[when.getMonth()] : day.date;
          function figure(cents) { return ui.hideFigures ? '******' : money(cents); }
          setText('trend-detail', title + ' \u00b7 Sales ' + figure(day.salesTotalCents) + ' \u00b7 Expenses ' + figure(day.expensesTotalCents) + ' \u00b7 Net Profit ' + figure(day.netProfitCents));
        };
      }(days[i], highlight));
      rootNode.appendChild(cover);
    }
    box.appendChild(rootNode);
    if (empty) { box.appendChild(make('p', 'muted', 'No sales or expenses in the last 7 days.')); }
  }

  function renderHome() {
    updateEyes();
    show('home-expenses', canUseExpenses());
    var d = ui.home;
    var stock = core.stockFigures();
    function shown(text) { return ui.hideFigures ? '******' : text; }
    setText('stat-sales', d ? shown(money(d.today.salesTotalCents)) : '–');
    setText('stat-sales-sub', d ? (d.today.transactionCount === 1 ? '1 transaction' : d.today.transactionCount + ' transactions') + (!ui.hideFigures && d.today.refundsCents > 0 ? ' \u00b7 refunds ' + money(d.today.refundsCents) : '') : '');
    drawChange('stat-sales-pct', d ? d.salesChange : null);
    setText('stat-profit', d ? shown(money(d.today.netProfitCents)) : '–');
    setText('stat-profit-sub', d ? 'Gross ' + shown(money(d.today.grossProfitCents)) : '');
    drawChange('stat-profit-pct', d ? d.netProfitChange : null);
    setText('stat-low', String(stock.lowStockCount));
    setText('stat-low-sub', stock.lowStockCount === 1 ? 'product at/below reorder level' : 'products at/below reorder level');
    setText('stat-stock', shown(money(stock.stockValueCents)));
    drawTrend(d ? d.last7 : null);
    setText('home-updated', ui.homeAt ? 'Shop figures updated ' + clockText(new Date(ui.homeAt)) + '. They include sales from every device.' : '');
  }

  function showHomeMessage(kind, text, withSend) {
    var box = el('home-message');
    box.innerHTML = '';
    if (!text) { return; }
    var notice = make('div', 'notice ' + kind, text + ' ');
    if (withSend) {
      var send = make('button', 'small secondary', 'Send now');
      send.type = 'button';
      send.onclick = function () { doSync(true); };
      notice.appendChild(send);
    }
    box.appendChild(notice);
  }

  function refreshHome(manual) {
    if (!core.currentUser() || ui.homeLoading) { return; }
    if (!manual && ui.homeAt && new Date().getTime() - ui.homeAt < 30000) { return; }
    ui.homeLoading = true;
    if (manual) { setBusy('home-refresh', true, 'Refreshing...'); }
    core.loadDashboard(function (error, data) {
      ui.homeLoading = false;
      setBusy('home-refresh', false, 'Refresh');
      if (!core.currentUser()) { return; }
      if (error) {
        showHomeMessage(error.code === 'offline' ? 'warn' : 'bad', error.message + (ui.home ? ' The figures shown are from ' + clockText(new Date(ui.homeAt)) + '.' : ''), false);
        renderHome();
        return;
      }
      ui.home = data;
      ui.homeAt = new Date().getTime();
      showHomeMessage('warn', data.waitingHere > 0
        ? data.waitingHere + (data.waitingHere === 1 ? ' sale on this iPad has' : ' sales on this iPad have') + ' not reached the shop yet, so ' + (data.waitingHere === 1 ? 'it is' : 'they are') + ' not in these figures.'
        : '', data.waitingHere > 0);
      renderHome();
    });
  }
  el('home-refresh').onclick = function () { refreshHome(true); };
  el('home-newsale').onclick = function () { ui.lowOnly = false; showTab('sell'); showView('pick'); };
  el('home-inventory').onclick = function () { ui.lowOnly = false; showTab('products'); };
  el('home-reports').onclick = function () { showTab('reports'); };
  el('home-sales').onclick = function () { ui.lowOnly = false; showTab('sales'); };
  el('home-expenses').onclick = function () { showTab('expenses'); };
  el('stat-low-card').onclick = function () { ui.lowOnly = true; showTab('products'); };
  window.setInterval(function () {
    if (core.currentUser() && ui.tab === 'home' && !document.hidden) { refreshHome(false); }
  }, 60000);

  // ---- Reports: the apps' Reports screen, for the whole shop ------------------------------------------------------------
  var REPORT_MODES = ['day', 'month', 'expenses', 'range'];

  function setReportMode(mode) {
    ui.reportMode = mode;
    for (var i = 0; i < REPORT_MODES.length; i++) { el('rm-' + REPORT_MODES[i]).className = REPORT_MODES[i] === mode ? 'on' : ''; }
    show('rf-date', mode === 'day' || mode === 'expenses');
    show('rf-month', mode === 'month');
    show('rf-range', mode === 'range');
    say('report-message', '', '');
  }
  for (var modeIndex = 0; modeIndex < REPORT_MODES.length; modeIndex++) {
    (function (mode) { el('rm-' + mode).onclick = function () { setReportMode(mode); }; }(REPORT_MODES[modeIndex]));
  }

  function initReports() {
    if (ui.reportsReady) { return; }
    ui.reportsReady = true;
    var now = new Date();
    var monthSelect = el('report-month');
    monthSelect.innerHTML = '';
    for (var m = 0; m < 12; m++) {
      var option = make('option', '', MONTHS_FULL[m]);
      option.value = String(m + 1);
      monthSelect.appendChild(option);
    }
    monthSelect.value = String(now.getMonth() + 1);
    var yearSelect = el('report-year');
    yearSelect.innerHTML = '';
    for (var y = now.getFullYear() + 1; y >= 2020; y--) {
      var yearOption = make('option', '', String(y));
      yearOption.value = String(y);
      yearSelect.appendChild(yearOption);
    }
    yearSelect.value = String(now.getFullYear());
    el('report-date').value = dayText(now);
    el('report-since').value = dayText(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
    el('report-until').value = dayText(now);
    setReportMode('day');
  }

  function readReportInput(mode) {
    if (mode === 'month') { return { year: el('report-year').value, month: el('report-month').value }; }
    if (mode === 'range') { return { since: el('report-since').value, until: el('report-until').value }; }
    return { date: el('report-date').value };
  }

  function metricTile(label, value) {
    var cell = make('div', 'metric');
    var card = make('div', 'card');
    card.appendChild(make('div', 'l', label));
    card.appendChild(make('div', 'v', value));
    cell.appendChild(card);
    return cell;
  }

  function reportCard(title, emptyText, rows) {
    var card = make('div', 'card');
    card.appendChild(make('h2', '', title));
    if (rows.length === 0) { card.appendChild(make('p', 'muted', emptyText)); }
    for (var i = 0; i < rows.length; i++) { card.appendChild(rows[i]); }
    return card;
  }

  function reportRow(title, sub, amount) {
    var row = make('div', 'rowline');
    var left = make('div', 'a');
    left.appendChild(make('div', '', title));
    if (sub) { left.appendChild(make('div', 'sku', sub)); }
    row.appendChild(left);
    row.appendChild(make('div', 'r', amount));
    return row;
  }

  function renderReport(report) {
    var box = el('report-result');
    box.innerHTML = '';
    var range = report.range;
    var monthly = range.mode === 'month';
    var multiDay = monthly || range.mode === 'range';
    var head = make('div', 'reporthead');
    head.appendChild(make('h2', '', range.title));
    head.appendChild(make('div', 'period', range.period));
    box.appendChild(head);
    if (report.waitingHere > 0) {
      var waiting = make('div', 'notice warn', report.waitingHere + (report.waitingHere === 1 ? ' sale on this iPad has' : ' sales on this iPad have') + ' not reached the shop yet, so ' + (report.waitingHere === 1 ? 'it is' : 'they are') + ' not in this report. ');
      var send = make('button', 'small secondary', 'Send now');
      send.type = 'button';
      send.onclick = function () { doSync(true); };
      waiting.appendChild(send);
      box.appendChild(waiting);
    }
    var metrics = make('div', 'metrics');
    metrics.appendChild(metricTile('Paid Sales', money(report.salesTotalCents)));
    if (report.refunds.length > 0) { metrics.appendChild(metricTile('Refunds', money(report.refundsTotalCents))); }
    metrics.appendChild(metricTile('Total Cash Received', money(report.cashReceivedCents)));
    metrics.appendChild(metricTile('Total Paid by M-Pesa', money(report.mpesaCents)));
    metrics.appendChild(metricTile('Total Expenses', money(report.expensesTotalCents)));
    if (monthly) { metrics.appendChild(metricTile('Gross Profit', money(report.grossProfitCents))); }
    metrics.appendChild(metricTile(monthly ? 'Net Profit' : 'Grand Total', money(monthly ? report.netProfitCents : report.grandTotalCents)));
    metrics.appendChild(metricTile('Transactions', String(report.transactionCount)));
    box.appendChild(metrics);
    var printIt = make('button', 'outlined small', 'Print');
    printIt.type = 'button';
    printIt.style.marginTop = '12px';
    printIt.onclick = printReport;
    box.appendChild(printIt);

    var saleRows = [];
    for (var i = 0; i < report.sales.length; i++) {
      var sale = report.sales[i];
      var saleSub = [sale.cashierName, capital(sale.saleType), reportMethodLabel(sale.paymentMethod), timeInReport(sale.createdAt, multiDay)];
      if (sale.refundedCents > 0) { saleSub.push(sale.refundedCents >= sale.totalCents ? 'Refunded' : 'Part refunded'); }
      var saleRow = reportRow(sale.itemNames || sale.saleNumber, saleSub.join(' \u00b7 '), money(sale.totalCents));
      if (sale.id && canRefund() && !(sale.refundedCents >= sale.totalCents)) {
        (function (saleId) {
          var refundButton = make('button', 'small secondary', 'Refund');
          refundButton.type = 'button';
          refundButton.onclick = function () { openRefund(saleId, 'reports'); };
          saleRow.lastChild.appendChild(make('div'));
          saleRow.lastChild.appendChild(refundButton);
        }(sale.id));
      }
      saleRows.push(saleRow);
    }
    var salesCard = reportCard('Sales', 'No paid sales for this period.', saleRows);
    if (report.salesTruncated) { salesCard.appendChild(make('p', 'muted', 'Only the latest ' + report.sales.length + ' of ' + report.transactionCount + ' sales are listed. The totals include all of them.')); }
    box.appendChild(salesCard);

    if (report.refunds.length > 0) {
      var refundRows = [];
      for (var f = 0; f < report.refunds.length; f++) {
        var refund = report.refunds[f];
        var refundSub = [refund.originalSaleNumber ? 'Refund of ' + refund.originalSaleNumber : 'Refund', refund.processedByName, reportMethodLabel(refund.paymentMethod), timeInReport(refund.createdAt, multiDay)];
        var refundRow = reportRow((refund.itemNames || refund.saleNumber) + (refund.reason ? ' (' + refund.reason + ')' : ''), refundSub.join(' \u00b7 '), '-' + money(refund.totalCents));
        refundRows.push(refundRow);
      }
      var refundsCard = reportCard('Refunds', 'No refunds for this period.', refundRows);
      if (report.refundsTruncated) { refundsCard.appendChild(make('p', 'muted', 'Only the latest ' + report.refunds.length + ' of ' + report.refundCount + ' refunds are listed. The total includes all of them.')); }
      var refundTotalLine = make('div', 'grandrow');
      refundTotalLine.appendChild(make('span', '', 'Total Refunds'));
      refundTotalLine.appendChild(make('span', '', '-' + money(report.refundsTotalCents)));
      refundsCard.appendChild(refundTotalLine);
      box.appendChild(refundsCard);
    }

    var expenseRows = [];
    for (var e = 0; e < report.expenses.length; e++) {
      var expense = report.expenses[e];
      expenseRows.push(reportRow(expense.title + (expense.note ? ' (' + expense.note + ')' : ''),
        expense.enteredByName + ' · ' + timeInReport(expense.createdAt, multiDay), money(expense.amountCents)));
    }
    var expensesCard = reportCard('Expenses', 'No expenses for this period.', expenseRows);
    if (report.expensesTruncated) { expensesCard.appendChild(make('p', 'muted', 'Only the first ' + report.expenses.length + ' expenses are listed. The total includes all of them.')); }
    var totalLine = make('div', 'grandrow');
    totalLine.appendChild(make('span', '', 'Total Expenses'));
    totalLine.appendChild(make('span', '', money(report.expensesTotalCents)));
    expensesCard.appendChild(totalLine);
    box.appendChild(expensesCard);

    var finish = make('div', 'card');
    if (monthly) {
      var gross = make('div', 'grandrow');
      gross.appendChild(make('span', '', 'Gross Profit'));
      gross.appendChild(make('span', '', money(report.grossProfitCents)));
      finish.appendChild(gross);
    }
    var last = make('div', 'grandrow bold');
    last.appendChild(make('span', '', monthly ? 'Net Profit' : 'Grand Total'));
    last.appendChild(make('span', '', money(monthly ? report.netProfitCents : report.grandTotalCents)));
    finish.appendChild(last);
    box.appendChild(finish);
  }

  el('report-view').onclick = function () {
    var range = window.NexaLiteCore.reportRange(ui.reportMode, readReportInput(ui.reportMode));
    if (!range.ok) { say('report-message', 'warn', range.message); return; }
    say('report-message', '', '');
    setBusy('report-view', true, 'Loading...');
    core.loadReport(range, function (error, report) {
      setBusy('report-view', false, 'View Report');
      if (!core.currentUser()) { return; }
      if (error) { say('report-message', error.code === 'offline' ? 'warn' : 'bad', error.message); return; }
      ui.report = report;
      renderReport(report);
    });
  };

  /** Prints the report on the iPad's printer (AirPrint), as a plain page. */
  function printReport() {
    var report = ui.report;
    if (!report) { return; }
    if (typeof window.print !== 'function') { window.alert('This browser cannot print.'); return; }
    var info = core.shopInfo();
    var monthly = report.range.mode === 'month';
    var multiDay = monthly || report.range.mode === 'range';
    var box = el('print-receipt');
    box.className = 'paper';
    box.style.width = '';
    box.innerHTML = '';
    function line(className, text) { box.appendChild(make('div', className, text)); }
    function rule(dashed) { box.appendChild(make('div', dashed ? 'pp-dash' : 'pp-solid')); }
    function pair(className, left, right) {
      var row = make('div', 'pp-row' + (className ? ' ' + className : ''));
      row.appendChild(make('span', '', left));
      row.appendChild(make('span', '', right));
      box.appendChild(row);
    }
    var i;
    line('pp-center pp-shop', info.name);
    line('pp-center pp-bold', report.range.title);
    line('pp-center', report.range.period);
    rule(false);
    pair('', 'Paid Sales', money(report.salesTotalCents));
    pair('', 'Total Cash Received', money(report.cashReceivedCents));
    pair('', 'Total Paid by M-Pesa', money(report.mpesaCents));
    pair('', 'Total Expenses', money(report.expensesTotalCents));
    if (monthly) { pair('', 'Gross Profit', money(report.grossProfitCents)); }
    pair('pp-bold', monthly ? 'Net Profit' : 'Grand Total', money(monthly ? report.netProfitCents : report.grandTotalCents));
    pair('', 'Transactions', String(report.transactionCount));
    rule(false);
    line('pp-bold', 'Sales');
    if (report.sales.length === 0) { line('', 'No paid sales for this period.'); }
    for (i = 0; i < report.sales.length; i++) {
      var sale = report.sales[i];
      pair('', sale.itemNames || sale.saleNumber, money(sale.totalCents));
      line('', '   ' + [sale.cashierName, reportMethodLabel(sale.paymentMethod), timeInReport(sale.createdAt, multiDay)].join(' / '));
    }
    if (report.refunds.length > 0) {
      rule(true);
      line('pp-bold', 'Refunds');
      for (i = 0; i < report.refunds.length; i++) {
        var refund = report.refunds[i];
        pair('', (refund.itemNames || refund.saleNumber), '-' + money(refund.totalCents));
        line('', '   ' + [refund.reason, refund.processedByName, timeInReport(refund.createdAt, multiDay)].filter(function (part) { return !!part; }).join(' / '));
      }
      pair('pp-bold', 'Total Refunds', '-' + money(report.refundsTotalCents));
    }
    rule(true);
    line('pp-bold', 'Expenses');
    if (report.expenses.length === 0) { line('', 'No expenses for this period.'); }
    for (i = 0; i < report.expenses.length; i++) {
      var expense = report.expenses[i];
      pair('', expense.title + (expense.note ? ' (' + expense.note + ')' : ''), money(expense.amountCents));
      line('', '   ' + expense.enteredByName + ' / ' + timeInReport(expense.createdAt, multiDay));
    }
    rule(false);
    line('pp-center', 'Powered by NEXAPOS');
    window.print();
  }

  // ---- Expenses: the apps' Expenses screen (an owner or a manager), for the whole shop ------------------------------------
  // One day at a time, with a total, Add and Delete - like the app. The list is the shop's (every device's expenses). An
  // expense is saved on this iPad first and sent with the sales; only the ones entered on this iPad carry a Delete, because
  // the shop's sync accepts a deletion only from the device that entered the expense.
  var WEEKDAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  ui.expDay = null;
  ui.expList = null;
  ui.expToken = 0;

  function canUseExpenses() {
    var user = core.currentUser();
    return !!user && (user.roleName === 'Admin' || user.roleName === 'Manager');
  }

  function expenseDayTitle(day) {
    var date = parseDayText(day);
    if (!date) { return ''; }
    var written = date.getDate() + ' ' + MONTHS3[date.getMonth()] + ' ' + date.getFullYear();
    return day === dayText(new Date()) ? 'Today, ' + written : WEEKDAYS_FULL[date.getDay()] + ', ' + written;
  }

  function expenseRow(r) {
    var row = make('div', 'rowline' + (r.deleting ? ' going' : ''));
    var left = make('div', 'a');
    left.appendChild(make('div', '', r.title));
    var sub = [timeInReport(r.createdAt, false), r.enteredByName];
    if (r.note) { sub.push(r.note); }
    var subLine = make('div', 'sku', sub.join(' \u00b7 '));
    if (r.pending) { subLine.appendChild(make('span', 'badge waiting', 'Waiting to send')); }
    if (r.deleting) { subLine.appendChild(make('span', 'badge waiting', 'Being deleted')); }
    left.appendChild(subLine);
    row.appendChild(left);
    var right = make('div', 'r');
    right.appendChild(make('div', '', money(r.amountCents)));
    if (r.mine && !r.deleting) {
      var remove = make('button', 'outlined small', 'Delete');
      remove.type = 'button';
      remove.onclick = function () { confirmDeleteExpense(r); };
      right.appendChild(remove);
    }
    row.appendChild(right);
    return row;
  }

  /** What the shop could not take (kept on the iPad, never silently dropped). */
  function renderRefusedExpenses() {
    var box = el('exp-refused');
    box.innerHTML = '';
    var refused = core.outbox().rejectedExpenses;
    for (var i = 0; i < refused.length; i++) {
      (function (item) {
        var card = make('div', 'notice bad', (item.deleting ? 'The shop did not delete "' : 'The shop did not record "') + item.title + '" (' + money(item.amountCents) + '): ' + item.message + ' ');
        var drop = make('button', 'small secondary', 'Remove this');
        drop.type = 'button';
        drop.onclick = function () {
          var gone = core.discardExpense(item.id);
          if (!gone.ok) { say('exp-message', 'bad', gone.message); return; }
          renderBanner('till-sales');
          renderRefusedExpenses();
        };
        card.appendChild(drop);
        box.appendChild(card);
      }(refused[i]));
    }
  }

  function renderExpenses(list, loading) {
    var box = el('exp-list');
    box.innerHTML = '';
    renderRefusedExpenses();
    if (!list) {
      setText('exp-total', '-');
      box.appendChild(make('p', 'muted', loading ? 'Loading...' : 'The list could not be loaded.'));
      setText('exp-note', '');
      return;
    }
    setText('exp-total', money(list.totalCents));
    if (list.rows.length === 0) { box.appendChild(make('p', 'muted', 'No expenses recorded for this day.')); }
    var foreign = false;
    for (var i = 0; i < list.rows.length; i++) {
      box.appendChild(expenseRow(list.rows[i]));
      if (!list.rows[i].mine && !list.rows[i].pending) { foreign = true; }
    }
    var notes = [];
    if (list.offline) { notes.push('No connection: only what is waiting on this iPad is shown.'); }
    if (list.truncated) { notes.push('Only the first ' + (list.rows.length - list.waiting) + ' expenses are listed. The total includes all of them.'); }
    if (foreign) { notes.push('An expense can only be deleted on the device where it was entered.'); }
    setText('exp-note', notes.join(' '));
  }

  function loadExpenseDay(day) {
    if (!canUseExpenses()) { return; }
    var today = dayText(new Date());
    if (!parseDayText(day)) { day = today; }
    if (day > today) { day = today; }
    ui.expDay = day;
    el('exp-date').value = day;
    setText('exp-title', expenseDayTitle(day));
    el('exp-next').disabled = day >= today;
    var token = ++ui.expToken;
    if (!ui.expList || ui.expList.day !== day) { ui.expList = null; renderExpenses(null, true); }
    core.loadExpenses(day, function (error, list) {
      if (token !== ui.expToken || !core.currentUser()) { return; }
      if (error) {
        say('exp-message', error.code === 'offline' ? 'warn' : 'bad', error.message);
        if (error.code === 'offline') {
          var rows = core.waitingExpenses(day);
          var sum = 0;
          for (var r = 0; r < rows.length; r++) { sum += rows[r].amountCents; }
          ui.expList = { day: day, rows: rows, totalCents: sum, truncated: false, waiting: rows.length, offline: true };
          renderExpenses(ui.expList, false);
        } else {
          ui.expList = null;
          renderExpenses(null, false);
        }
        return;
      }
      say('exp-message', '', '');
      ui.expList = list;
      renderExpenses(list, false);
    });
  }

  function openExpenses() {
    if (!canUseExpenses()) { showTab('home'); return; }
    show('exp-form', false);
    show('exp-add', true);
    say('exp-message', '', '');
    loadExpenseDay(ui.expDay || dayText(new Date()));
  }

  function shiftExpenseDay(delta) {
    var date = parseDayText(ui.expDay || dayText(new Date()));
    if (!date) { return; }
    loadExpenseDay(dayText(new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta)));
  }
  el('exp-prev').onclick = function () { shiftExpenseDay(-1); };
  el('exp-next').onclick = function () { shiftExpenseDay(1); };
  el('exp-date').onchange = function () { if (el('exp-date').value) { loadExpenseDay(el('exp-date').value); } };
  el('exp-back').onclick = function () { showTab('home'); };

  /** Sends what is waiting (the new expense and anything older), then shows the day again. */
  function sendExpensesThenShow() {
    core.flush(function (error) {
      ui.lastSyncProblem = error ? error.message : '';
      renderBanner('till-sales');
      if (!core.currentUser()) { route(); return; }
      if (error && (error.code === 'unauthorized' || error.code === 'forbidden')) { route(); return; }
      if (ui.tab === 'expenses') { loadExpenseDay(ui.expDay); }
    });
  }

  function confirmDeleteExpense(r) {
    if (!window.confirm('Delete expense?\n"' + r.title + '" (' + money(r.amountCents) + ') will be removed.')) { return; }
    var gone = core.deleteExpense(r.id);
    if (!gone.ok) { say('exp-message', 'bad', gone.message); return; }
    say('exp-message', '', '');
    if (gone.taken) {
      renderBanner('till-sales');
      loadExpenseDay(ui.expDay);
    } else {
      sendExpensesThenShow();
    }
  }

  function openExpenseForm(open) {
    show('exp-form', open);
    show('exp-add', !open);
    say('exp-form-message', '', '');
    if (open) {
      el('exp-name').value = '';
      el('exp-amount').value = '';
      el('exp-notetext').value = '';
      el('exp-name').focus();
    }
  }
  el('exp-add').onclick = function () { openExpenseForm(true); };
  el('exp-cancel').onclick = function () { openExpenseForm(false); };
  el('exp-save').onclick = function () {
    var typed = el('exp-amount').value;
    var cents = core.parseCents(typed);
    if (cents === null) {
      say('exp-form-message', 'warn', /\S/.test(typed) ? 'Type the amount as a number, for example 1250 or 1250.50.' : 'Enter an expense amount greater than zero.');
      return;
    }
    var added = core.addExpense({ title: el('exp-name').value, amountCents: cents, expenseDate: ui.expDay, note: el('exp-notetext').value });
    if (!added.ok) { say('exp-form-message', 'bad', added.message); return; }
    openExpenseForm(false);
    renderBanner('till-sales');
    loadExpenseDay(ui.expDay);
    sendExpensesThenShow();
  };

  // ---- the top bar: the apps' buttons ------------------------------------------------------------------------------------
  // Home, Refresh, Reports, Settings, Support and Log out, as icons; Search (on the dashboard) opens the inventory with the cursor in
  // its search box. Settings here only SHOWS the shop and this iPad (nothing is changed from the till); Support is a call and a chat.
  var barMessageTimer = null;
  function barNote(kind, text) {
    say('bar-message', kind, text);
    if (barMessageTimer) { window.clearTimeout(barMessageTimer); }
    barMessageTimer = text ? window.setTimeout(function () { say('bar-message', '', ''); }, 7000) : null;
  }

  /** Sends what is waiting, brings the shop's data up to date and reloads the dashboard figures. */
  function refreshEverything(buttonIds, messageId, after) {
    if (ui.syncing) { return; }
    ui.syncing = true;
    var i;
    for (i = 0; i < buttonIds.length; i++) { if (el(buttonIds[i])) { el(buttonIds[i]).disabled = true; } }
    core.sync(function (error) {
      ui.syncing = false;
      for (i = 0; i < buttonIds.length; i++) { if (el(buttonIds[i])) { el(buttonIds[i]).disabled = false; } }
      ui.lastSyncProblem = error ? error.message : '';
      if (!core.currentUser()) { route(); return; }
      setText('till-updated', updatedText(core.getStatus()));
      renderAll();
      if (messageId === 'bar-message') {
        barNote(error ? (error.code === 'offline' ? 'warn' : 'bad') : 'ok', error ? error.message : 'Up to date.');
      } else if (el(messageId)) {
        say(messageId, error ? (error.code === 'offline' ? 'warn' : 'bad') : 'ok', error ? error.message : 'Up to date.');
      }
      if (after) { after(error); }
      pollSupportBadge(true);
      refreshHome(true);
    });
  }
  el('bar-home').onclick = function () { ui.lowOnly = false; showTab('home'); };
  el('bar-refresh').onclick = function () { refreshEverything(['bar-refresh'], 'bar-message'); };
  el('bar-reports').onclick = function () { showTab('reports'); };
  el('bar-settings').onclick = function () { showTab('settings'); };
  el('bar-support').onclick = function () { showTab('support'); };
  el('home-search').onclick = function () {
    ui.lowOnly = false;
    showTab('products');
    var box = el('search');
    if (box) { box.focus(); }
  };

  // ===================================================================================================================
  // Support: tickets and a real conversation, as in the apps. The shop's own support endpoints do the work (see the core);
  // this is only the screens: the list of conversations, a new ticket (with photos), and the conversation itself with its
  // bubbles, the quoted message, reactions, "Delivered", photos, and a reply box that keeps trying until it gets through.
  // ===================================================================================================================
  var Core = window.NexaLiteCore;
  var support = { view: 'list', tickets: [], ticket: null, thread: null, replyTo: null, photos: [], ticketPhotos: [], pending: null, failed: null, sending: false, readThrough: 0, markingRead: false, loading: false, timer: null, badgeAt: 0, blobs: {} };
  var SUPPORT_POLL_MS = 20000;
  var SUPPORT_BADGE_MS = 120000;
  var MAX_PHOTOS = 4;

  function clearSupportState() {
    stopSupportPoll();
    for (var id in support.blobs) {
      if (support.blobs.hasOwnProperty(id)) {
        try { (window.URL || window.webkitURL).revokeObjectURL(support.blobs[id]); } catch (e) { /* nothing to let go of */ }
      }
    }
    support.view = 'list'; support.tickets = []; support.ticket = null; support.thread = null; support.replyTo = null; support.photos = []; support.ticketPhotos = [];
    support.pending = null; support.failed = null; support.sending = false; support.readThrough = 0; support.badgeAt = 0; support.blobs = {};
    closeSheet();
    closePhotoView();
    el('chat').innerHTML = '';
    el('chat-text').value = '';
    el('ticket-message').value = '';
    el('ticket-subject').value = '';
    updateSupportBadge();
  }

  function showSupportView(name) {
    support.view = name;
    show('support-list-view', name === 'list');
    show('support-new-view', name === 'new');
    show('support-thread-view', name === 'thread');
  }

  /** Which reply of support a ticket is waiting on (as the apps do): the ticket and its newest support message. */
  function replyToken(ticket) { return ticket.id + ':' + (ticket.lastMessageId || ticket.updatedAt); }

  /** Opening Support counts as having seen what is waiting: the dashboard note goes, the button keeps its number until the shop answers. */
  function markSupportSeen() {
    for (var i = 0; i < support.tickets.length; i++) {
      var token = replyToken(support.tickets[i]);
      if (support.tickets[i].status === 'pending' && ui.supportSeen.indexOf(token) < 0) { ui.supportSeen.push(token); }
    }
    ui.supportSeen = ui.supportSeen.slice(-50);
    savePrefs();
    updateSupportBadge();
  }

  /** The number on the Support button, and the note on the dashboard, when support has replied. */
  function updateSupportBadge() {
    var count = core.currentUser() ? core.supportRepliesWaiting() : 0;
    var button = el('bar-support');
    var old = el('bar-support-badge');
    if (old) { old.parentNode.removeChild(old); }
    button.title = count > 0 ? count + ' support ' + (count === 1 ? 'reply' : 'replies') + ' waiting' : 'Support';
    if (count > 0) {
      var badge = make('span', 'countbadge', String(count));
      badge.id = 'bar-support-badge';
      button.appendChild(badge);
    }
    var note = el('home-support');
    note.innerHTML = '';
    var unseen = 0;
    for (var t = 0; t < support.tickets.length; t++) {
      if (support.tickets[t].status === 'pending' && ui.supportSeen.indexOf(replyToken(support.tickets[t])) < 0) { unseen += 1; }
    }
    if (count > 0 && unseen > 0) {
      var card = make('div', 'notice ok supportnote', unseen + (unseen === 1 ? ' support reply is' : ' support replies are') + ' waiting for your shop. Tap to read ' + (unseen === 1 ? 'it' : 'them') + '.');
      card.onclick = function () { showTab('support'); };
      note.appendChild(card);
    }
  }

  /** Looks for replies now and then (cheap), so the button can say so. force: even if it was looked at a moment ago. */
  function pollSupportBadge(force) {
    if (!core.currentUser() || !core.getStatus().joined || document.hidden) { return; }
    var now = new Date().getTime();
    if (!force && now - support.badgeAt < SUPPORT_BADGE_MS) { return; }
    support.badgeAt = now;
    core.supportList(function (error, tickets) {
      if (!core.currentUser()) { return; }
      if (!error) {
        support.tickets = tickets;
        if (ui.tab === 'support' && support.view === 'list') { renderTickets(); }
      }
      updateSupportBadge();
    });
  }
  window.setInterval(function () { pollSupportBadge(false); }, SUPPORT_BADGE_MS);

  function supportStamp(text) {
    var ms = Core.supportTime(text);
    if (ms === null) { return ''; }
    var label = Core.supportDayLabel(ms, new Date().getTime());
    return label + ' ' + Core.supportClock(ms);
  }

  function renderSupport() {
    stopSupportPoll();
    showSupportView('list');
    renderTickets();
    loadSupportList(false);
  }

  function loadSupportList(manual) {
    if (support.loading) { return; }
    support.loading = true;
    if (manual || support.tickets.length === 0) { say('support-message', 'warn', 'Loading your conversations...'); }
    core.supportList(function (error, tickets) {
      support.loading = false;
      if (!core.currentUser()) { return; }
      if (error) {
        say('support-message', error.code === 'offline' ? 'warn' : 'bad', error.message);
        updateSupportBadge();
        return;
      }
      say('support-message', '', '');
      support.tickets = tickets;
      support.badgeAt = new Date().getTime();
      renderTickets();
      markSupportSeen();
    });
  }

  function renderTickets() {
    var box = el('support-tickets');
    box.innerHTML = '';
    var waiting = 0;
    var i;
    for (i = 0; i < support.tickets.length; i++) { if (support.tickets[i].status === 'pending') { waiting += 1; } }
    setText('support-sub', waiting === 0 ? 'Follow your requests and messages from NexaPOS Support.' : (waiting === 1 ? '1 reply' : waiting + ' replies') + ' waiting for your shop.');
    if (support.tickets.length === 0) {
      var empty = make('div', 'card');
      empty.appendChild(make('h2', '', 'Need help?'));
      empty.appendChild(make('p', '', 'Open a support ticket and describe the issue. Your shop can return here to follow the conversation.'));
      box.appendChild(empty);
    }
    for (i = 0; i < support.tickets.length; i++) {
      (function (ticket) {
        var row = make('button', 'ticket' + (ticket.status === 'pending' ? ' waiting' : ''));
        row.type = 'button';
        row.appendChild(make('div', 'subject', ticket.subject));
        var stamp = supportStamp(ticket.updatedAt);
        row.appendChild(make('div', 'meta', '#' + ticket.id + ' \u00b7 ' + Core.supportStatusLabel(ticket.status) + (stamp ? ' \u00b7 ' + stamp : '')));
        row.onclick = function () { openThread(ticket); };
        box.appendChild(row);
      }(support.tickets[i]));
    }
  }

  el('support-back').onclick = function () { stopSupportPoll(); showTab('home'); };
  el('support-refresh').onclick = function () { loadSupportList(true); };
  el('support-new').onclick = function () { openNewTicket(); };

  // ---- a new ticket ---------------------------------------------------------------------------------------------------------
  function lastTicketEmail() {
    for (var i = 0; i < support.tickets.length; i++) {
      if (support.tickets[i].email) { return support.tickets[i].email; }
    }
    return ui.supportEmail || '';
  }

  function openNewTicket() {
    support.ticketPhotos = [];
    el('ticket-subject').value = '';
    el('ticket-message').value = '';
    el('ticket-email').value = lastTicketEmail();
    say('ticket-message-box', '', '');
    renderThumbs('ticket-thumbs', support.ticketPhotos);
    setBusy('ticket-send', false, 'Send ticket');
    showSupportView('new');
    el('ticket-subject').focus();
  }
  el('support-new-back').onclick = function () { showSupportView('list'); };

  el('ticket-send').onclick = function () {
    var photos = [];
    for (var i = 0; i < support.ticketPhotos.length; i++) { photos.push(support.ticketPhotos[i].data); }
    var email = el('ticket-email').value;
    say('ticket-message-box', '', '');
    setBusy('ticket-send', true, 'Sending...');
    core.supportOpen({ subject: el('ticket-subject').value, message: el('ticket-message').value, email: email, photos: photos }, function (error, ticketId) {
      setBusy('ticket-send', false, 'Send ticket');
      if (!core.currentUser()) { return; }
      if (error) { say('ticket-message-box', error.code === 'offline' ? 'warn' : 'bad', error.message); return; }
      ui.supportEmail = email.replace(/^\s+|\s+$/g, '');
      savePrefs();
      var opened = { id: ticketId, subject: el('ticket-subject').value.replace(/^\s+|\s+$/g, ''), status: 'open', email: ui.supportEmail, createdAt: '', updatedAt: '' };
      support.tickets = [opened].concat(support.tickets);
      openThread(opened);
    });
  };

  // ---- photos: chosen from the iPad's library or taken with its camera, shrunk, sent as base64 -------------------------------------
  /** A photo from the file input, shrunk to at most 1280 pixels on its long side and re-saved as a JPEG: cb(error) or cb(null, {data, preview}). */
  function preparePhoto(file, cb) {
    var reader = new FileReader();
    reader.onerror = function () { cb(new Error('That photo could not be read.')); };
    reader.onload = function () {
      var image = new Image();
      image.onerror = function () { cb(new Error('That file is not a photo this iPad can read.')); };
      image.onload = function () {
        var scale = Math.min(1, 1280 / Math.max(image.width, image.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        var url = canvas.toDataURL('image/jpeg', 0.8);
        cb(null, { data: url.split(',')[1], preview: url });
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function renderThumbs(boxId, list) {
    var box = el(boxId);
    box.innerHTML = '';
    for (var i = 0; i < list.length; i++) {
      (function (index) {
        var cell = make('div', 'thumb');
        var img = make('img');
        img.src = list[index].preview;
        img.alt = 'Photo ' + (index + 1);
        var remove = make('button', '', '\u00d7');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Take this photo off');
        remove.onclick = function () { list.splice(index, 1); renderThumbs(boxId, list); };
        cell.appendChild(img);
        cell.appendChild(remove);
        box.appendChild(cell);
      }(i));
    }
  }

  /** Adds the chosen files to [list] (at most four in all), then calls [then]. */
  function addPhotos(input, list, boxId, messageBoxId) {
    var files = input.files ? Array.prototype.slice.call(input.files) : [];
    input.value = '';
    var room = MAX_PHOTOS - list.length;
    if (files.length > room) { say(messageBoxId, 'warn', 'Attach up to 4 photos per message.'); files = files.slice(0, Math.max(room, 0)); }
    (function next(index) {
      if (index >= files.length) { renderThumbs(boxId, list); return; }
      preparePhoto(files[index], function (error, photo) {
        if (error) { say(messageBoxId, 'bad', error.message); } else { list.push(photo); }
        next(index + 1);
      });
    }(0));
  }
  el('ticket-attach').onclick = function () { el('ticket-file').click(); };
  el('ticket-file').onchange = function () { addPhotos(el('ticket-file'), support.ticketPhotos, 'ticket-thumbs', 'ticket-message-box'); };
  el('chat-attach').onclick = function () { el('chat-file').click(); };
  el('chat-file').onchange = function () { addPhotos(el('chat-file'), support.photos, 'chat-thumbs', 'thread-message'); };

  /** A private photo of a ticket: fetched with the device key, then shown from memory. */
  function loadPhoto(node, id) {
    if (support.blobs[id]) { node.src = support.blobs[id]; return; }
    var request = core.supportPhotoRequest(id);
    if (!request || !window.XMLHttpRequest) { return; }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', request.url, true);
    xhr.responseType = 'blob';
    for (var name in request.headers) { if (request.headers.hasOwnProperty(name)) { xhr.setRequestHeader(name, request.headers[name]); } }
    xhr.onload = function () {
      if (xhr.status === 200 && xhr.response) {
        var url = (window.URL || window.webkitURL).createObjectURL(xhr.response);
        support.blobs[id] = url;
        node.src = url;
      }
    };
    xhr.send();
  }

  function closePhotoView() {
    var old = el('photo-view');
    if (old) { old.parentNode.removeChild(old); }
  }
  function showPhotoView(url) {
    closePhotoView();
    var cover = make('div', 'photoview');
    cover.id = 'photo-view';
    var img = make('img');
    img.src = url;
    var close = make('button', 'secondary', 'Close');
    close.type = 'button';
    cover.onclick = closePhotoView;
    cover.appendChild(img);
    cover.appendChild(close);
    document.body.appendChild(cover);
  }

  // ---- the conversation ---------------------------------------------------------------------------------------------------------
  function stopSupportPoll() {
    if (support.timer) { window.clearInterval(support.timer); support.timer = null; }
  }
  function startSupportPoll() {
    stopSupportPoll();
    // New replies and reactions from support show up without leaving and coming back.
    support.timer = window.setInterval(function () {
      if (support.view === 'thread' && ui.tab === 'support' && !document.hidden && !support.sending && core.currentUser()) { loadThread(true, false); }
    }, SUPPORT_POLL_MS);
  }

  function openThread(ticket) {
    support.ticket = ticket;
    support.thread = null;
    support.replyTo = null;
    support.photos = [];
    support.pending = null;
    support.failed = null;
    support.readThrough = 0;
    el('chat').innerHTML = '';
    el('chat-text').value = '';
    el('chat-text').style.height = '44px';
    renderThumbs('chat-thumbs', support.photos);
    renderReplying();
    setText('thread-subject', ticket.subject);
    setText('thread-status', Core.supportStatusLabel(ticket.status));
    setText('thread-email', ticket.email ? 'Email updates: ' + ticket.email : '');
    show('thread-close', ticket.status !== 'closed');
    say('thread-message', 'warn', 'Loading the conversation...');
    showSupportView('thread');
    loadThread(false, true);
    startSupportPoll();
  }

  function nearBottom() {
    var chat = el('chat');
    return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
  }
  function scrollChatToEnd() {
    var chat = el('chat');
    chat.scrollTop = chat.scrollHeight;
    window.setTimeout(function () { chat.scrollTop = chat.scrollHeight; }, 60);
  }

  /** quiet: a background refresh - it never replaces what is on screen with an error. */
  function loadThread(quiet, toEnd) {
    var ticketId = support.ticket.id;
    core.supportThread(ticketId, function (error, thread) {
      if (!core.currentUser() || !support.ticket || support.ticket.id !== ticketId || support.view !== 'thread') { return; }
      if (error) {
        if (quiet && support.thread) { return; }
        say('thread-message', error.code === 'offline' ? 'warn' : 'bad', error.message);
        return;
      }
      if (!support.sending) { say('thread-message', '', ''); }
      var stay = !support.thread || nearBottom();
      var grew = !support.thread || thread.messages.length > support.thread.messages.length;
      support.thread = thread;
      support.ticket = thread.ticket;
      renderThread();
      if (toEnd || (stay && grew)) { scrollChatToEnd(); }
      markRepliesRead();
    });
  }

  /** Support is told which replies have been seen (it shows them as read) once they are on the screen. */
  function markRepliesRead() {
    if (support.markingRead || document.hidden || !support.thread) { return; }
    var through = 0;
    for (var i = 0; i < support.thread.messages.length; i++) {
      if (support.thread.messages[i].sender === 'support' && support.thread.messages[i].id > through) { through = support.thread.messages[i].id; }
    }
    if (through <= support.readThrough) { return; }
    support.markingRead = true;
    var ticketId = support.ticket.id;
    core.supportMarkRead(ticketId, through, function (error) {
      support.markingRead = false;
      if (!error) { support.readThrough = through; pollSupportBadge(true); }
    });
  }

  function renderThread() {
    var thread = support.thread;
    var ticket = thread.ticket;
    var shop = core.shopInfo().name;
    setText('thread-subject', ticket.subject);
    setText('thread-status', Core.supportStatusLabel(ticket.status));
    setText('thread-email', ticket.email ? 'Email updates: ' + ticket.email : '');
    show('thread-close', ticket.status !== 'closed');
    el('chat-text').placeholder = ticket.status === 'closed' ? 'Reply to reopen this ticket...' : 'Reply to this ticket...';
    var chat = el('chat');
    var keep = chat.scrollTop;
    chat.innerHTML = '';
    var now = new Date().getTime();
    var previousDay = null;
    var lastIndex = thread.messages.length - 1;
    for (var i = 0; i < thread.messages.length; i++) {
      var message = thread.messages[i];
      var sent = Core.supportTime(message.createdAt);
      if (sent !== null) {
        var dayKey = new Date(sent).toDateString();
        if (dayKey !== previousDay) { previousDay = dayKey; chat.appendChild(make('div', 'day', Core.supportDayLabel(sent, now))); }
      }
      chat.appendChild(messageRow(message, sent, shop, i === lastIndex && !support.pending));
    }
    if (support.pending) { chat.appendChild(pendingRow(shop)); }
    chat.scrollTop = keep;
  }

  function quoteName(sender, shop) { return sender === 'support' ? 'NexaPOS Support' : (shop || 'Your shop'); }

  function messageRow(message, sent, shop, isLast) {
    var mine = message.sender === 'customer';
    var row = make('div', 'msg ' + (mine ? 'mine' : 'theirs'));
    row.id = 'msg-' + message.id;
    var bubble = make('div', 'bubble');
    if (message.replyTo) {
      var quote = make('div', 'quote');
      quote.appendChild(make('b', '', quoteName(message.replyTo.sender, shop)));
      quote.appendChild(document.createTextNode(message.replyTo.snippet || 'Photo'));
      quote.onclick = function (event) { event.stopPropagation(); jumpTo(message.replyTo.id); };
      bubble.appendChild(quote);
    }
    bubble.appendChild(make('div', 'who', quoteName(message.sender, shop)));
    if (message.body) { bubble.appendChild(make('div', 'body', message.body)); }
    for (var a = 0; a < message.attachments.length; a++) {
      (function (attachment) {
        var img = make('img', 'photo');
        img.alt = 'Photo';
        img.onclick = function (event) { event.stopPropagation(); if (img.src) { showPhotoView(img.src); } };
        bubble.appendChild(img);
        loadPhoto(img, attachment.id);
      }(message.attachments[a]));
    }
    bubble.onclick = function () { showMessageMenu(message); };
    row.appendChild(bubble);
    if (message.reactions.length > 0) {
      var reacts = make('div', 'reacts');
      for (var r = 0; r < message.reactions.length; r++) {
        reacts.appendChild(make('span', message.reactions[r].sender === 'customer' ? 'me' : '', message.reactions[r].emoji));
      }
      row.appendChild(reacts);
    }
    if (sent !== null) { row.appendChild(make('div', 'time', Core.supportClock(sent))); }
    if (isLast && mine) { row.appendChild(make('div', 'status', 'Delivered')); }
    return row;
  }

  function pendingRow(shop) {
    var pending = support.pending;
    var row = make('div', 'msg mine');
    var bubble = make('div', 'bubble');
    bubble.style.opacity = '0.7';
    bubble.appendChild(make('div', 'who', quoteName('customer', shop)));
    if (pending.body) { bubble.appendChild(make('div', 'body', pending.body)); }
    if (pending.photoCount > 0) { bubble.appendChild(make('div', 'body', '\uD83D\uDCF7 ' + pending.photoCount + (pending.photoCount === 1 ? ' photo' : ' photos'))); }
    row.appendChild(bubble);
    var status = make('div', 'status' + (pending.failed ? ' bad' : ''), pending.failed ? 'Not delivered. Tap to try again' : 'Sending...');
    if (pending.failed) { status.style.cursor = 'pointer'; status.onclick = retryChat; bubble.onclick = retryChat; }
    row.appendChild(status);
    return row;
  }

  function jumpTo(messageId) {
    var row = el('msg-' + messageId);
    if (!row) { return; }
    var chat = el('chat');
    chat.scrollTop = Math.max(0, row.offsetTop - chat.offsetTop - 20);
    var bubble = row.firstChild;
    while (bubble && bubble.className !== 'bubble') { bubble = bubble.nextSibling; }
    if (bubble) {
      bubble.className = 'bubble flash';
      window.setTimeout(function () { bubble.className = 'bubble'; }, 1200);
    }
  }

  // ---- a message's menu: reactions, Reply, Copy text -------------------------------------------------------------------------------
  function closeSheet() {
    var old = el('sheet');
    if (old) { old.parentNode.removeChild(old); }
  }

  function myReaction(message) {
    for (var i = 0; i < message.reactions.length; i++) {
      if (message.reactions[i].sender === 'customer') { return message.reactions[i].emoji; }
    }
    return null;
  }

  function showMessageMenu(message) {
    closeSheet();
    var sheet = make('div', 'sheet');
    sheet.id = 'sheet';
    var panel = make('div', 'panel');
    var emojis = make('div', 'emojis');
    var mine = myReaction(message);
    for (var i = 0; i < Core.SUPPORT_REACTIONS.length; i++) {
      (function (emoji) {
        var button = make('button', emoji === mine ? 'on' : '', emoji);
        button.type = 'button';
        button.onclick = function () { closeSheet(); react(message, emoji === mine ? null : emoji); };
        emojis.appendChild(button);
      }(Core.SUPPORT_REACTIONS[i]));
    }
    panel.appendChild(emojis);
    var reply = make('button', 'item', 'Reply');
    reply.type = 'button';
    reply.onclick = function () { closeSheet(); startReply(message); };
    panel.appendChild(reply);
    if (message.body) {
      var copy = make('button', 'item', 'Copy text');
      copy.type = 'button';
      copy.onclick = function () { closeSheet(); copyText(message.body); };
      panel.appendChild(copy);
    }
    var cancel = make('button', 'item', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = closeSheet;
    panel.appendChild(cancel);
    sheet.onclick = function (event) { if (event.target === sheet) { closeSheet(); } };
    sheet.appendChild(panel);
    document.body.appendChild(sheet);
  }

  function copyText(text) {
    var box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', 'readonly');
    box.style.position = 'fixed';
    box.style.left = '-1000px';
    document.body.appendChild(box);
    box.select();
    try { box.setSelectionRange(0, text.length); document.execCommand('copy'); say('thread-message', 'ok', 'Copied.'); } catch (e) { say('thread-message', 'warn', 'This iPad would not copy that.'); }
    document.body.removeChild(box);
    window.setTimeout(function () { say('thread-message', '', ''); }, 1500);
  }

  /** Shows the reaction at once; puts things back if the shop's server does not take it. */
  function react(message, emoji) {
    var before = support.thread;
    var messages = [];
    for (var i = 0; i < before.messages.length; i++) {
      var m = before.messages[i];
      if (m.id === message.id) {
        var kept = [];
        for (var r = 0; r < m.reactions.length; r++) { if (m.reactions[r].sender !== 'customer') { kept.push(m.reactions[r]); } }
        if (emoji) { kept.push({ sender: 'customer', emoji: emoji }); }
        m = { id: m.id, sender: m.sender, body: m.body, createdAt: m.createdAt, replyTo: m.replyTo, reactions: kept, attachments: m.attachments };
      }
      messages.push(m);
    }
    support.thread = { ticket: before.ticket, messages: messages };
    renderThread();
    core.supportReact(support.ticket.id, message.id, emoji, function (error) {
      if (!error) { return; }
      support.thread = before;
      if (support.view === 'thread') { renderThread(); say('thread-message', 'bad', 'Could not save your reaction.'); }
    });
  }

  function renderReplying() {
    var box = el('chat-replying');
    box.innerHTML = '';
    if (!support.replyTo) { return; }
    var bar = make('div', 'replying');
    var text = make('div');
    text.appendChild(make('b', '', 'Replying to ' + (support.replyTo.sender === 'support' ? 'NexaPOS Support' : (core.shopInfo().name || 'yourself'))));
    var snippet = (support.replyTo.body || '').replace(/\s+/g, ' ');
    text.appendChild(make('div', '', snippet ? (snippet.length > 90 ? snippet.substring(0, 90) + '...' : snippet) : 'Photo'));
    var cancel = make('button', 'secondary small', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = function () { support.replyTo = null; renderReplying(); };
    bar.appendChild(text);
    bar.appendChild(cancel);
    box.appendChild(bar);
  }
  function startReply(message) {
    support.replyTo = message;
    renderReplying();
    el('chat-text').focus();
  }

  // ---- sending ------------------------------------------------------------------------------------------------------------------
  function sendChat() {
    var text = el('chat-text').value.replace(/^\s+|\s+$/g, '');
    if (support.sending || (!text && support.photos.length === 0)) { return; }
    var draft = { message: text, photos: support.photos.slice(0), replyTo: support.replyTo };
    el('chat-text').value = '';
    el('chat-text').style.height = '44px';
    support.photos = [];
    support.replyTo = null;
    renderThumbs('chat-thumbs', support.photos);
    renderReplying();
    deliver(draft);
  }

  /** Shows the message at once as "Sending...", then as delivered once the shop's server has it, or as "Not delivered" to tap and try again. */
  function deliver(draft) {
    var photos = [];
    for (var i = 0; i < draft.photos.length; i++) { photos.push(draft.photos[i].data); }
    support.sending = true;
    support.failed = null;
    support.pending = { body: draft.message, photoCount: draft.photos.length, failed: false };
    say('thread-message', '', '');
    renderThread();
    scrollChatToEnd();
    var ticketId = support.ticket.id;
    core.supportReply({ ticketId: ticketId, message: draft.message, photos: photos, replyToId: draft.replyTo ? draft.replyTo.id : null }, function (error) {
      support.sending = false;
      if (!core.currentUser() || !support.ticket || support.ticket.id !== ticketId) { return; }
      if (error) {
        support.failed = draft;
        support.pending.failed = true;
        if (support.view === 'thread') { renderThread(); scrollChatToEnd(); say('thread-message', error.code === 'offline' ? 'warn' : 'bad', error.message); }
        return;
      }
      support.pending = null;
      if (support.view === 'thread') { loadThread(true, true); }
    });
  }

  function retryChat() {
    if (support.failed && !support.sending) { deliver(support.failed); }
  }

  el('chat-send').onclick = sendChat;
  el('chat-text').oninput = function () {
    var box = el('chat-text');
    box.style.height = '44px';
    box.style.height = Math.min(box.scrollHeight, 120) + 'px';
  };
  el('thread-back').onclick = function () { stopSupportPoll(); closeSheet(); showSupportView('list'); renderTickets(); loadSupportList(false); };
  el('thread-refresh').onclick = function () { loadThread(false, false); };
  el('thread-close').onclick = function () {
    if (support.sending || !window.confirm('Close this ticket?\nYou can reopen it later by sending another reply.')) { return; }
    setBusy('thread-close', true, 'Closing...');
    core.supportClose(support.ticket.id, function (error) {
      setBusy('thread-close', false, 'Close ticket');
      if (!core.currentUser()) { return; }
      if (error) { say('thread-message', 'bad', error.message); return; }
      loadThread(false, false);
    });
  };

  // ===================================================================================================================
  // Settings: a menu of pages like the apps' (the pages the iPad can really do: the shop's data, licence and updates come
  // from the shop; the log-out time and the hidden figures are kept on this iPad).
  // ===================================================================================================================
  var SETTINGS_PAGES = [
    { id: 'security', title: 'Security & Privacy', admin: false },
    { id: 'business', title: 'Business & Receipts', admin: true },
    { id: 'tillphone', title: 'M-Pesa Till Phone', admin: true },
    { id: 'sync', title: 'Sync & This iPad', admin: true },
    { id: 'region', title: 'Date, Time & Region', admin: true },
    { id: 'license', title: 'My License', admin: false },
    { id: 'update', title: 'Software Update', admin: false }
  ];

  function isAdmin() {
    var user = core.currentUser();
    return !!user && user.roleName === 'Admin';
  }

  // ---- My License: as in the apps - the device ID on top, the status, and the time left counted down in tiles ----------------------
  var licenseTimer = null;
  function stopLicenseTicker() {
    if (licenseTimer) { window.clearInterval(licenseTimer); licenseTimer = null; }
  }

  function iconSvg(path) { return '<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true" focusable="false"><path fill="currentColor" d="' + path + '"/></svg>'; }
  var LICENSE_ICONS = {
    ok: iconSvg('M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z'),
    expired: iconSvg('M9.31 17l2.44-2.44L14.19 17l1.06-1.06-2.44-2.44 2.44-2.44L14.19 10l-2.44 2.44L9.31 10l-1.06 1.06 2.44 2.44-2.44 2.44L9.31 17zM19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z'),
    revoked: iconSvg('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z'),
    unknown: iconSvg('M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z')
  };

  /** The four tiles, as the apps draw them: Days, Hours, Minutes, Seconds. */
  function countdownTiles(ms) {
    var left = ms < 0 ? 0 : ms;
    var parts = [['Days', Math.floor(left / 86400000)], ['Hours', Math.floor(left / 3600000) % 24], ['Minutes', Math.floor(left / 60000) % 60], ['Seconds', Math.floor(left / 1000) % 60]];
    var box = make('div', 'countdown');
    for (var i = 0; i < parts.length; i++) {
      var tile = make('div', 'tile');
      tile.appendChild(make('b', '', (parts[i][1] < 10 ? '0' : '') + parts[i][1]));
      tile.appendChild(make('span', '', parts[i][0]));
      box.appendChild(tile);
    }
    return box;
  }

  function licenseExpiryText(ms) {
    var d = new Date(ms);
    return d.getDate() + ' ' + MONTHS3[d.getMonth()] + ' ' + d.getFullYear() + ', ' + clockText(d);
  }

  function renderLicensePage(box) {
    stopLicenseTicker();
    box.innerHTML = '';
    box.appendChild(make('h2', '', 'My License'));
    var status = core.getStatus();
    // the device ID, on top (and copyable, as in the apps)
    var idCard = make('div', 'card');
    var idRow = make('div', 'deviceid');
    var idText = make('div', 'idtext');
    idText.appendChild(make('b', '', 'Device ID'));
    idText.appendChild(document.createTextNode(status.deviceId || '-'));
    var copy = make('button', 'secondary small', 'Copy');
    copy.type = 'button';
    copy.setAttribute('aria-label', 'Copy device ID');
    copy.onclick = function () {
      copyToClipboard(status.deviceId || '');
      say('license-copied', 'ok', 'Device ID copied');
      window.setTimeout(function () { say('license-copied', '', ''); }, 1800);
    };
    idRow.appendChild(idText);
    idRow.appendChild(copy);
    idCard.appendChild(idRow);
    var copied = make('div');
    copied.id = 'license-copied';
    idCard.appendChild(copied);
    box.appendChild(idCard);

    // the status card
    var card = make('div', 'card');
    box.appendChild(card);
    var note = make('p', 'muted');
    box.appendChild(note);
    var recheck = make('button', 'secondary small', 'Check again');
    recheck.type = 'button';
    recheck.onclick = function () {
      recheck.disabled = true;
      note.textContent = 'Checking with the shop...';
      core.refresh(function () {
        recheck.disabled = false;
        licenseNotice('till-license', core.getStatus());
        if (el('settings-page') && ui.tab === 'settings') { renderLicensePage(box); }
      });
    };
    box.appendChild(recheck);

    function draw() {
      var license = core.licenseDetails();
      var left = license.remainingMs;
      var kind = 'ok';
      var label = 'Joined device';
      var color = '#515B92';
      if (license.state === 'revoked') { kind = 'revoked'; label = 'Revoked'; color = '#BA1A1A'; }
      else if (license.state === 'expired' || (left !== null && left <= 0 && !license.neverExpires)) { kind = 'expired'; label = 'Expired'; color = '#EF6C00'; }
      else if (license.state === 'unknown') { kind = 'unknown'; label = 'Not checked yet'; color = '#767680'; }
      card.innerHTML = '';
      var head = make('div', 'licensehead');
      head.style.color = color;
      var icon = make('span');
      icon.innerHTML = LICENSE_ICONS[kind];
      head.appendChild(icon);
      head.appendChild(make('span', 'state', label));
      card.appendChild(head);
      if (kind === 'revoked') {
        card.appendChild(make('p', '', 'This license has been revoked. Contact NexaPOS support if you think this is a mistake.'));
      } else if (kind === 'expired') {
        card.appendChild(make('p', '', 'The shop\'s license has run out. Ask the shop owner to renew it - this iPad reopens by itself when it receives the renewal.'));
      } else if (kind === 'unknown') {
        card.appendChild(make('p', '', 'The shop\'s license has not been checked yet. Update the shop data while online.'));
      } else if (license.neverExpires || license.validUntil === null) {
        card.appendChild(make('p', '', 'This iPad follows the shop\'s license, which never expires.'));
      } else {
        card.appendChild(make('p', '', 'This iPad follows the shop\'s license, received from the shop. It works with or without internet until that license runs out. The countdown does not depend on this iPad\'s date and time.'));
        card.appendChild(make('p', '', 'Expires on ' + licenseExpiryText(license.validUntil)));
        card.appendChild(make('div', 'muted', 'Shop license time remaining'));
        card.appendChild(countdownTiles(left));
      }
      var fetched = core.getStatus().fetchedAt;
      note.textContent = fetched ? 'Confirmed with the shop at ' + timeText(fetched) + '.' : 'Not confirmed with the shop yet.';
    }
    draw();
    // redrawn every second, so the seconds tile moves
    licenseTimer = window.setInterval(function () { if (ui.tab === 'settings' && el('settings-page-view').className.indexOf('hidden') < 0) { draw(); } else { stopLicenseTicker(); } }, 1000);
  }

  // ---- M-Pesa Till Phone: the phone that passes the shop's M-Pesa payment messages on ---------------------------------------------
  // Customers pay the shop's own till or paybill; the phone that gets Safaricom's message passes it on to the shop. Here an
  // administrator sets that phone up (with their own password, which the shop server checks), sees the phones that are set up,
  // removes one, and watches the payments arrive. A new phone's key is shown ONCE, with a code the phone's camera can scan.
  var tillPhone = { timer: null, phones: null, max: 5, payments: null, removing: 0, key: null, token: 0 };
  var TILL_PHONE_REFRESH_MS = 20000;

  /** Stops the page's timer and forgets what it showed - above all a key that was on show. */
  function closeTillPhonePage() {
    if (!tillPhone) { return; } // called while the page is still starting up
    if (tillPhone.timer) { window.clearInterval(tillPhone.timer); tillPhone.timer = null; }
    tillPhone.phones = null;
    tillPhone.payments = null;
    tillPhone.removing = 0;
    tillPhone.key = null;
    tillPhone.token += 1; // answers still on their way belong to a page that is gone
  }

  function tillPhoneOpen() {
    return ui.tab === 'settings' && !!el('tillphone-phones') && !!core.currentUser();
  }

  /** The page a phone opens (by scanning the code) to be set up: the key travels after the #, which is never sent to a server. */
  function phonePageLink(key) {
    return window.location.protocol + '//' + window.location.host + window.location.pathname.replace(/[^\/]*$/, '') + 'phone.html#k=' + key;
  }

  /** A value to copy by hand: the text (selectable) and a Copy button. */
  function copyRow(labelText, value, saidId) {
    var wrap = make('div');
    wrap.appendChild(make('label', '', labelText));
    var line = make('div', 'deviceid');
    line.appendChild(make('div', 'idtext keytext', value));
    var copy = make('button', 'secondary small', 'Copy');
    copy.type = 'button';
    copy.onclick = function () {
      var done = copyToClipboard(value);
      say(saidId, done ? 'ok' : 'warn', done ? labelText + ' copied' : 'Could not copy. Press and hold the text to copy it.');
      window.setTimeout(function () { if (el(saidId)) { say(saidId, '', ''); } }, 2500);
    };
    line.appendChild(copy);
    wrap.appendChild(line);
    return wrap;
  }

  function drawTillPhones() {
    var list = el('tillphone-phones');
    if (!list) { return; }
    list.innerHTML = '';
    if (tillPhone.phones === null) {
      list.appendChild(make('p', 'muted', 'Loading...'));
      return;
    }
    if (tillPhone.phones.length === 0) {
      list.appendChild(make('p', 'muted', 'No phone is set up yet.'));
    }
    for (var i = 0; i < tillPhone.phones.length; i++) {
      (function (phone) {
        var row = make('div', 'rowline');
        var a = make('div', 'a');
        a.appendChild(make('b', '', phone.label));
        a.appendChild(make('div', 'sku', 'Added' + (phone.addedBy ? ' by ' + phone.addedBy : '') + (phone.addedAt ? ' on ' + timeText(phone.addedAt) : '')));
        a.appendChild(make('div', 'sku', phone.lastMessageAt ? 'Last message: ' + timeText(phone.lastMessageAt) : 'No message from this phone yet'));
        var r = make('div', 'r');
        var remove = make('button', 'secondary small', 'Remove');
        remove.type = 'button';
        remove.onclick = function () { tillPhone.removing = phone.id; say('tillphone-message', '', ''); drawTillPhones(); };
        r.appendChild(remove);
        row.appendChild(a);
        row.appendChild(r);
        list.appendChild(row);
        if (tillPhone.removing === phone.id) {
          var ask = make('div', 'notice warn');
          ask.appendChild(make('div', '', 'Remove "' + phone.label + '"? Its key stops working at once: the phone must be set up again to pass messages on.'));
          ask.appendChild(make('label', '', 'Your password'));
          var password = document.createElement('input');
          password.type = 'password';
          password.id = 'tillphone-remove-password';
          password.setAttribute('autocomplete', 'off');
          ask.appendChild(password);
          var yes = make('button', 'big', 'Remove this phone');
          yes.type = 'button';
          yes.id = 'tillphone-remove-confirm';
          var token = tillPhone.token;
          yes.onclick = function () {
            setBusy('tillphone-remove-confirm', true, 'Removing...');
            core.removeTillPhone({ phoneId: phone.id, password: password.value }, function (result) {
              if (token !== tillPhone.token || !tillPhoneOpen()) { return; }
              if (!result.ok) {
                if (el('tillphone-remove-confirm')) { setBusy('tillphone-remove-confirm', false, 'Remove this phone'); }
                password.value = '';
                say('tillphone-message', result.code === 'offline' ? 'warn' : 'bad', result.message);
                return;
              }
              tillPhone.removing = 0;
              tillPhone.phones = result.phones;
              drawTillPhones();
              say('tillphone-message', 'ok', 'Phone removed. Its key no longer works.');
            });
          };
          ask.appendChild(yes);
          var no = make('button', 'secondary wide', 'Keep it');
          no.type = 'button';
          no.onclick = function () { tillPhone.removing = 0; drawTillPhones(); };
          ask.appendChild(no);
          list.appendChild(ask);
        }
      }(tillPhone.phones[i]));
    }
    var full = tillPhone.phones.length >= tillPhone.max;
    if (el('tillphone-add')) { el('tillphone-add').disabled = full; }
    if (full) { list.appendChild(make('p', 'muted', 'This shop has ' + tillPhone.max + ' phones set up, which is the most. Remove one to set up another.')); }
  }

  function drawTillPayments() {
    var list = el('tillphone-payments');
    if (!list) { return; }
    list.innerHTML = '';
    if (tillPhone.payments === null) {
      list.appendChild(make('p', 'muted', 'Loading...'));
      return;
    }
    if (tillPhone.payments.length === 0) {
      list.appendChild(make('p', 'muted', 'Nothing yet. A payment shows here a few seconds after its M-Pesa message reaches the phone.'));
      return;
    }
    for (var i = 0; i < tillPhone.payments.length; i++) {
      var p = tillPhone.payments[i];
      var row = make('div', 'rowline');
      var a = make('div', 'a');
      var r = make('div', 'r');
      if (p.messageReceived) {
        a.appendChild(make('b', '', p.payerName || 'M-Pesa payment'));
        var facts = [p.code];
        if (p.payerPhone) { facts.push(p.payerPhone); }
        if (p.accountRef) { facts.push('Account ' + p.accountRef); }
        facts.push(p.paidAtText || (p.receivedAt ? timeText(p.receivedAt) : ''));
        if (p.phoneLabel) { facts.push('via ' + p.phoneLabel); }
        a.appendChild(make('div', 'sku', facts.join(' \u00b7 ')));
        a.appendChild(make('div', 'sku', p.used ? 'Used on sale ' + p.used.saleNumber + (p.used.amountCents !== null && p.amountCents !== null && p.used.amountCents !== p.amountCents ? ' (the sale was ' + money(p.used.amountCents) + ')' : '') : (p.archivedAt ? 'Archived: not suggested at checkout' : 'Not used on a sale yet')));
        r.appendChild(document.createTextNode(p.amountCents === null ? 'Amount not read' : money(p.amountCents)));
        if (p.archivedAt && !p.used) {
          (function (payment) {
            var again = make('button', 'secondary small', 'Suggest again');
            again.type = 'button';
            again.onclick = function () {
              again.disabled = true;
              core.archiveTillPayment(payment.code, false, function (error) {
                if (!tillPhoneOpen()) { return; }
                if (error) { again.disabled = false; say('tillphone-pay-message', error.code === 'offline' ? 'warn' : 'bad', error.message); return; }
                loadTillPhone(true, function () { say('tillphone-pay-message', 'ok', (payment.payerName || payment.code) + ' is suggested at checkout again.'); });
              });
            };
            r.appendChild(make('br'));
            r.appendChild(again);
          }(p));
        }
      } else {
        a.appendChild(make('b', '', 'Code typed at a till'));
        a.appendChild(make('div', 'sku', [p.code, p.used ? 'Sale ' + p.used.saleNumber : '', p.used && p.used.usedAt ? timeText(p.used.usedAt) : ''].join(' \u00b7 ')));
        a.appendChild(make('div', 'sku', 'No M-Pesa message has arrived for this code.'));
        r.appendChild(document.createTextNode(p.used && p.used.amountCents !== null ? money(p.used.amountCents) : ''));
      }
      row.appendChild(a);
      row.appendChild(r);
      list.appendChild(row);
    }
  }

  /** Shows the new phone's key - once - with the code its camera scans. */
  function drawTillPhoneKey() {
    var card = el('tillphone-key');
    if (!card) { return; }
    card.innerHTML = '';
    show('tillphone-key', !!tillPhone.key);
    if (!tillPhone.key) { return; }
    var made = tillPhone.key;
    var link = phonePageLink(made.key);
    card.appendChild(make('h2', '', 'Set up "' + made.phone.label + '"'));
    card.appendChild(make('div', 'notice warn', 'This key is shown only once. Finish setting the phone up before you leave this page. While the key is on show, this till stays logged in for ' + KEY_ON_SHOW_IDLE_MINUTES + ' minutes without a touch.'));
    card.appendChild(make('p', '', 'On the phone that gets your M-Pesa payment messages, open the camera and point it at this code. It opens a page with the steps.'));
    var drawn = false;
    if (typeof window.qrcode === 'function') {
      try {
        var qr = window.qrcode(0, 'M');
        qr.addData(link);
        qr.make();
        var image = document.createElement('img');
        image.className = 'qr';
        image.alt = 'Code to scan with the phone';
        image.src = qr.createDataURL(6, 2);
        var holder = make('div', 'qrbox');
        holder.appendChild(image);
        card.appendChild(holder);
        drawn = true;
      } catch (e) {
        drawn = false;
      }
    }
    if (!drawn) { card.appendChild(make('div', 'notice warn', 'The code could not be drawn on this iPad. Use the address and key below.')); }
    var open = make('a', 'btn secondary', 'Open the steps on this device');
    open.href = link;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    card.appendChild(open);
    card.appendChild(make('p', 'muted', 'Or copy these to the phone by hand:'));
    var said = make('div');
    said.id = 'tillphone-copied';
    card.appendChild(copyRow('Address', made.address, 'tillphone-copied'));
    card.appendChild(copyRow('Key', made.key, 'tillphone-copied'));
    card.appendChild(said);
    var done = make('button', 'big', 'Done - hide the key');
    done.type = 'button';
    done.onclick = function () {
      if (!window.confirm('Hide the key?\nIt cannot be shown again. If the phone is not set up yet, you will have to remove it and set it up again.')) { return; }
      tillPhone.key = null;
      drawTillPhoneKey();
    };
    card.appendChild(done);
  }

  /** [after], if given, runs once the payments are drawn again (a message said then is not wiped by the redraw). */
  function loadTillPhone(quiet, after) {
    var token = tillPhone.token;
    core.tillPhones(function (error, result) {
      if (token !== tillPhone.token || !tillPhoneOpen()) { return; }
      if (error) {
        if (!quiet || tillPhone.phones === null) { say('tillphone-message', error.code === 'offline' ? 'warn' : 'bad', error.message); }
        if (tillPhone.phones === null) { tillPhone.phones = []; drawTillPhones(); }
        return;
      }
      tillPhone.max = result.max;
      // a password being typed to remove a phone is not wiped by the list updating itself
      if (tillPhone.removing !== 0 && tillPhone.phones !== null) { return; }
      tillPhone.phones = result.phones;
      drawTillPhones();
    });
    core.tillPayments(24, function (error, result) {
      if (token !== tillPhone.token || !tillPhoneOpen()) { return; }
      if (el('tillphone-refresh')) { setBusy('tillphone-refresh', false, 'Refresh'); }
      if (error) {
        if (!quiet) { say('tillphone-pay-message', error.code === 'offline' ? 'warn' : 'bad', error.message); }
        if (tillPhone.payments === null) { tillPhone.payments = []; drawTillPayments(); }
        return;
      }
      say('tillphone-pay-message', '', '');
      tillPhone.payments = result.payments;
      drawTillPayments();
      if (after) { after(); }
    });
  }

  function renderTillPhonePage(box) {
    closeTillPhonePage();
    box.innerHTML = '';
    box.appendChild(make('h2', '', 'M-Pesa Till Phone'));

    var intro = make('div', 'card');
    intro.appendChild(make('p', '', 'Customers pay your own M-Pesa till or paybill, so the money reaches you straight away. The phone that gets Safaricom\'s payment message passes it on to NexaPOS, and your tills can then check a customer\'s M-Pesa code against the real message.'));
    intro.appendChild(make('p', 'muted', 'Only payments you receive are kept. Your balance, and anything you send or withdraw, is dropped unread.'));
    box.appendChild(intro);

    var phones = make('div', 'card');
    phones.appendChild(make('h2', '', 'Phones'));
    var list = make('div');
    list.id = 'tillphone-phones';
    phones.appendChild(list);
    var message = make('div');
    message.id = 'tillphone-message';
    phones.appendChild(message);
    var add = make('button', 'big', 'Set up a phone');
    add.type = 'button';
    add.id = 'tillphone-add';
    phones.appendChild(add);

    var form = make('div', 'hidden');
    form.id = 'tillphone-form';
    form.appendChild(make('label', '', 'Name for this phone'));
    var label = document.createElement('input');
    label.type = 'text';
    label.id = 'tillphone-label';
    label.maxLength = 60;
    label.value = 'Shop phone';
    form.appendChild(label);
    form.appendChild(make('label', '', 'Your password'));
    var password = document.createElement('input');
    password.type = 'password';
    password.id = 'tillphone-password';
    password.setAttribute('autocomplete', 'off');
    form.appendChild(password);
    form.appendChild(make('p', 'muted', 'Your own NexaPOS password, to show it is you. Only an administrator can set a phone up.'));
    var create = make('button', 'big', 'Create the key');
    create.type = 'button';
    create.id = 'tillphone-create';
    form.appendChild(create);
    var cancel = make('button', 'secondary wide', 'Cancel');
    cancel.type = 'button';
    form.appendChild(cancel);
    phones.appendChild(form);
    box.appendChild(phones);

    var keyCard = make('div', 'card hidden');
    keyCard.id = 'tillphone-key';
    box.appendChild(keyCard);

    var pay = make('div', 'card');
    pay.appendChild(make('h2', '', 'Payments received'));
    pay.appendChild(make('p', 'muted', 'The last 24 hours, newest first. The list updates by itself.'));
    var payMessage = make('div');
    payMessage.id = 'tillphone-pay-message';
    pay.appendChild(payMessage);
    var payments = make('div');
    payments.id = 'tillphone-payments';
    pay.appendChild(payments);
    var refresh = make('button', 'secondary small', 'Refresh');
    refresh.type = 'button';
    refresh.id = 'tillphone-refresh';
    refresh.style.marginTop = '10px';
    pay.appendChild(refresh);
    box.appendChild(pay);

    var token = tillPhone.token;
    add.onclick = function () {
      say('tillphone-message', '', '');
      show('tillphone-form', true);
      show('tillphone-add', false);
      password.value = '';
    };
    cancel.onclick = function () {
      password.value = '';
      show('tillphone-form', false);
      show('tillphone-add', true);
    };
    create.onclick = function () {
      say('tillphone-message', '', '');
      setBusy('tillphone-create', true, 'Checking with the shop...');
      core.addTillPhone({ label: label.value, password: password.value }, function (result) {
        password.value = '';
        if (token !== tillPhone.token || !tillPhoneOpen()) { return; }
        setBusy('tillphone-create', false, 'Create the key');
        if (!result.ok) {
          say('tillphone-message', result.code === 'offline' ? 'warn' : 'bad', result.message);
          return;
        }
        tillPhone.key = result;
        armIdleTimer(); // the key is on show: the longer wait starts now
        show('tillphone-form', false);
        show('tillphone-add', true);
        label.value = 'Shop phone';
        drawTillPhoneKey();
        loadTillPhone(true);
        if (el('tillphone-key').scrollIntoView) { el('tillphone-key').scrollIntoView(); }
      });
    };
    refresh.onclick = function () {
      setBusy('tillphone-refresh', true, 'Refreshing...');
      loadTillPhone(false);
    };

    drawTillPhones();
    drawTillPayments();
    loadTillPhone(false);
    tillPhone.timer = window.setInterval(function () {
      if (!tillPhoneOpen()) { closeTillPhonePage(); return; }
      loadTillPhone(true);
    }, TILL_PHONE_REFRESH_MS);
  }

  /** Settings > Security & Privacy: quick sign in (Face ID, Touch ID, a fingerprint or the device's passcode). */
  function drawQuickSettings(card) {
    var box = make('div');
    box.id = 'quick-settings';
    card.appendChild(box);
    function draw() {
      box.innerHTML = '';
      box.appendChild(make('label', '', 'Quick sign in'));
      var quick = core.quickSignInStatus();
      var me = core.currentUser();
      var said = make('div');
      said.id = 'quick-message';
      if (!quick.supported) {
        box.appendChild(make('p', 'muted', 'This device\'s browser cannot sign in with Face ID, a fingerprint or the passcode. It needs an iPhone or iPad with iOS 16 or newer, or an Android phone.'));
        if (quick.setUpFor) { box.appendChild(make('p', 'muted', 'It was set up for ' + quick.setUpFor.name + ' on this device.')); }
        return;
      }
      if (!quick.setUpFor) {
        box.appendChild(make('p', 'muted', 'Sign in with Face ID, Touch ID, a fingerprint or this device\'s passcode instead of typing your password. One person per device.'));
        var on = make('button', 'big', 'Turn on quick sign in for ' + me.name);
        on.type = 'button';
        on.id = 'quick-on';
        on.onclick = function () {
          setBusy('quick-on', true, 'Waiting for Face ID or passcode...');
          core.setUpQuickSignIn(function (error) {
            if (!el('quick-settings')) { return; }
            draw();
            say('quick-message', error ? (error.code === 'cancelled' ? 'warn' : 'bad') : 'ok', error ? error.message : 'Quick sign in is on. Next time, tap "Sign in as ' + me.name + ' with Face ID or passcode".');
          });
        };
        box.appendChild(on);
      } else {
        box.appendChild(make('p', '', quick.mine ? 'On for you (' + me.name + ') on this device.' : 'Set up for ' + quick.setUpFor.name + ' on this device.'));
        if (quick.mine || me.roleName === 'Admin') {
          var off = make('button', 'secondary wide', 'Turn off quick sign in');
          off.type = 'button';
          off.onclick = function () {
            if (!window.confirm('Turn off quick sign in on this device?\nThe password still works.')) { return; }
            var result = core.turnOffQuickSignIn();
            draw();
            say('quick-message', result.ok ? 'ok' : 'bad', result.ok ? 'Quick sign in is off on this device.' : result.message);
          };
          box.appendChild(off);
        }
      }
      box.appendChild(said);
    }
    draw();
  }

  /** Puts text on the iPad's clipboard (the long way, which old Safari allows from a tap). */
  function copyToClipboard(text) {
    var field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', 'readonly');
    field.style.position = 'fixed';
    field.style.left = '-1000px';
    document.body.appendChild(field);
    field.select();
    var done = false;
    try { field.setSelectionRange(0, text.length); done = document.execCommand('copy'); } catch (e) { done = false; }
    document.body.removeChild(field);
    return done;
  }

  function renderSettings() {
    show('settings-menu-view', true);
    show('settings-page-view', false);
    var menu = el('settings-menu');
    menu.innerHTML = '';
    for (var i = 0; i < SETTINGS_PAGES.length; i++) {
      if (SETTINGS_PAGES[i].admin && !isAdmin()) { continue; }
      (function (page) {
        var row = make('button', 'menurow');
        row.type = 'button';
        row.appendChild(make('span', '', page.title));
        row.appendChild(make('span', 'chev', '\u203a'));
        row.onclick = function () { openSettingsPage(page.id); };
        menu.appendChild(row);
      }(SETTINGS_PAGES[i]));
    }
    menu.appendChild(make('p', 'muted', 'Payments, backups, devices and users are managed in NexaPOS on the shop\'s PC or phone.'));
  }
  el('settings-back').onclick = function () { showTab('home'); };
  el('settings-page-back').onclick = function () { stopLicenseTicker(); closeTillPhonePage(); el('settings-page').innerHTML = ''; renderSettings(); };

  function openSettingsPage(id) {
    var box = el('settings-page');
    box.innerHTML = '';
    show('settings-menu-view', false);
    show('settings-page-view', true);
    var title = '';
    for (var i = 0; i < SETTINGS_PAGES.length; i++) { if (SETTINGS_PAGES[i].id === id) { title = SETTINGS_PAGES[i].title; } }
    var card = make('div', 'card');
    card.appendChild(make('h2', '', title));
    box.appendChild(card);
    var table = make('table', 'totals');
    var body = make('tbody');
    table.appendChild(body);
    function row(label, value) {
      var tr = make('tr');
      tr.appendChild(make('td', '', label));
      tr.appendChild(make('td', 'num', value));
      body.appendChild(tr);
    }
    var info = core.shopInfo();
    var status = core.getStatus();
    var user = core.currentUser();
    if (id === 'security') {
      card.appendChild(make('label', '', 'Log out after no touch for'));
      var select = document.createElement('select');
      var choices = [[1, '1 minute'], [5, '5 minutes'], [10, '10 minutes'], [30, '30 minutes']];
      for (var c = 0; c < choices.length; c++) {
        var option = make('option', '', choices[c][1]);
        option.value = String(choices[c][0]);
        select.appendChild(option);
      }
      select.value = String(ui.idleMinutes);
      select.onchange = function () { ui.idleMinutes = parseInt(select.value, 10) || 10; savePrefs(); armIdleTimer(); };
      card.appendChild(select);
      card.appendChild(make('p', 'muted', 'The till logs you out when nobody has touched it for this long, so the next person has to log in.'));
      card.appendChild(make('label', '', 'Figures on the dashboard'));
      var seg = make('div', 'seg');
      var shown = make('button', ui.hideFigures ? '' : 'on', 'Shown');
      var hidden = make('button', ui.hideFigures ? 'on' : '', 'Hidden');
      shown.type = 'button';
      hidden.type = 'button';
      shown.onclick = function () { ui.hideFigures = false; savePrefs(); renderHome(); openSettingsPage('security'); };
      hidden.onclick = function () { ui.hideFigures = true; savePrefs(); renderHome(); openSettingsPage('security'); };
      seg.appendChild(shown);
      seg.appendChild(hidden);
      card.appendChild(seg);
      card.appendChild(make('p', 'muted', 'Hidden shows stars instead of the sales, profit and stock figures (the eye on the dashboard does the same).'));
      drawQuickSettings(card);
    } else if (id === 'business') {
      card.appendChild(table);
      row('Business name', info.name);
      row('Address', info.address || '-');
      row('Phone', info.phone || '-');
      row('Receipt footer', info.footer || '-');
      row('Currency', info.currency);
      row('Paper width', info.paperWidthMm + ' mm');
      card.appendChild(make('p', 'muted', 'These are the shop\'s details, as every receipt printed here shows them. To change them, use NexaPOS on the shop\'s PC or phone: the change reaches this iPad by itself.'));
    } else if (id === 'sync') {
      card.appendChild(table);
      row('Shop', info.name);
      row('This iPad', status.deviceLabel || '-');
      row('Signed in as', user ? user.name + ' (' + user.roleName + ')' : '-');
      row('Shop data updated', status.fetchedAt ? timeText(status.fetchedAt) : 'not yet');
      row('Sales waiting', String(status.pendingSales));
      row('Expenses waiting', String(status.pendingExpenses));
      row('Refunds waiting', String(status.pendingRefunds));
      var syncNote = make('div');
      syncNote.id = 'settings-sync-message';
      card.appendChild(syncNote);
      var update = make('button', 'big', 'Update shop data');
      update.type = 'button';
      update.id = 'settings-update';
      update.onclick = function () {
        refreshEverything(['bar-refresh', 'settings-update'], 'settings-sync-message', function (error) {
          if (ui.tab !== 'settings') { return; }
          openSettingsPage('sync');
          say('settings-sync-message', error ? (error.code === 'offline' ? 'warn' : 'bad') : 'ok', error ? error.message : 'Up to date.');
        });
      };
      card.appendChild(update);
      var disconnect = make('button', 'secondary wide', 'Disconnect this iPad');
      disconnect.type = 'button';
      disconnect.onclick = function () { el('forget-button').onclick(); };
      card.appendChild(disconnect);
      card.appendChild(make('p', 'muted', 'Disconnecting forgets the shop on this iPad: you will need a new invite code from the shop to connect it again.'));
    } else if (id === 'region') {
      var now = new Date();
      var offsetMinutes = -now.getTimezoneOffset();
      var sign = offsetMinutes < 0 ? '-' : '+';
      var absolute = Math.abs(offsetMinutes);
      card.appendChild(table);
      row('Date and time on this iPad', now.getDate() + ' ' + MONTHS3[now.getMonth()] + ' ' + now.getFullYear() + ' ' + clockText(now));
      row('Time zone', 'UTC' + sign + two(Math.floor(absolute / 60)) + ':' + two(absolute % 60));
      row('Currency', info.currency);
      var differenceMs = status.serverOffsetMs || 0;
      var minutes = Math.round(Math.abs(differenceMs) / 60000);
      if (!status.fetchedAt) {
        card.appendChild(make('div', 'notice warn', 'The shop\'s clock has not been read yet. Update the shop data to compare.'));
      } else if (minutes < 2) {
        card.appendChild(make('div', 'notice ok', 'This iPad\'s clock agrees with the shop\'s.'));
      } else {
        card.appendChild(make('div', 'notice warn', 'This iPad\'s clock is about ' + minutes + (minutes === 1 ? ' minute ' : ' minutes ') + (differenceMs > 0 ? 'behind' : 'ahead of') + (differenceMs > 0 ? ' the shop\'s.' : ' the shop\'s.') + ' Sales and receipts are stamped with the iPad\'s clock, so set it right: iPad Settings > General > Date & Time > Set Automatically.'));
      }
    } else if (id === 'tillphone') {
      box.removeChild(card);
      renderTillPhonePage(box);
      return;
    } else if (id === 'license') {
      box.removeChild(card);
      renderLicensePage(box);
      return;
    } else if (id === 'update') {
      card.appendChild(table);
      row('NexaPOS Lite version', el('version-label').innerText || '-');
      var result = make('div');
      result.id = 'settings-update-result';
      card.appendChild(result);
      var check = make('button', 'big', 'Check for a new version');
      check.type = 'button';
      check.id = 'settings-check';
      check.onclick = function () {
        setBusy('settings-check', true, 'Checking...');
        say('settings-update-result', '', '');
        checkForUpdate(function (outcome) {
          if (!el('settings-check')) { return; }
          setBusy('settings-check', false, 'Check for a new version');
          if (outcome === 'newer') {
            say('settings-update-result', 'warn', 'A newer version is ready.');
            var now2 = make('button', 'big', 'Update now');
            now2.type = 'button';
            now2.onclick = function () { el('update-now').onclick(); };
            el('settings-update-result').appendChild(now2);
          } else if (outcome === 'same') {
            say('settings-update-result', 'ok', 'You have the newest version.');
          } else {
            say('settings-update-result', 'warn', 'Could not reach the shop server. Check the internet connection and try again.');
          }
        });
      };
      card.appendChild(check);
      card.appendChild(make('p', 'muted', 'The till looks for a new version by itself every few minutes. Nothing is changed in the middle of a sale, and the sales saved on this iPad are kept.'));
    }
  }
  // ---- refunds: the apps' Refund screen -------------------------------------------------------------------------------
  // An owner (Admin) or a Manager opens a sale (from Reports, or the Sales tab), chooses how many of each item go back and
  // whether they return to the shelf, gives a reason and types their own password again. NexaPOS only RECORDS the refund:
  // the person pays the customer back by hand, and the screen says how.
  function canRefund() {
    return !!core.currentUser() && core.refundBlock() === null;
  }

  function openRefund(saleId, back) {
    var current = { saleId: saleId, back: back, source: null, quantity: {}, keep: {}, busy: false, changed: false };
    ui.refund = current;
    ui.refundReceiptId = null;
    showTab('refund');
    show('refund-body', false);
    show('refund-done', false);
    el('refund-done').innerHTML = '';
    el('refund-lines').innerHTML = '';
    el('refund-reason').value = '';
    el('refund-password').value = '';
    say('refund-form-message', '', '');
    say('refund-message', 'warn', 'Opening the sale...');
    core.loadSaleForRefund(saleId, function (error, source) {
      if (ui.refund !== current || !core.currentUser()) { return; }
      if (error) { say('refund-message', error.code === 'offline' || error.code === 'waiting' ? 'warn' : 'bad', error.message); return; }
      var blocked = core.whyNotRefundable(source);
      if (blocked) { say('refund-message', 'warn', blocked); return; }
      say('refund-message', '', '');
      current.source = source;
      renderRefund();
      show('refund-body', true);
    });
  }

  function refundLeft(item) {
    var lines = ui.refund.source.lines;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].itemId === item.id) { return item.quantity - lines[i].refunded; }
    }
    return item.quantity;
  }

  function refundChoices() {
    var r = ui.refund;
    var choices = [];
    if (!r || !r.source) { return choices; }
    for (var i = 0; i < r.source.items.length; i++) {
      var item = r.source.items[i];
      if (r.quantity[item.id] > 0) { choices.push({ itemId: item.id, quantity: r.quantity[item.id], restock: r.keep[item.id] !== false }); }
    }
    return choices;
  }

  /** How the customer is to be paid back, in words. */
  function refundPayback(method, totalCents, cashCents) {
    if (method === 'cash') { return 'Give the customer ' + money(totalCents) + ' in cash.'; }
    if (method === 'paystack' && cashCents !== null && cashCents !== undefined) {
      var parts = [];
      if (cashCents > 0) { parts.push('give ' + money(cashCents) + ' in cash'); }
      if (totalCents - cashCents > 0) { parts.push('send ' + money(totalCents - cashCents) + ' back by M-Pesa'); }
      return 'Pay the customer back: ' + parts.join(' and ') + '.';
    }
    return 'Send ' + money(totalCents) + ' back to the customer by M-Pesa.';
  }

  function renderRefund() {
    var r = ui.refund;
    var source = r.source;
    var sale = source.sale;
    var sub = [sale.saleNumber, timeInReport(sale.createdAt, true), source.cashierName, reportMethodLabel(sale.paymentMethod), 'Total ' + money(sale.totalCents)];
    if (sale.customerName && sale.customerName !== 'Walk-in customer') { sub.splice(3, 0, sale.customerName); }
    if (source.refundCount > 0) { sub.push('already refunded ' + money(source.refunded.totalCents)); }
    setText('refund-sub', sub.join(' \u00b7 '));
    var box = el('refund-lines');
    box.innerHTML = '';
    for (var i = 0; i < source.items.length; i++) {
      (function (item) {
        var left = refundLeft(item);
        var row = make('div', 'refline' + (left < 1 ? ' done' : ''));
        var top = make('div', 'top');
        top.appendChild(make('div', 'name', item.itemName));
        top.appendChild(make('div', 'amount', money(item.unitPriceCents)));
        row.appendChild(top);
        row.appendChild(make('div', 'sku', 'Sold ' + item.quantity + ' \u00b7 already refunded ' + (item.quantity - left) + ' \u00b7 left ' + left));
        if (left > 0) {
          r.quantity[item.id] = r.quantity[item.id] || 0;
          var stepper = make('div', 'stepper');
          var minus = make('button', 'secondary', '\u2212');
          minus.type = 'button';
          minus.setAttribute('aria-label', 'One less');
          var qty = make('span', 'qty', String(r.quantity[item.id]));
          var plus = make('button', 'secondary', '+');
          plus.type = 'button';
          plus.setAttribute('aria-label', 'One more');
          minus.onclick = function () { if (r.quantity[item.id] > 0) { r.quantity[item.id] -= 1; qty.textContent = String(r.quantity[item.id]); updateRefundTotals(); } };
          plus.onclick = function () { if (r.quantity[item.id] < left) { r.quantity[item.id] += 1; qty.textContent = String(r.quantity[item.id]); updateRefundTotals(); } };
          stepper.appendChild(minus);
          stepper.appendChild(qty);
          stepper.appendChild(plus);
          if (item.productId) {
            var keep = make('label', 'keep');
            var box2 = document.createElement('input');
            box2.type = 'checkbox';
            box2.checked = r.keep[item.id] !== false;
            box2.onclick = function () { r.keep[item.id] = box2.checked; };
            keep.appendChild(box2);
            keep.appendChild(document.createTextNode('Put back in stock'));
            stepper.appendChild(keep);
          }
          row.appendChild(stepper);
        }
        box.appendChild(row);
      }(source.items[i]));
    }
    updateRefundTotals();
  }

  function updateRefundTotals() {
    var r = ui.refund;
    var body = el('refund-totals');
    body.innerHTML = '';
    el('refund-payback').innerHTML = '';
    say('refund-form-message', '', '');
    var choices = refundChoices();
    if (!choices.length) { return; }
    var quote = core.quoteRefund(r.source, choices);
    if (!quote.ok) { say('refund-form-message', 'warn', quote.message); return; }
    function row(label, value, className) {
      var tr = make('tr', className || '');
      tr.appendChild(make('td', '', label));
      tr.appendChild(make('td', 'num', value));
      body.appendChild(tr);
    }
    row('Goods', money(quote.subtotalCents));
    if (quote.discountCents > 0) { row('Discount given back', '-' + money(quote.discountCents)); }
    row('Refund', money(quote.totalCents), 'grand');
    var pay = make('div', 'notice ok', refundPayback(r.source.sale.paymentMethod, quote.totalCents, quote.cashCents));
    pay.appendChild(make('div', 'sku', 'NexaPOS only records the refund; it does not send any money.'));
    el('refund-payback').appendChild(pay);
  }

  el('refund-all').onclick = function () {
    var r = ui.refund;
    if (!r || !r.source) { return; }
    for (var i = 0; i < r.source.items.length; i++) { r.quantity[r.source.items[i].id] = Math.max(refundLeft(r.source.items[i]), 0); }
    renderRefund();
  };
  el('refund-clear').onclick = function () {
    var r = ui.refund;
    if (!r || !r.source) { return; }
    for (var i = 0; i < r.source.items.length; i++) { r.quantity[r.source.items[i].id] = 0; }
    renderRefund();
  };

  el('refund-submit').onclick = function () {
    var r = ui.refund;
    if (!r || !r.source || r.busy) { return; }
    say('refund-form-message', '', '');
    r.busy = true;
    setBusy('refund-submit', true, 'Refunding...');
    core.refundSale({ source: r.source, choices: refundChoices(), reason: el('refund-reason').value, password: el('refund-password').value }, function (result) {
      r.busy = false;
      setBusy('refund-submit', false, 'Refund');
      if (ui.refund !== r || !core.currentUser()) { return; }
      el('refund-password').value = '';
      if (!result.ok) { say('refund-form-message', 'bad', result.message); return; }
      r.changed = true;
      showRefundReceipt(result.receipt);
      core.flush(function (error) {
        ui.lastSyncProblem = error ? error.message : '';
        if (!core.currentUser()) { route(); return; }
        renderBanner('till-sales');
        updateRefundReceiptStatus();
        renderSales();
      });
    });
  };

  function showRefundReceipt(receipt) {
    ui.refundReceiptId = receipt.saleId;
    show('refund-body', false);
    var box = el('refund-done');
    box.innerHTML = '';
    var sale = ui.refund.source.sale;
    var cash = receipt.cashBackCents === undefined ? null : receipt.cashBackCents;
    box.appendChild(make('div', 'notice ok', 'Refund recorded on this iPad. ' + refundPayback(sale.paymentMethod, receipt.totalCents, cash)));
    var paper = make('div', 'paper');
    drawSheet(paper, core.receiptSheet(receipt, false));
    box.appendChild(paper);
    var statusBox = make('div');
    statusBox.id = 'refund-receipt-status';
    box.appendChild(statusBox);
    var printIt = make('button', 'outlined wide', 'Print receipt');
    printIt.type = 'button';
    printIt.onclick = function () { printReceipt(receipt, false); };
    var done = make('button', 'big', 'Done');
    done.type = 'button';
    done.onclick = function () { leaveRefund(); };
    box.appendChild(done);
    box.appendChild(printIt);
    var toDashboard = make('button', 'secondary wide', 'Dashboard');
    toDashboard.type = 'button';
    toDashboard.onclick = function () { leaveRefund('home'); };
    box.appendChild(toDashboard);
    show('refund-done', true);
    updateRefundReceiptStatus();
  }

  function updateRefundReceiptStatus() {
    if (!ui.refundReceiptId || !el('refund-receipt-status')) { return; }
    var line = receiptStatusLine(ui.refundReceiptId);
    say('refund-receipt-status', line.kind, line.text);
  }

  function leaveRefund(target) {
    var r = ui.refund;
    var back = r ? r.back : 'reports';
    var changed = !!r && r.changed;
    ui.refund = null;
    ui.refundReceiptId = null;
    el('refund-password').value = '';
    el('refund-done').innerHTML = '';
    show('refund-done', false);
    if (target === 'home') { showTab('home'); return; }
    showTab(back === 'sales' ? 'sales' : 'reports');
    if (back !== 'sales' && changed && ui.report) { el('report-view').onclick(); }
  }
  el('refund-back').onclick = function () { leaveRefund(); };

  // ---- a newer version of the till ---------------------------------------------------------------------------
  // An iPad can keep this page open for days. Every few minutes, and whenever the page comes back to the front or the
  // internet returns, the page asks the server for a fresh copy of itself and compares it with the copy that is running
  // (its build label and script versions). When they differ a bar offers "Update now", like the apps do. Nothing is ever
  // updated by itself in the middle of a sale: the cashier taps it, a sale in progress is put on hold first, and the
  // sales saved on the iPad are untouched (they live in the browser's storage, not in the page).
  var UPDATE_CHECK_MS = 5 * 60 * 1000;
  var runningPage = document.documentElement.outerHTML;
  var updateChecking = false;
  var updateDismissed = null;
  var updateLatestText = '';
  setText('version-label', window.NexaLiteCore.pageBuild(runningPage) || '');

  function checkForUpdate(done) {
    if (updateChecking) { if (done) { done('busy'); } return; }
    updateChecking = true;
    xhrHttp({ method: 'GET', url: 'index.html?check=' + new Date().getTime(), headers: {} }, function (error, response) {
      updateChecking = false;
      if (error || !response || response.status !== 200) { if (done) { done('error'); } return; }
      var newer = window.NexaLiteCore.updateAvailable(runningPage, response.text);
      var signature = window.NexaLiteCore.pageSignature(response.text);
      if (newer) { updateLatestText = response.text; }
      show('update-bar', newer && signature !== updateDismissed);
      if (!newer) { say('update-message', '', ''); }
      if (done) { done(newer ? 'newer' : 'same'); }
    });
  }

  el('update-later').onclick = function () {
    // Quiet until a still newer version comes out; the page is checked again next time it is opened anyway.
    updateDismissed = window.NexaLiteCore.pageSignature(updateLatestText);
    show('update-bar', false);
  };

  el('update-now').onclick = function () {
    if (ui.starting || ui.payingId) {
      say('update-message', 'warn', 'Finish or leave the payment first (tap "Start another sale" to keep it waiting), then update.');
      return;
    }
    if (core.currentUser() && ui.cart.length > 0) {
      if (!window.confirm('Your sale in progress will be put on hold (open it again from Held sales), and the till will restart with the new version. Continue?')) { return; }
      var kept = core.holdSale('Unfinished sale', currentDraft());
      if (!kept.ok) { say('update-message', 'bad', kept.message); return; }
    }
    window.location.reload();
  };

  window.setInterval(function () { checkForUpdate(); }, UPDATE_CHECK_MS);
  window.setTimeout(function () { checkForUpdate(); }, 8000);
  window.addEventListener('online', function () { checkForUpdate(); }, false);
  window.addEventListener('pageshow', function () { checkForUpdate(); }, false);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { checkForUpdate(); } }, false);

  // ---- start -------------------------------------------------------------------------------------------------
  // Coming back from paying on this iPad: the cashier who was paying gets their login back (for that one waiting
  // payment only) BEFORE the first screen is chosen, so they land on the payment, not on the login screen.
  var resumeSaleId = null;
  (function () {
    var token = readReturnToken();
    if (!token) { return; }
    if (core.restoreSession(token.userId, token.saleId)) { resumeSaleId = token.saleId; } else { clearReturnToken(); }
  }());
  route();
  if (resumeSaleId) {
    resumePayment(resumeSaleId);
    armIdleTimer();
  }
  if (core.getStatus().joined) {
    doSync(false);
    checkWaitingPayments();
  }
}());
