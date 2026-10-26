/*
 * NexaPOS website support chat.
 *
 * One script, no libraries: it injects its own styles and a chat button (above the WhatsApp
 * button). A visitor must give an email address - every reply from support is also emailed to
 * it - and then talks to support from the same dashboard that answers the app's tickets.
 *
 * The chat is stored on the platform (sync.nexapos.cc); this browser keeps only the chat's id
 * and its secret token in localStorage, so the conversation is still here after a reload.
 * Test pages can point it elsewhere with <script src="chat.js" data-api="http://127.0.0.1:8081/index.php">.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var API = (script && script.getAttribute('data-api')) || 'https://sync.nexapos.cc/index.php';
  var SOUND_URL = script && script.src ? script.src.replace(/[^\/]*$/, '') + 'message-sent.mp3' : 'message-sent.mp3';
  var STORE_KEY = 'nexapos_site_chat_v1';
  var MAX_LENGTH = 2000;
  var POLL_OPEN_MS = 4000;
  var POLL_CLOSED_MS = 30000;
  var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  // ---------------------------------------------------------------- storage (may be unavailable)
  var memory = {};
  function load() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) || {} : {};
    } catch (e) {
      return memory;
    }
  }
  function save(data) {
    memory = data;
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch (e) { /* private window: the chat simply lasts until the page is closed */ }
  }

  var saved = load();
  var state = {
    ticketId: saved.ticketId || 0,
    token: saved.token || '',
    name: saved.name || '',
    email: saved.email || '',
    lastSeen: saved.lastSeen || 0,
    open: false,
    status: 'open',
    messages: [],
    sending: false,
    online: true,
    signature: '',
    pollTimer: null,
    pollBusy: false,
    failures: 0
  };
  function persist() {
    save({ ticketId: state.ticketId, token: state.token, name: state.name, email: state.email, lastSeen: state.lastSeen });
  }
  function hasChat() { return state.ticketId > 0 && state.token !== ''; }

  // ---------------------------------------------------------------- styles
  var css = [
    '.nxc{--nxc-me:#0078fe;--nxc-them:#e9e9eb;--nxc-them-ink:#14141f;--nxc-bg:#fff;--nxc-ink:#14141f;--nxc-soft:#6b6b80;--nxc-line:#e6e6f0;--nxc-field:#f4f4f8;--nxc-accent:var(--accent,#4f46e5);--nxc-err:#b91c1c;font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--nxc-ink)}',
    '@media (prefers-color-scheme:dark){.nxc{--nxc-them:#2b2d3a;--nxc-them-ink:#eef0fb;--nxc-bg:#161826;--nxc-ink:#eef0fb;--nxc-soft:#9aa0b4;--nxc-line:rgba(255,255,255,.1);--nxc-field:#0f1019;--nxc-err:#fca5a5}}',
    '.nxc *{box-sizing:border-box}',
    '.nxc-fab{position:fixed;right:24px;bottom:96px;width:58px;height:58px;border:0;border-radius:50%;background:var(--nxc-me);color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;z-index:100;transition:transform .15s ease}',
    '.nxc-fab:hover{transform:scale(1.08)}.nxc-fab:focus-visible,.nxc button:focus-visible,.nxc input:focus-visible,.nxc textarea:focus-visible{outline:3px solid color-mix(in srgb,var(--nxc-me) 55%,transparent);outline-offset:2px}',
    '.nxc-fab svg{width:28px;height:28px;fill:#fff}',
    '.nxc-badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#e11d48;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid var(--nxc-bg)}',
    '.nxc-panel{position:fixed;right:24px;bottom:96px;width:372px;max-width:calc(100vw - 16px);height:min(600px,calc(100vh - 120px));height:min(600px,calc(100dvh - 120px));display:none;flex-direction:column;background:var(--nxc-bg);border:1px solid var(--nxc-line);border-radius:18px;box-shadow:0 24px 60px -16px rgba(15,23,42,.45);overflow:hidden;z-index:110}',
    '.nxc-panel.open{display:flex}',
    '.nxc-head{display:flex;align-items:center;gap:10px;padding:12px 12px 12px 16px;background:var(--nxc-me);color:#fff}',
    '.nxc-head .nxc-title{flex:1;min-width:0}.nxc-head b{display:block;font-size:15px}.nxc-head small{display:block;opacity:.88;font-size:12px}',
    '.nxc-head button{border:0;background:rgba(255,255,255,.18);color:#fff;border-radius:50%;width:34px;height:34px;cursor:pointer;font-size:18px;line-height:1;display:flex;align-items:center;justify-content:center}',
    '.nxc-head button:hover{background:rgba(255,255,255,.3)}.nxc-head button[hidden]{display:none}',
    '.nxc-confirm{display:none;padding:10px 14px;background:var(--nxc-field);border-bottom:1px solid var(--nxc-line);font-size:13px}',
    '.nxc-confirm.show{display:block}.nxc-confirm .nxc-row{display:flex;gap:8px;margin-top:8px}',
    '.nxc-btn{border:0;border-radius:10px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer;background:var(--nxc-me);color:#fff}',
    '.nxc-btn.ghost{background:transparent;color:var(--nxc-ink);border:1px solid var(--nxc-line)}.nxc-btn:disabled{opacity:.55;cursor:default}',
    '.nxc-form{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}',
    '.nxc-form p{margin:0;color:var(--nxc-soft)}',
    '.nxc-form label{display:block;font-weight:600;font-size:13px;margin-bottom:4px}',
    '.nxc-form .nxc-hint{font-weight:400;color:var(--nxc-soft);font-size:12px;margin-top:3px}',
    '.nxc input[type=text],.nxc input[type=email],.nxc textarea{display:block;width:100%;border:1px solid var(--nxc-line);background:var(--nxc-field);color:var(--nxc-ink);border-radius:10px;padding:10px 12px;font:inherit}',
    '.nxc textarea{resize:vertical}',
    '.nxc-trap{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}',
    '.nxc-error{color:var(--nxc-err);font-size:13px;min-height:0}.nxc-error:empty{display:none}',
    '.nxc-legal{font-size:12px;color:var(--nxc-soft)}',
    '.nxc-chat{flex:1;display:none;flex-direction:column;min-height:0}.nxc-chat.show{display:flex}',
    '.nxc-log{flex:1;overflow-y:auto;padding:12px 12px 4px;display:flex;flex-direction:column;gap:3px;overscroll-behavior:contain}',
    '.nxc-time{align-self:center;color:var(--nxc-soft);font-size:11px;margin:8px 0 4px}',
    '.nxc-msg{max-width:82%;position:relative;display:flex;flex-direction:column}',
    '.nxc-msg.me{align-self:flex-end;align-items:flex-end}.nxc-msg.them{align-self:flex-start;align-items:flex-start}',
    '.nxc-bubble{padding:8px 12px;border-radius:18px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}',
    '.nxc-msg.me .nxc-bubble{background:var(--nxc-me);color:#fff;border-bottom-right-radius:5px}',
    '.nxc-msg.them .nxc-bubble{background:var(--nxc-them);color:var(--nxc-them-ink);border-bottom-left-radius:5px}',
    '.nxc-msg.pending .nxc-bubble{opacity:.6}',
    '.nxc-quote{font-size:12px;color:var(--nxc-soft);border-left:3px solid var(--nxc-line);padding:1px 8px;margin:0 4px 3px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.nxc-react{position:absolute;bottom:-9px;background:var(--nxc-bg);border:1px solid var(--nxc-line);border-radius:12px;padding:0 5px;font-size:13px;line-height:20px}',
    '.nxc-msg.me .nxc-react{left:-6px}.nxc-msg.them .nxc-react{right:-6px}.nxc-msg.has-react{margin-bottom:9px}',
    '.nxc-photo{display:block;max-width:100%;max-height:220px;border-radius:14px;margin-bottom:3px;cursor:zoom-in;background:var(--nxc-field)}',
    '.nxc-sub{font-size:11px;color:var(--nxc-soft);margin:2px 6px 0}',
    '.nxc-note{margin:6px 12px;padding:8px 10px;border-radius:10px;background:var(--nxc-field);color:var(--nxc-soft);font-size:12px}',
    '.nxc-compose{display:flex;align-items:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--nxc-line)}',
    '.nxc-compose textarea{flex:1;resize:none;max-height:110px;border-radius:18px;padding:9px 14px}',
    '.nxc-send{width:38px;height:38px;border:0;border-radius:50%;background:var(--nxc-me);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none}',
    '.nxc-send:disabled{opacity:.4;cursor:default}.nxc-send svg{width:18px;height:18px;fill:#fff}',
    '.nxc-foot{padding:0 14px 10px;font-size:11px;color:var(--nxc-soft)}',
    '.nxc-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;z-index:120;padding:16px;cursor:zoom-out}',
    '.nxc-lightbox.show{display:flex}.nxc-lightbox img{max-width:100%;max-height:100%;border-radius:8px}',
    '@media (max-width:480px){.nxc-panel{right:8px;left:8px;bottom:8px;width:auto;max-width:none;height:min(640px,calc(100vh - 16px));height:min(640px,calc(100dvh - 16px));border-radius:16px}.nxc-fab{right:16px;bottom:88px}}',
    '@media (prefers-reduced-motion:reduce){.nxc-fab{transition:none}}'
  ].join('\n');

  // ---------------------------------------------------------------- tiny DOM helpers
  function h(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === false || value === null || value === undefined) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    });
    (kids || []).forEach(function (kid) {
      if (kid) node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    });
    return node;
  }
  var ICON_CHAT = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3 20.5v-6.7l9-1.8-9-1.8V3.5L22 12z"/></svg>';

  // ---------------------------------------------------------------- the page elements
  var root = h('div', { class: 'nxc' });
  var styleTag = h('style', { text: css });

  var fab = h('button', { class: 'nxc-fab', type: 'button', 'aria-label': 'Chat with NexaPOS support', title: 'Chat with support', onclick: function () { setOpen(true); } });
  fab.innerHTML = ICON_CHAT;
  var badge = h('span', { class: 'nxc-badge', hidden: true, 'aria-hidden': 'true' });
  fab.appendChild(badge);

  var newBtn = h('button', { type: 'button', 'aria-label': 'Start a new chat', title: 'New chat', text: '+', hidden: true, onclick: function () { confirmBox.classList.add('show'); } });
  var closeBtn = h('button', { type: 'button', 'aria-label': 'Close chat', title: 'Close', text: '×', onclick: function () { setOpen(false); } });
  var subtitle = h('small', { text: 'We reply here and by email' });
  var head = h('div', { class: 'nxc-head' }, [
    h('div', { class: 'nxc-title' }, [h('b', { text: 'NexaPOS Support' }), subtitle]),
    newBtn, closeBtn
  ]);

  var confirmBox = h('div', { class: 'nxc-confirm', role: 'alertdialog', 'aria-label': 'Start a new chat?' }, [
    h('div', { text: 'Start a new chat? This one stays in your email and with support.' }),
    h('div', { class: 'nxc-row' }, [
      h('button', { class: 'nxc-btn', type: 'button', text: 'Start new chat', onclick: function () { resetChat(); } }),
      h('button', { class: 'nxc-btn ghost', type: 'button', text: 'Keep this chat', onclick: function () { confirmBox.classList.remove('show'); } })
    ])
  ]);

  // The first-message form.
  var nameInput = h('input', { type: 'text', id: 'nxc-name', maxlength: '80', autocomplete: 'name', placeholder: 'Your name (optional)' });
  var emailInput = h('input', { type: 'email', id: 'nxc-email', required: true, maxlength: '254', autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com', 'aria-describedby': 'nxc-email-hint' });
  var firstInput = h('textarea', { id: 'nxc-first', rows: '3', required: true, maxlength: String(MAX_LENGTH), placeholder: 'How can we help?' });
  var trapInput = h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  var formError = h('div', { class: 'nxc-error', role: 'alert' });
  var startBtn = h('button', { class: 'nxc-btn', type: 'submit', text: 'Start chat' });
  var form = h('form', { class: 'nxc-form', novalidate: true, onsubmit: onStart }, [
    h('p', { text: 'Ask us anything about NexaPOS. We usually reply within a few hours, and every reply is also emailed to you.' }),
    h('div', {}, [h('label', { for: 'nxc-name', text: 'Name' }), nameInput]),
    h('div', {}, [
      h('label', { for: 'nxc-email', text: 'Email address (required)' }), emailInput,
      h('div', { class: 'nxc-hint', id: 'nxc-email-hint', text: 'We email you a copy of every reply.' })
    ]),
    h('div', {}, [h('label', { for: 'nxc-first', text: 'Message' }), firstInput]),
    h('div', { class: 'nxc-trap', 'aria-hidden': 'true' }, [h('label', { text: 'Leave this empty' }), trapInput]),
    formError,
    startBtn,
    h('div', { class: 'nxc-legal' }, ['By starting a chat you agree that we store your message and email address to answer you. See our ',
      h('a', { href: 'privacy.html', text: 'Privacy Policy' }), '.'])
  ]);

  // The conversation.
  var log = h('div', { class: 'nxc-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation with NexaPOS support' });
  var note = h('div', { class: 'nxc-note', hidden: true });
  var sendError = h('div', { class: 'nxc-error', role: 'alert', style: 'padding:0 14px' });
  var composer = h('textarea', { rows: '1', maxlength: String(MAX_LENGTH), 'aria-label': 'Write a message', placeholder: 'Write a message', onkeydown: onComposerKey, oninput: onComposerInput });
  var sendBtn = h('button', { class: 'nxc-send', type: 'submit', 'aria-label': 'Send', disabled: true });
  sendBtn.innerHTML = ICON_SEND;
  var footNote = h('div', { class: 'nxc-foot' });
  var chat = h('div', { class: 'nxc-chat' }, [
    log, note, sendError,
    h('form', { class: 'nxc-compose', onsubmit: onSend }, [composer, sendBtn]),
    footNote
  ]);

  var lightboxImg = h('img', { alt: 'Photo from support' });
  var lightbox = h('div', { class: 'nxc-lightbox', onclick: function () { lightbox.classList.remove('show'); } }, [lightboxImg]);

  var panel = h('section', { class: 'nxc-panel', role: 'dialog', 'aria-label': 'NexaPOS support chat' }, [head, confirmBox, form, chat]);
  root.appendChild(fab);
  root.appendChild(panel);
  root.appendChild(lightbox);

  // ---------------------------------------------------------------- talking to the platform
  function request(action, options) {
    options = options || {};
    var query = options.query || {};
    var url = API + '?action=' + action + Object.keys(query).map(function (key) { return '&' + key + '=' + encodeURIComponent(query[key]); }).join('');
    var headers = {};
    if (options.body) headers['Content-Type'] = 'application/json';
    if (options.token) headers['X-Chat-Token'] = options.token;
    return fetch(url, {
      method: options.body ? 'POST' : 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    });
  }

  // ---------------------------------------------------------------- rendering
  function parseServerDate(raw) {
    var ms = raw ? new Date(String(raw).replace(' ', 'T') + 'Z').getTime() : NaN;
    return isFinite(ms) ? ms : null;
  }
  function two(n) { return n < 10 ? '0' + n : String(n); }
  function clock(date) { return two(date.getHours()) + ':' + two(date.getMinutes()); }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function timeLabel(ms) {
    var date = new Date(ms);
    var now = new Date();
    if (date.toDateString() === now.toDateString()) return 'Today ' + clock(date);
    var yesterday = new Date(now.getTime() - 86400000);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday ' + clock(date);
    return date.getDate() + ' ' + MONTHS[date.getMonth()] + ' ' + clock(date);
  }
  function maskEmail(email) {
    var at = email.lastIndexOf('@');
    return at < 1 ? email : email.charAt(0) + '***' + email.slice(at);
  }

  var photoUrls = {}; // attachment id -> object URL (or 'pending'/'failed')
  function photoFor(attachmentId, img) {
    var cached = photoUrls[attachmentId];
    if (cached && cached !== 'pending' && cached !== 'failed') { img.src = cached; return; }
    if (cached === 'pending' || cached === 'failed') return;
    photoUrls[attachmentId] = 'pending';
    fetch(API + '?action=web_chat_attachment&ticket_id=' + state.ticketId + '&id=' + attachmentId, { headers: { 'X-Chat-Token': state.token } })
      .then(function (res) { return res.ok ? res.blob() : Promise.reject(new Error('photo')); })
      .then(function (blob) {
        photoUrls[attachmentId] = URL.createObjectURL(blob);
        state.signature = ''; // draw again with the picture
        renderMessages();
      })
      .catch(function () { photoUrls[attachmentId] = 'failed'; });
  }

  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }

  function renderMessages() {
    var signature = JSON.stringify([state.messages, state.sending, state.status, Object.keys(photoUrls).length]);
    if (signature === state.signature) return;
    state.signature = signature;
    var stick = nearBottom() || log.childNodes.length === 0;
    log.textContent = '';
    var lastTime = 0;
    var lastOwnIndex = -1;
    state.messages.forEach(function (m, index) { if (m.sender === 'customer') lastOwnIndex = index; });
    state.messages.forEach(function (m, index) {
      var when = parseServerDate(m.created_at);
      if (when !== null && when - lastTime > 15 * 60000) {
        log.appendChild(h('div', { class: 'nxc-time', text: timeLabel(when) }));
        lastTime = when;
      }
      var mine = m.sender === 'customer';
      var reactions = (m.reactions || []).map(function (r) { return r.emoji; }).join('');
      var box = h('div', { class: 'nxc-msg ' + (mine ? 'me' : 'them') + (reactions ? ' has-react' : ''), title: when !== null ? timeLabel(when) : '' });
      if (m.reply_to && m.reply_to.snippet) {
        box.appendChild(h('div', { class: 'nxc-quote', text: (m.reply_to.sender === 'support' ? 'Support: ' : 'You: ') + m.reply_to.snippet }));
      }
      (m.attachments || []).forEach(function (attachment) {
        var img = h('img', { class: 'nxc-photo', alt: 'Photo from support', onclick: function () { if (img.src) { lightboxImg.src = img.src; lightbox.classList.add('show'); } } });
        photoFor(attachment.id, img);
        box.appendChild(img);
      });
      if (m.body) box.appendChild(h('div', { class: 'nxc-bubble', text: m.body }));
      if (reactions) box.appendChild(h('span', { class: 'nxc-react', text: reactions, 'aria-label': 'Reaction ' + reactions }));
      if (mine && index === lastOwnIndex) {
        box.appendChild(h('div', { class: 'nxc-sub', text: 'Delivered' }));
      }
      log.appendChild(box);
    });
    if (state.sending && state.pendingText) {
      var pending = h('div', { class: 'nxc-msg me pending' }, [h('div', { class: 'nxc-bubble', text: state.pendingText }), h('div', { class: 'nxc-sub', text: 'Sending…' })]);
      log.appendChild(pending);
    }
    if (stick) log.scrollTop = log.scrollHeight;
  }

  function renderStatus() {
    var closed = state.status === 'closed';
    note.hidden = !closed && state.online;
    if (!state.online) note.textContent = 'Reconnecting… your messages are safe.';
    else if (closed) note.textContent = 'This chat was marked resolved. Write below to reopen it.';
    footNote.textContent = state.email ? 'Replies are also emailed to ' + maskEmail(state.email) + '.' : '';
  }

  function updateBadge() {
    var unread = state.messages.filter(function (m) { return m.sender === 'support' && m.id > state.lastSeen; }).length;
    badge.hidden = state.open || unread === 0;
    badge.textContent = unread > 9 ? '9+' : String(unread);
    fab.setAttribute('aria-label', unread > 0 && !state.open ? 'Chat with NexaPOS support, ' + unread + ' new' : 'Chat with NexaPOS support');
  }

  function showView() {
    var chatting = hasChat();
    form.style.display = chatting ? 'none' : '';
    chat.classList.toggle('show', chatting);
    newBtn.hidden = !chatting;
    confirmBox.classList.remove('show');
    subtitle.textContent = chatting ? 'We reply here and by email' : 'We reply here and by email';
    if (chatting) renderStatus();
  }

  // ---------------------------------------------------------------- opening, polling
  function setOpen(open) {
    state.open = open;
    panel.classList.toggle('open', open);
    fab.style.display = open ? 'none' : 'flex';
    showView();
    if (open) {
      if (hasChat()) {
        composer.focus();
        poll(true);
      } else {
        (state.email ? firstInput : (nameInput.value ? emailInput : nameInput)).focus();
      }
    } else {
      fab.focus();
    }
    schedule();
    updateBadge();
  }

  function schedule() {
    clearTimeout(state.pollTimer);
    if (!hasChat()) return;
    var base = state.open ? POLL_OPEN_MS : POLL_CLOSED_MS;
    var delay = Math.min(base * Math.pow(2, Math.min(state.failures, 3)), 60000);
    state.pollTimer = setTimeout(function () { poll(false); }, delay);
  }

  function poll(markRead) {
    if (!hasChat() || state.pollBusy || (document.hidden && !markRead)) { schedule(); return Promise.resolve(); }
    state.pollBusy = true;
    var query = { ticket_id: state.ticketId };
    if (state.open && !document.hidden) query.mark_read = '1';
    return request('web_chat_thread', { token: state.token, query: query }).then(function (res) {
      state.failures = 0;
      state.online = true;
      if (res.status === 404) { chatGone(); return; }
      if (!res.data || !res.data.success) { return; }
      state.status = res.data.ticket.status;
      state.messages = res.data.messages || [];
      if (state.open) {
        var newest = 0;
        state.messages.forEach(function (m) { if (m.sender === 'support' && m.id > newest) newest = m.id; });
        if (newest > state.lastSeen) { state.lastSeen = newest; persist(); }
      }
      renderMessages();
      renderStatus();
      updateBadge();
    }).catch(function () {
      state.failures += 1;
      if (state.failures >= 2) { state.online = false; renderStatus(); }
    }).then(function () {
      state.pollBusy = false;
      schedule();
    });
  }

  function chatGone() {
    var email = state.email;
    var name = state.name;
    state.ticketId = 0; state.token = ''; state.messages = []; state.signature = '';
    persist();
    state.email = email; state.name = name;
    persist();
    emailInput.value = email;
    nameInput.value = name;
    formError.textContent = 'That chat is no longer available. You can start a new one.';
    showView();
    updateBadge();
  }

  function resetChat() {
    clearTimeout(state.pollTimer);
    var email = state.email;
    var name = state.name;
    state.ticketId = 0; state.token = ''; state.messages = []; state.signature = ''; state.lastSeen = 0; state.status = 'open';
    state.email = email; state.name = name;
    persist();
    log.textContent = '';
    emailInput.value = email;
    nameInput.value = name;
    firstInput.value = '';
    formError.textContent = '';
    showView();
    updateBadge();
    emailInput.focus();
  }

  // ---------------------------------------------------------------- sending
  var sound = null;
  var soundPrimed = false;
  function primeSound() {
    // Called from the visitor's click: browsers only let a page play sound it was asked to.
    if (soundPrimed) return;
    soundPrimed = true;
    try {
      sound = new Audio(SOUND_URL);
      sound.preload = 'auto';
      sound.volume = 0.8;
      sound.muted = true;
      var attempt = sound.play();
      if (attempt && attempt.then) {
        attempt.then(function () { sound.pause(); sound.currentTime = 0; sound.muted = false; }).catch(function () { sound.muted = false; });
      } else { sound.muted = false; }
    } catch (e) { sound = null; }
  }
  function playSent() {
    if (!sound) return;
    try {
      sound.muted = false;
      sound.currentTime = 0;
      var attempt = sound.play();
      if (attempt && attempt.catch) attempt.catch(function () { /* the browser said no: stay quiet */ });
    } catch (e) { /* no sound is fine */ }
  }

  function friendlyError(res, fallback) {
    if (res && res.data && res.data.message) return res.data.message;
    return fallback;
  }

  function showFormError(text) {
    formError.textContent = text;
    if (formError.scrollIntoView) formError.scrollIntoView({ block: 'nearest' });
  }

  function onStart(event) {
    event.preventDefault();
    var email = emailInput.value.trim();
    var message = firstInput.value.trim();
    formError.textContent = '';
    if (!EMAIL_PATTERN.test(email)) { showFormError('Enter your email address - we send a copy of every reply there.'); emailInput.focus(); return; }
    if (message.length < 2) { showFormError('Write your message first.'); firstInput.focus(); return; }
    primeSound();
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    request('web_chat_start', { body: { name: nameInput.value.trim(), email: email, message: message, website: trapInput.value } }).then(function (res) {
      if (res.status === 201 && res.data && res.data.success && res.data.ticket_id > 0) {
        state.ticketId = res.data.ticket_id;
        state.token = res.data.token;
        state.email = email;
        state.name = nameInput.value.trim();
        state.lastSeen = 0;
        state.messages = []; state.signature = ''; state.status = 'open';
        persist();
        firstInput.value = '';
        playSent();
        showView();
        composer.focus();
        return poll(true);
      }
      showFormError(friendlyError(res, 'We could not start the chat. Please try again, or message us on WhatsApp.'));
    }).catch(function () {
      showFormError('We could not reach the server. Check your connection and try again, or message us on WhatsApp.');
    }).then(function () {
      startBtn.disabled = false;
      startBtn.textContent = 'Start chat';
    });
  }

  function onComposerInput() {
    composer.style.height = 'auto';
    composer.style.height = Math.min(composer.scrollHeight, 110) + 'px';
    sendBtn.disabled = state.sending || composer.value.trim() === '';
    sendError.textContent = '';
  }
  function onComposerKey(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!sendBtn.disabled) onSend(event);
    }
  }

  function onSend(event) {
    event.preventDefault();
    var text = composer.value.trim();
    if (!text || state.sending || !hasChat()) return;
    primeSound();
    state.sending = true;
    state.pendingText = text;
    sendBtn.disabled = true;
    sendError.textContent = '';
    renderMessages();
    request('web_chat_send', { token: state.token, body: { ticket_id: state.ticketId, message: text } }).then(function (res) {
      if (res.status === 404) { chatGone(); return; }
      if (res.data && res.data.success) {
        composer.value = '';
        composer.style.height = 'auto';
        playSent();
        return poll(true);
      }
      sendError.textContent = friendlyError(res, 'Your message was not sent. Please try again.');
    }).catch(function () {
      sendError.textContent = 'Your message was not sent - check your connection and try again.';
    }).then(function () {
      state.sending = false;
      state.pendingText = '';
      state.signature = '';
      renderMessages();
      onComposerInput();
    });
  }

  // ---------------------------------------------------------------- start
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (lightbox.classList.contains('show')) lightbox.classList.remove('show');
    else if (state.open) setOpen(false);
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && hasChat()) poll(false); });

  emailInput.value = state.email;
  nameInput.value = state.name;
  function mount() {
    document.head.appendChild(styleTag);
    document.body.appendChild(root);
    showView();
    if (hasChat()) poll(false);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  // Lets a "Chat with us" link on the page open the chat: <a href="#chat">.
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href="#chat"]') : null;
    if (link) { event.preventDefault(); setOpen(true); }
  });
  window.NexaposChat = { open: function () { setOpen(true); } };
})();
