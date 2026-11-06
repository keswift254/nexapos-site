/*
 * NexaPOS Lite till - the screens. ES5 only (iOS 10 Safari). All the real work is in lite-core.js (tested);
 * this file only moves text between the page and the core.
 */
(function () {
  'use strict';

  var API = 'https://sync.nexapos.cc/index.php';
  var IDLE_LOGOUT_MS = 10 * 60 * 1000;
  var MAX_ROWS = 100;

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
  var bcryptLib = window.dcodeIO && window.dcodeIO.bcrypt ? window.dcodeIO.bcrypt : (window.bcrypt || null);
  if (!bcryptLib) { missing.push('the password checker'); }
  if (missing.length) {
    el('compat').innerHTML = '';
    el('compat').appendChild(document.createTextNode('This browser cannot run NexaPOS Lite (missing: ' + missing.join(', ') + '). Try Safari, or update the iPad if it can be updated.'));
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

  var core = window.NexaLiteCore.create({ baseUrl: API, http: xhrHttp, storage: storage, bcrypt: bcryptLib });

  // ---- small helpers -----------------------------------------------------------------------------------------
  function say(containerId, kind, text) {
    var box = el(containerId);
    box.innerHTML = '';
    if (!text) { return; }
    var note = document.createElement('div');
    note.className = 'notice ' + kind;
    note.appendChild(document.createTextNode(text));
    box.appendChild(note);
  }

  function setBusy(buttonId, busy, label) {
    var button = el(buttonId);
    button.disabled = busy;
    if (label) { setText(buttonId, label); }
  }

  function updatedText(status) {
    if (!status.fetchedAt) { return ''; }
    var d = new Date(status.fetchedAt);
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return 'Shop data updated ' + d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear() + ' at ' + two(d.getHours()) + ':' + two(d.getMinutes()) + '.';
  }

  function licenseNotice(containerId, status) {
    var license = status.license;
    if (license.state === 'unknown') { say(containerId, 'warn', license.message); }
    else if (!license.ok) { say(containerId, 'bad', license.message); }
    else if (license.daysLeft !== undefined && license.daysLeft !== null && license.daysLeft <= 14) { say(containerId, 'warn', license.message); }
    else { say(containerId, 'ok', license.message); }
  }

  // ---- screens -----------------------------------------------------------------------------------------------
  function route() {
    var status = core.getStatus();
    var user = core.currentUser();
    show('screen-setup', false);
    show('screen-login', false);
    show('screen-catalog', false);
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
      say('login-revoked', 'bad', status.revoked ? 'This iPad is no longer allowed to use the shop. Ask the owner to check Connected devices, or disconnect it here and connect again.' : '');
      return;
    }
    show('screen-catalog', true);
    setText('catalog-shop', status.shopName || 'NexaPOS Lite');
    setText('catalog-user', user.name + ' (' + user.roleName + ')');
    setText('catalog-updated', updatedText(status));
    licenseNotice('catalog-license', status);
    fillCategories();
    renderProducts();
  }

  function fillCategories() {
    var select = el('category');
    var chosen = select.value;
    select.innerHTML = '';
    var all = document.createElement('option');
    all.value = '';
    all.appendChild(document.createTextNode('All categories'));
    select.appendChild(all);
    var list = core.categories();
    for (var i = 0; i < list.length; i++) {
      var option = document.createElement('option');
      option.value = list[i].id;
      option.appendChild(document.createTextNode(list[i].name));
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
      var row = document.createElement('tr');

      var name = document.createElement('td');
      name.appendChild(document.createTextNode(p.name));
      var sku = document.createElement('div');
      sku.className = 'sku';
      sku.appendChild(document.createTextNode(p.sku + (p.barcode ? '  ·  ' + p.barcode : '')));
      name.appendChild(sku);
      row.appendChild(name);

      var price = document.createElement('td');
      price.className = 'num';
      price.appendChild(document.createTextNode(core.formatCents(p.retailPriceCents)));
      row.appendChild(price);

      var stock = document.createElement('td');
      stock.className = 'num';
      stock.appendChild(document.createTextNode(String(p.stockQty)));
      if (p.stockQty <= 0) {
        var out = document.createElement('span');
        out.className = 'badge out';
        out.appendChild(document.createTextNode('Out'));
        stock.appendChild(out);
      } else if (p.stockQty <= p.reorderLevel) {
        var low = document.createElement('span');
        low.className = 'badge low';
        low.appendChild(document.createTextNode('Low'));
        stock.appendChild(low);
      }
      row.appendChild(stock);
      body.appendChild(row);
    }
    setText('product-count', found.length === 0
      ? 'No products match.'
      : (found.length > shown ? 'Showing the first ' + shown + ' of ' + found.length + ' products. Type in the search box to narrow it down.' : found.length + ' product' + (found.length === 1 ? '' : 's') + '. Prices in ' + status.currency + '.'));
  }

  // ---- actions -----------------------------------------------------------------------------------------------
  el('join-button').onclick = function () {
    say('setup-message', '', '');
    setBusy('join-button', true, 'Connecting...');
    core.join(el('invite').value, el('label').value, function (error) {
      setBusy('join-button', false, 'Connect');
      if (error) { say('setup-message', 'bad', error.message); return; }
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
      route();
      armIdleTimer();
    });
  };

  function doRefresh(buttonId, messageId) {
    say(messageId, '', '');
    setBusy(buttonId, true, 'Updating...');
    core.refresh(function (error) {
      setBusy(buttonId, false, 'Update shop data');
      if (error) { say(messageId, error.code === 'offline' ? 'warn' : 'bad', error.message); }
      route();
    });
  }
  el('login-refresh').onclick = function () { doRefresh('login-refresh', 'login-message'); };
  el('catalog-refresh').onclick = function () { doRefresh('catalog-refresh', 'catalog-message'); };

  el('logout-button').onclick = function () { core.logout(); route(); };
  el('forget-button').onclick = function () {
    if (window.confirm('Disconnect this iPad from the shop? You will need a new invite code to connect again.')) {
      core.forget();
      route();
    }
  };

  var searchTimer = null;
  el('search').oninput = function () {
    if (searchTimer) { window.clearTimeout(searchTimer); }
    searchTimer = window.setTimeout(renderProducts, 250);
  };
  el('category').onchange = renderProducts;

  // ---- log out after 10 minutes with no touch -----------------------------------------------------------------
  var idleTimer = null;
  function armIdleTimer() {
    if (idleTimer) { window.clearTimeout(idleTimer); }
    if (!core.currentUser()) { return; }
    idleTimer = window.setTimeout(function () { core.logout(); route(); }, IDLE_LOGOUT_MS);
  }
  var activity = ['touchstart', 'click', 'keydown'];
  for (var a = 0; a < activity.length; a++) {
    document.addEventListener(activity[a], armIdleTimer, false);
  }

  // ---- start -------------------------------------------------------------------------------------------------
  route();
  if (core.getStatus().joined) {
    // Quietly bring the shop data up to date when the page opens (offline is fine: the saved copy is used).
    core.refresh(function () { if (!core.currentUser()) { route(); } });
  }
}());
