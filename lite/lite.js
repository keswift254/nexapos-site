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
  var ui = { tab: 'sell', cart: [], saleType: 'retail', payment: 'cash', receiptId: null, lastSyncProblem: '', syncing: false };

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
    if (status.pendingSales > 0) {
      var warn = make('div', 'notice warn', status.pendingSales + (status.pendingSales === 1 ? ' sale is' : ' sales are') + ' saved on this iPad and waiting to be sent to the shop. ' + (ui.lastSyncProblem ? ui.lastSyncProblem + ' ' : ''));
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
    renderPicker();
    renderCart();
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
          say('sell-message', 'warn', 'Only ' + product.stockQty + ' ' + product.name + ' in stock.');
          return;
        }
        ui.cart[i].qty += 1;
        say('sell-message', '', '');
        renderCart();
        return;
      }
    }
    ui.cart.push({ productId: product.id, name: product.name, qty: 1 });
    say('sell-message', '', '');
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

  // ---- selling: the cart and totals --------------------------------------------------------------------------
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
        var x = make('button', 'small secondary', '×');
        x.type = 'button';
        x.onclick = function () { ui.cart.splice(index, 1); renderCart(); };
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
    if (t.discount > 0) { totalRow('Discount', '-' + core.formatCents(t.discount)); }
    totalRow('Total', core.formatCents(t.total), 'grand');
    var received = ui.payment === 'cash' ? core.parseCents(el('cash-received').value) : null;
    if (received !== null && received >= t.total && ui.cart.length > 0) { totalRow('Change to give', core.formatCents(received - t.total)); }
    if (received !== null && received < t.total && ui.cart.length > 0) { totalRow('Still to pay', core.formatCents(t.total - received)); }

    var blocked = core.sellBlockedReason();
    el('complete-button').disabled = ui.cart.length === 0 || !!blocked || !t.discountOk;
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
  el('pay-cash').onclick = function () { setPayment('cash'); };
  el('pay-mpesa').onclick = function () { setPayment('mpesa_manual'); };
  function setPayment(method) {
    ui.payment = method;
    el('pay-cash').className = method === 'cash' ? 'on' : '';
    el('pay-mpesa').className = method === 'mpesa_manual' ? 'on' : '';
    show('pay-cash-box', method === 'cash');
    show('pay-mpesa-box', method === 'mpesa_manual');
    renderCart();
  }

  function resetSale() {
    ui.cart = [];
    el('discount').value = '';
    el('customer').value = '';
    el('cash-received').value = '';
    el('mpesa-phone').value = '';
    el('mpesa-ref').value = '';
    say('sell-message', '', '');
    setSaleType('retail');
    setPayment('cash');
  }
  el('clear-button').onclick = resetSale;

  // ---- completing a sale -------------------------------------------------------------------------------------
  el('complete-button').onclick = function () {
    var t = totals();
    var cart = [];
    for (var i = 0; i < t.lines.length; i++) {
      cart.push({ productId: t.lines[i].item.productId, name: t.lines[i].item.name, unitPriceCents: t.lines[i].unit, quantity: t.lines[i].item.qty });
    }
    var cashTyped = el('cash-received').value.replace(/^\s+|\s+$/g, '');
    var result = core.sell({
      cart: cart,
      saleType: ui.saleType,
      paymentMethod: ui.payment,
      discountCents: t.discount,
      customerName: el('customer').value,
      customerPhone: el('mpesa-phone').value,
      referenceNote: el('mpesa-ref').value,
      cashReceivedCents: ui.payment === 'cash' && cashTyped !== '' ? core.parseCents(cashTyped) : null
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

  function showReceipt(receipt) {
    var box = el('receipt-box');
    box.innerHTML = '';
    var card = make('div', 'receipt');
    card.appendChild(make('div', 'muted', 'Sale ' + receipt.saleNumber + ' · ' + timeText(receipt.createdAt)));
    card.appendChild(make('div', 'big', 'Total ' + core.formatCents(receipt.totalCents)));
    card.appendChild(make('div', '', (receipt.paymentMethod === 'cash' ? 'Paid in cash' : 'Paid by M-Pesa' + (receipt.referenceNote ? ' (' + receipt.referenceNote + ')' : '')) + (receipt.customerName !== 'Walk-in customer' ? ' · ' + receipt.customerName : '')));
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
    var next = make('button', 'big', 'New sale');
    next.type = 'button';
    next.onclick = function () { ui.receiptId = null; show('receipt-box', false); show('sell-form', true); };
    card.appendChild(next);
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

  // ---- the Sales tab -----------------------------------------------------------------------------------------
  function renderSales() {
    var body = el('sales-rows');
    body.innerHTML = '';
    var list = core.history();
    var user = core.currentUser();
    for (var i = 0; i < Math.min(list.length, 50); i++) {
      (function (entry) {
        var row = make('tr');
        var info = make('td', '', entry.receipt.saleNumber);
        info.appendChild(make('div', 'sku', timeText(entry.receipt.createdAt) + ' · ' + (entry.receipt.paymentMethod === 'cash' ? 'Cash' : 'M-Pesa')));
        if (entry.status === 'rejected') { info.appendChild(make('div', 'sku', entry.error)); }
        row.appendChild(info);
        row.appendChild(make('td', 'num', core.formatCents(entry.receipt.totalCents)));
        var state = make('td', 'num');
        var label = entry.status === 'sent' ? ['sent', 'Sent'] : (entry.status === 'rejected' ? ['lost', 'NOT recorded'] : (entry.status === 'discarded' ? ['waiting', 'Removed'] : ['waiting', 'Waiting']));
        state.appendChild(make('span', 'badge ' + label[0], label[1]));
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

  el('logout-button').onclick = function () { core.logout(); ui.cart = []; ui.receiptId = null; route(); };
  el('forget-button').onclick = function () {
    var pending = core.getStatus().pendingSales + core.getStatus().rejectedSales;
    var warning = pending > 0
      ? 'This iPad still holds ' + pending + ' sale(s) that the shop has not recorded. Disconnecting will DELETE them. Are you sure?'
      : 'Disconnect this iPad from the shop? You will need a new invite code to connect again.';
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
    idleTimer = window.setTimeout(function () { core.logout(); ui.cart = []; ui.receiptId = null; route(); }, IDLE_LOGOUT_MS);
  }
  var activity = ['touchstart', 'click', 'keydown'];
  for (var a = 0; a < activity.length; a++) {
    document.addEventListener(activity[a], armIdleTimer, false);
  }

  // ---- keep sending: on load, every 30 seconds, and when the internet comes back ------------------------------
  window.setInterval(function () {
    if (core.getStatus().joined) { doSync(false); }
  }, SYNC_EVERY_MS);
  window.addEventListener('online', function () { if (core.getStatus().joined) { doSync(false); } }, false);

  // ---- start -------------------------------------------------------------------------------------------------
  route();
  if (core.getStatus().joined) {
    doSync(false);
  }
}());
