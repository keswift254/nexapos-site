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
  var core = window.NexaLiteCore.create({ baseUrl: API, http: xhrHttp, storage: storage, bcrypt: bcryptLib, sale: Sale });

  // What the cashier is doing right now (kept in memory only).
  var ui = { tab: 'sell', cart: [], saleType: 'retail', payment: 'cash', receiptId: null, lastSyncProblem: '', syncing: false, payingId: null, payTimer: null, starting: false };
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
      return;
    }
    show('screen-till', true);
    setText('till-shop', status.shopName || 'NexaPOS Lite');
    setText('till-user', user.name + ' (' + user.roleName + ')');
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
  }

  // ---- tabs --------------------------------------------------------------------------------------------------
  function showTab(name) {
    ui.tab = name;
    var names = ['sell', 'products', 'sales'];
    for (var i = 0; i < names.length; i++) {
      show('panel-' + names[i], names[i] === name);
      el('tab-' + names[i]).className = 'tab' + (names[i] === name ? ' on' : '');
    }
    if (name === 'sales') { renderSales(); }
  }
  el('tab-sell').onclick = function () { showTab('sell'); };
  el('tab-products').onclick = function () { showTab('products'); };
  el('tab-sales').onclick = function () { showTab('sales'); };

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
  function completeLabel() { return ui.payment === 'paystack' ? 'Send M-Pesa Prompt' : 'Complete Sale'; }
  function setPayment(method) {
    ui.payment = method;
    el('pay-cash').className = method === 'cash' ? 'on' : '';
    el('pay-paystack').className = method === 'paystack' ? 'on' : '';
    show('pay-cash-box', method === 'cash');
    show('pay-paystack-box', method === 'paystack');
    setText('complete-button', completeLabel());
    say('sell-message', '', '');
    renderCart();
  }

  function resetSale() {
    ui.cart = [];
    el('discount').value = '';
    el('cash-received').value = '';
    el('paystack-phone').value = '';
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

  // ---- printing a receipt (AirPrint from the browser's own print sheet) ----------------------------------------
  /** Draws the receipt sheet (the till code decides what is on it) and opens the print sheet. */
  function printReceipt(receipt, reprint) {
    if (typeof window.print !== 'function') {
      window.alert('This browser cannot print.');
      return;
    }
    var sheet = core.receiptSheet(receipt, reprint);
    var box = el('print-receipt');
    box.innerHTML = '';
    box.style.width = sheet.widthMm + 'mm';
    function line(className, text) { box.appendChild(make('div', className, text)); }
    function rule() { box.appendChild(make('div', 'pr-rule')); }
    function pair(className, left, right) {
      var row = make('div', 'pr-row' + (className ? ' ' + className : ''));
      row.appendChild(make('span', '', left));
      row.appendChild(make('span', '', right));
      box.appendChild(row);
    }
    var i;
    line('pr-center pr-shop', sheet.shopName);
    if (sheet.address) { line('pr-center', sheet.address); }
    if (sheet.phone) { line('pr-center', sheet.phone); }
    line('pr-center pr-title', sheet.title);
    rule();
    for (i = 0; i < sheet.meta.length; i++) { pair('', sheet.meta[i].label, sheet.meta[i].value); }
    rule();
    for (i = 0; i < sheet.lines.length; i++) {
      line('pr-item', sheet.lines[i].name);
      pair('', sheet.lines[i].detail, sheet.lines[i].total);
    }
    rule();
    for (i = 0; i < sheet.totals.length; i++) { pair(sheet.totals[i].grand ? 'pr-grand' : '', sheet.totals[i].label, sheet.totals[i].value); }
    rule();
    for (i = 0; i < sheet.payment.length; i++) { pair('', sheet.payment[i].label, sheet.payment[i].value); }
    if (sheet.footer) {
      rule();
      line('pr-center', sheet.footer);
    }
    window.print();
  }

  function showReceipt(receipt) {
    var box = el('receipt-box');
    box.innerHTML = '';
    var card = make('div', 'receipt');
    card.appendChild(make('div', 'muted', 'Sale ' + receipt.saleNumber + ' · ' + timeText(receipt.createdAt)));
    card.appendChild(make('div', 'big', 'Total ' + core.formatCents(receipt.totalCents)));
    card.appendChild(make('div', '', (receipt.paymentMethod === 'cash' ? 'Paid in cash' : (receipt.paymentMethod === 'paystack' ? 'Paid online (Paystack)' : 'Paid by M-Pesa' + (receipt.referenceNote ? ' (' + receipt.referenceNote + ')' : ''))) + (receipt.customerName !== 'Walk-in customer' ? ' · ' + receipt.customerName : '')));
    if (receipt.changeDueCents !== null && receipt.changeDueCents >= 0) {
      card.appendChild(make('div', 'big', 'Change to give: ' + core.formatCents(receipt.changeDueCents)));
    } else if (receipt.changeDueCents !== null) {
      card.appendChild(make('div', 'notice warn', 'The customer still owes ' + core.formatCents(-receipt.changeDueCents) + '.'));
    }
    var table = make('table');
    table.style.marginTop = '10px';
    var tbody = make('tbody');
    for (var i = 0; i < receipt.lines.length; i++) {
      var row = make('tr');
      row.appendChild(make('td', '', receipt.lines[i].name + '  ×' + receipt.lines[i].quantity));
      row.appendChild(make('td', 'num', core.formatCents(receipt.lines[i].lineTotalCents)));
      tbody.appendChild(row);
    }
    if (receipt.discountCents > 0) {
      var discountRow = make('tr');
      discountRow.appendChild(make('td', '', 'Discount'));
      discountRow.appendChild(make('td', 'num', '-' + core.formatCents(receipt.discountCents)));
      tbody.appendChild(discountRow);
    }
    table.appendChild(tbody);
    card.appendChild(table);
    var statusBox = make('div');
    statusBox.id = 'receipt-status';
    card.appendChild(statusBox);
    var printIt = make('button', 'secondary', 'Print receipt');
    printIt.type = 'button';
    printIt.onclick = function () { printReceipt(receipt, false); };
    var next = make('button', 'big', 'New sale');
    next.type = 'button';
    next.onclick = function () { ui.receiptId = null; show('receipt-box', false); show('sell-form', true); };
    card.appendChild(next);
    card.appendChild(printIt);
    box.appendChild(card);
    show('receipt-box', true);
    show('sell-form', false);
    updateReceiptStatus();
  }

  function updateReceiptStatus() {
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
        info.appendChild(make('div', 'sku', timeText(entry.receipt.createdAt) + ' · ' + methodLabel(entry.receipt.paymentMethod)));
        if (entry.status === 'rejected') { info.appendChild(make('div', 'sku', entry.error)); }
        row.appendChild(info);
        row.appendChild(make('td', 'num', core.formatCents(entry.receipt.totalCents)));
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
        if (entry.status === 'rejected' && user && user.roleName === 'Admin') {
          var remove = make('button', 'small secondary', 'Remove');
          remove.type = 'button';
          remove.style.marginTop = '6px';
          remove.onclick = function () {
            if (window.confirm('Remove this sale from the iPad? It is a real sale that the shop has NO record of. Only do this after the owner has dealt with it.')) {
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

  el('login-button').onclick = function () {
    say('login-message', '', '');
    setBusy('login-button', true, 'Checking...');
    core.login(el('username').value, el('password').value, function (error) {
      setBusy('login-button', false, 'Log in');
      el('password').value = '';
      if (error) { say('login-message', 'bad', error.message); return; }
      el('username').value = '';
      ui.tab = 'sell';
      route();
      showTab('sell');
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
    var held = core.getStatus().heldSales;
    var warning = pending > 0
      ? 'This iPad still holds ' + pending + ' sale(s) that the shop has not recorded. Disconnecting will DELETE them. Are you sure?'
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
  function armIdleTimer() {
    if (idleTimer) { window.clearTimeout(idleTimer); }
    if (!core.currentUser()) { return; }
    idleTimer = window.setTimeout(leaveTill, IDLE_LOGOUT_MS);
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
