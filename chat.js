/*
 * NexaPOS website support chat.
 *
 * One script, no libraries: it injects its own styles and a chat button (above the WhatsApp
 * button). It works in three steps:
 *   1. "bot"  - a built-in assistant answers common questions at once (topic buttons, or the
 *               visitor types a question) and then asks "Did this help?". Yes ends it there.
 *   2. "form" - when it did not help (or the visitor wants a person) the visitor says where to
 *               send the reply. An email address is mandatory: every reply is also emailed there.
 *   3. "chat" - the real conversation with support, answered from the same dashboard as the
 *               app's tickets. Photos can be attached.
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
  var MAX_PHOTOS = 4;
  var MAX_PHOTO_BYTES = 1900000;   // the server takes 2 MB a photo
  var MAX_TOTAL_BYTES = 3900000;   // and 4 MB a message
  var MAX_SIDE = 1600;
  var POLL_OPEN_MS = 4000;
  var POLL_CLOSED_MS = 30000;
  var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  // ---------------------------------------------------------------- what the assistant knows
  // Each topic: the button's title, words that point to it, and the answer. Keep answers short and
  // true - anything it cannot settle goes to a person.
  var TOPICS = [
    {
      id: 'install', title: 'Install & activate',
      words: ['install', 'installed', 'installing', 'installer', 'download', 'downloading', 'setup', 'set up', 'activate', 'activated', 'activating', 'activation', 'get started', 'plan', 'unlock', 'license key', 'licence key', 'where do i start'],
      answer: 'Download NexaPOS from the Get NexaPOS section on this page (Windows or Android). On an iPhone, iPad or Mac, tap Open NexaPOS in Safari and use Add to Home Screen.\n\nWhen you open the app you land on an activation screen: choose a plan and pay there by card or M-Pesa, and it unlocks by itself. After that it works fully offline.\n\nPrefer to pay another way? Message us on WhatsApp and we will send you a license key to enter.'
    },
    {
      id: 'license', title: 'License, payment & new phone',
      words: ['license', 'licence', 'paid', 'pay', 'paying', 'payment', 'mpesa', 'm-pesa', 'card', 'renew', 'expired', 'expire', 'restore', 'new phone', 'changed phone', 'reinstall', 'reinstalled', 'reinstalling', 'not activated', 'activation failed'],
      answer: 'After you pay in the app it activates by itself. Keep the device online for a minute and reopen the app.\n\nReinstalled the app or changed phone? On the activation screen tap "Already paid? Restore my license" and use the email you paid with.\n\nSettings > My License shows your plan and this device.'
    },
    {
      id: 'win7', title: 'Windows 7 / 8 / old PC',
      words: ['windows 7', 'windows 8', 'win7', 'win 7', 'win8', 'old pc', 'old computer', '32-bit', '32 bit', '64-bit', '64 bit', 'windows7'],
      answer: 'NexaPOS has its own installer for Windows 7, 8 and 8.1 (64-bit). After you register on this page choose "Windows 7 / 8 / 8.1 (64-bit)" in the download list.\n\nOn 32-bit Windows 7 or 8 choose the 32-bit option: a small setup that opens NexaPOS in a browser already on the PC.\n\nWindows 10 and 11 use the standard installer.'
    },
    {
      id: 'printing', title: 'Receipt printing',
      words: ['print', 'printer', 'printing', 'printed', 'receipt', 'thermal', 'paper', '58mm', '80mm', 'not printing', 'usb printer'],
      answer: 'Open Settings > Business, Receipts & Themes > Thermal printer, then:\n- Network (IP address): for a printer with its own Wi-Fi/Ethernet IP on port 9100. Tap "Find network printers" to search.\n- Windows printer (USB or shared): for a printer plugged into a PC. It must print a Windows test page first, then Refresh Windows printers and pick it.\n\nTap Save printer, then Test print. Paper is 58 mm or 80 mm. A web browser cannot print silently, so the browser version shows its own print window.'
    },
    {
      id: 'sync', title: 'More than one device',
      words: ['sync', 'syncing', 'synced', 'second phone', 'another phone', 'another device', 'two devices', 'multiple', 'invite', 'invite code', 'join', 'till', 'tills', 'branch', 'share data', 'not syncing'],
      answer: 'Every device in a shop shares products, stock and sales.\n\n1. On your main device open Settings > Sync & Invites and tap Invite a device. You get a one-time invite code that expires in about 15 minutes.\n2. On the new device choose "Join an existing shop" and enter the code.\n\nInstalled apps on the same Wi-Fi sync within seconds; other devices sync whenever they are online.'
    },
    {
      id: 'browser', title: 'Browser version asks me to activate',
      words: ['browser', 'cleared', 'clear browsing', 'cleared data', 'logged out', 'safari', 'chrome', 'home screen', 'web version', 'iphone', 'ipad', 'mac'],
      answer: 'The browser version keeps its data in the browser. If you clear browsing data, or open it in another browser, it shows the activation screen again - that is only the browser forgetting.\n\nIf the browser was an extra till, your shop\'s data is safe on your main device. Create a fresh invite there (Settings > Sync & Invites > Invite a device) and in the browser choose "Join an existing shop". Or tap "Already paid? Restore my license" and use the email you paid with.\n\nIf the browser was the only place you used NexaPOS, do not clear its data again and tell an agent.'
    },
    {
      id: 'backup', title: 'Backup & lost data',
      words: ['backup', 'backed up', 'back up', 'lost', 'deleted', 'recover', 'google drive', 'drive', 'phone broke', 'stolen', 'missing data', 'missing sales'],
      answer: 'Your data lives on your device and is copied to your other devices when they sync, so keep a second device joined to the shop as protection.\n\nSettings > Backup & Restore makes a backup, and Google Drive backup can be switched on there on Windows and Android.\n\nBefore you uninstall or clear any data, check that a backup or a synced second device exists.'
    },
    {
      id: 'update', title: 'Update the app',
      words: ['update', 'updating', 'updated', 'upgrade', 'new version', 'latest version', 'version'],
      answer: 'Open Settings > Software update to check for a new version. Windows and Android installers are on this page. The browser version updates itself when you reload and shows an update banner.\n\nUpdating keeps your data.'
    },
    {
      id: 'login', title: 'Forgot password / locked out',
      words: ['password', 'passwords', 'forgot', 'forgotten', 'login', 'log in', 'sign in', 'locked', 'pin', 'otp', 'authenticator', '2fa', 'cannot sign in'],
      answer: 'Passwords stay on your shop\'s devices - we cannot see or reset them from here.\n\nIf you are a cashier, ask your shop\'s admin to reset your password in Users. If you are the owner and locked out, choose "No" below and tell an agent - we will help you get back in.'
    }
  ];

  function matchTopic(text) {
    var query = ' ' + String(text).toLowerCase().replace(/[^a-z0-9\- ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
    var best = null;
    var bestScore = 0;
    TOPICS.forEach(function (topic) {
      var score = 0;
      topic.words.forEach(function (word) {
        // Whole words only ("conversation" must not count as "version"), plural allowed.
        if (query.indexOf(' ' + word + ' ') !== -1 || query.indexOf(' ' + word + 's ') !== -1) score += word.indexOf(' ') !== -1 ? 2 : 1;
      });
      if (score > bestScore) { best = topic; bestScore = score; }
    });
    return best;
  }

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
    mode: 'bot',            // 'bot' or 'form' while there is no chat yet
    open: false,
    status: 'open',
    messages: [],
    sending: false,
    pendingText: '',
    pendingPhotos: 0,
    online: true,
    signature: '',
    pollTimer: null,
    pollBusy: false,
    failures: 0,
    botLog: []
  };
  function persist() {
    save({ ticketId: state.ticketId, token: state.token, name: state.name, email: state.email, lastSeen: state.lastSeen });
  }
  function hasChat() { return state.ticketId > 0 && state.token !== ''; }

  // ---------------------------------------------------------------- styles
  var css = [
    '.nxc{--nxc-me:#0078fe;--nxc-them:#e9e9eb;--nxc-them-ink:#14141f;--nxc-bg:#fff;--nxc-ink:#14141f;--nxc-soft:#6b6b80;--nxc-line:#e6e6f0;--nxc-field:#f4f4f8;--nxc-err:#b91c1c;font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--nxc-ink)}',
    '@media (prefers-color-scheme:dark){.nxc{--nxc-them:#2b2d3a;--nxc-them-ink:#eef0fb;--nxc-bg:#161826;--nxc-ink:#eef0fb;--nxc-soft:#9aa0b4;--nxc-line:rgba(255,255,255,.1);--nxc-field:#0f1019;--nxc-err:#fca5a5}}',
    '.nxc *{box-sizing:border-box}',
    '.nxc-fab{position:fixed;right:24px;bottom:96px;width:58px;height:58px;border:0;border-radius:50%;background:var(--nxc-me);color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;z-index:100;transition:transform .15s ease}',
    '.nxc-fab:hover{transform:scale(1.08)}.nxc-fab:focus-visible,.nxc button:focus-visible,.nxc input:focus-visible,.nxc textarea:focus-visible{outline:3px solid color-mix(in srgb,var(--nxc-me) 55%,transparent);outline-offset:2px}',
    '.nxc-fab svg{width:28px;height:28px;fill:#fff}',
    '.nxc-badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#e11d48;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid var(--nxc-bg)}',
    '.nxc-badge[hidden]{display:none}',
    '.nxc-panel{position:fixed;right:24px;bottom:96px;width:372px;max-width:calc(100vw - 16px);height:min(600px,calc(100vh - 120px));height:min(600px,calc(100dvh - 120px));display:none;flex-direction:column;background:var(--nxc-bg);border:1px solid var(--nxc-line);border-radius:18px;box-shadow:0 24px 60px -16px rgba(15,23,42,.45);overflow:hidden;z-index:110}',
    '.nxc-panel.open{display:flex}',
    '.nxc-head{display:flex;align-items:center;gap:10px;padding:12px 12px 12px 16px;background:var(--nxc-me);color:#fff;flex:none}',
    '.nxc-head .nxc-title{flex:1;min-width:0}.nxc-head b{display:block;font-size:15px}.nxc-head small{display:block;opacity:.88;font-size:12px}',
    '.nxc-head button{border:0;background:rgba(255,255,255,.18);color:#fff;border-radius:50%;width:34px;height:34px;cursor:pointer;font-size:18px;line-height:1;display:flex;align-items:center;justify-content:center}',
    '.nxc-head button:hover{background:rgba(255,255,255,.3)}.nxc-head button[hidden]{display:none}',
    '.nxc-confirm{display:none;padding:10px 14px;background:var(--nxc-field);border-bottom:1px solid var(--nxc-line);font-size:13px;flex:none}',
    '.nxc-confirm.show{display:block}.nxc-confirm .nxc-row{display:flex;gap:8px;margin-top:8px}',
    '.nxc-btn{border:0;border-radius:10px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer;background:var(--nxc-me);color:#fff}',
    '.nxc-btn.ghost{background:transparent;color:var(--nxc-ink);border:1px solid var(--nxc-line)}.nxc-btn:disabled{opacity:.55;cursor:default}',
    '.nxc-form{flex:1;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}',
    '.nxc-form>*{flex:none}',
    '.nxc-form p{margin:0;color:var(--nxc-soft)}',
    '.nxc-form label{display:block;font-weight:600;font-size:13px;margin:0 0 4px;color:var(--nxc-ink)}',
    '.nxc-form .nxc-hint{font-weight:400;color:var(--nxc-soft);font-size:12px;margin-top:3px}',
    '.nxc input[type=text],.nxc input[type=email],.nxc textarea{display:block;margin:0;width:100%;box-shadow:none;border:1px solid var(--nxc-line);background:var(--nxc-field);color:var(--nxc-ink);border-radius:10px;padding:10px 12px;font:inherit}',
    '.nxc textarea{resize:vertical}',
    '.nxc-trap{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}',
    '.nxc-error{color:var(--nxc-err);font-size:13px;line-height:1.4;overflow-wrap:anywhere}.nxc-error:empty{display:none}',
    '.nxc-legal{font-size:12px;color:var(--nxc-soft)}',
    '.nxc-link{border:0;background:none;color:var(--nxc-me);font:inherit;font-size:13px;cursor:pointer;padding:0;text-align:left}',
    '.nxc-view{flex:1;display:none;flex-direction:column;min-height:0}.nxc-view.show{display:flex}',
    '.nxc-log{flex:1;min-height:0;overflow-y:auto;padding:12px 12px 4px;display:flex;flex-direction:column;gap:3px;overscroll-behavior:contain}',
    '.nxc-log>*{flex:none}',
    '.nxc-time{align-self:center;color:var(--nxc-soft);font-size:11px;margin:8px 0 4px}',
    '.nxc-msg{max-width:82%;position:relative;display:flex;flex-direction:column}',
    '.nxc-msg.me{align-self:flex-end;align-items:flex-end}.nxc-msg.them{align-self:flex-start;align-items:flex-start}',
    '.nxc-bubble{padding:8px 12px;border-radius:18px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}',
    '.nxc-msg.me .nxc-bubble{background:var(--nxc-me);color:#fff;border-bottom-right-radius:5px}',
    '.nxc-msg.them .nxc-bubble{background:var(--nxc-them);color:var(--nxc-them-ink);border-bottom-left-radius:5px}',
    '.nxc-msg.pending .nxc-bubble{opacity:.6}',
    '.nxc-msg.bot{max-width:92%}.nxc-msg.bot .nxc-who{font-size:11px;color:var(--nxc-soft);margin:6px 6px 2px}',
    '.nxc-chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px}',
    '.nxc-chip{border:1px solid var(--nxc-me);background:transparent;color:var(--nxc-me);border-radius:16px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}',
    '.nxc-chip:hover{background:color-mix(in srgb,var(--nxc-me) 12%,transparent)}',
    '.nxc-chip.solid{background:var(--nxc-me);color:#fff}.nxc-chip.quiet{border-color:var(--nxc-line);color:var(--nxc-ink)}',
    '.nxc-quote{font-size:12px;color:var(--nxc-soft);border-left:3px solid var(--nxc-line);padding:1px 8px;margin:0 4px 3px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.nxc-react{position:absolute;bottom:-9px;background:var(--nxc-bg);border:1px solid var(--nxc-line);border-radius:12px;padding:0 5px;font-size:13px;line-height:20px}',
    '.nxc-msg.me .nxc-react{left:-6px}.nxc-msg.them .nxc-react{right:-6px}.nxc-msg.has-react{margin-bottom:9px}',
    '.nxc-photo{display:block;max-width:100%;max-height:220px;min-width:48px;min-height:48px;object-fit:cover;border-radius:14px;margin-bottom:3px;cursor:zoom-in;background:var(--nxc-field)}',
    '.nxc-sub{font-size:11px;color:var(--nxc-soft);margin:2px 6px 0}',
    '.nxc-note{margin:6px 12px;padding:8px 10px;border-radius:10px;background:var(--nxc-field);color:var(--nxc-soft);font-size:12px;flex:none}',
    '.nxc-note[hidden]{display:none}',
    '.nxc-strip{display:flex;gap:8px;flex-wrap:wrap;padding:0 12px 6px;flex:none}.nxc-strip[hidden]{display:none}',
    '.nxc-form .nxc-strip{padding:0}',
    '.nxc-thumb{position:relative;width:54px;height:54px}.nxc-thumb img{width:54px;height:54px;object-fit:cover;border-radius:10px;border:1px solid var(--nxc-line)}',
    '.nxc-thumb button{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:0;background:#14141f;color:#fff;font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}',
    '.nxc-compose{display:flex;align-items:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--nxc-line);flex:none}',
    '.nxc-compose textarea{flex:1;resize:none;max-height:110px;border-radius:18px;padding:9px 14px}',
    '.nxc-send,.nxc-attach{width:38px;height:38px;border:0;border-radius:50%;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none}',
    '.nxc-send{background:var(--nxc-me)}.nxc-attach{background:var(--nxc-field);color:var(--nxc-soft);border:1px solid var(--nxc-line)}',
    '.nxc-send:disabled{opacity:.4;cursor:default}.nxc-send svg{width:18px;height:18px;fill:#fff}.nxc-attach svg{width:20px;height:20px;fill:currentColor}',
    '.nxc-attach-row{display:flex;align-items:center;gap:8px}.nxc-attach-row .nxc-hint{margin:0}',
    '.nxc-foot{padding:0 14px 10px;font-size:11px;color:var(--nxc-soft);flex:none}',
    '.nxc-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;z-index:120;padding:16px;cursor:zoom-out}',
    '.nxc-lightbox.show{display:flex}.nxc-lightbox img{max-width:100%;max-height:100%;border-radius:8px}',
    '.nxc-panel.drop{outline:3px dashed var(--nxc-me);outline-offset:-6px}',
    '@media (max-width:600px){.nxc-panel{right:auto;bottom:auto;left:0;left:var(--nxc-view-left,0px);top:0;top:var(--nxc-view-top,0px);width:100vw;width:var(--nxc-view-width,100vw);max-width:none;height:100vh;height:100dvh;height:var(--nxc-view-height,100dvh);border:0;border-radius:0}.nxc-head{padding-top:calc(12px + env(safe-area-inset-top))}.nxc-compose{padding-bottom:calc(10px + env(safe-area-inset-bottom))}.nxc-foot{padding-bottom:calc(10px + env(safe-area-inset-bottom))}.nxc input[type=text],.nxc input[type=email],.nxc textarea{font-size:16px}}',
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
  var ICON_PHOTO = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/></svg>';

  // ---------------------------------------------------------------- photos to send
  // A tray holds the photos chosen for the next message. Each one is shrunk in the browser
  // (longest side 1600 px, JPEG) so a phone camera photo stays well inside the server's limits.
  function readBlob(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.onerror = function () { reject(new Error('That photo could not be read.')); };
      reader.readAsDataURL(blob);
    });
  }

  function shrinkPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type || '')) { reject(new Error('Only photos can be attached.')); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That photo could not be read. Try a JPEG or PNG.'));
      };
      img.onload = function () {
        URL.revokeObjectURL(url);
        var fit = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight, 1));
        var attempts = [[1, 0.85], [1, 0.7], [0.75, 0.7], [0.5, 0.6]];
        (function next(i) {
          var step = attempts[i];
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * fit * step[0]));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * fit * step[0]));
          var context = canvas.getContext('2d');
          context.fillStyle = '#fff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) {
            if (!blob) { reject(new Error('That photo could not be prepared.')); return; }
            if (blob.size > MAX_PHOTO_BYTES && i < attempts.length - 1) { next(i + 1); return; }
            if (blob.size > MAX_PHOTO_BYTES) { reject(new Error('That photo is too large.')); return; }
            resolve(blob);
          }, 'image/jpeg', step[1]);
        })(0);
      };
      img.src = url;
    });
  }

  function makeTray(strip, onChange, onProblem) {
    var items = [];
    function total() { return items.reduce(function (sum, item) { return sum + item.bytes; }, 0); }
    function render() {
      strip.textContent = '';
      items.forEach(function (item, index) {
        strip.appendChild(h('div', { class: 'nxc-thumb' }, [
          h('img', { src: item.url, alt: 'Photo ' + (index + 1) + ' to send' }),
          h('button', { type: 'button', 'aria-label': 'Remove photo ' + (index + 1), text: '×', onclick: function () { remove(index); } })
        ]));
      });
      strip.hidden = items.length === 0;
      onChange();
    }
    function remove(index) {
      URL.revokeObjectURL(items[index].url);
      items.splice(index, 1);
      render();
    }
    function add(files) {
      var list = Array.prototype.slice.call(files || []).filter(function (file) { return /^image\//.test(file.type || ''); });
      if (list.length === 0) { onProblem('Only photos can be attached.'); return Promise.resolve(); }
      return list.reduce(function (chain, file) {
        return chain.then(function () {
          if (items.length >= MAX_PHOTOS) { onProblem('You can attach up to ' + MAX_PHOTOS + ' photos to one message.'); return; }
          return shrinkPhoto(file).then(function (blob) {
            if (total() + blob.size > MAX_TOTAL_BYTES) { onProblem('Those photos are too large together. Send fewer, or send them in two messages.'); return; }
            return readBlob(blob).then(function (data) {
              items.push({ data: data, bytes: blob.size, url: URL.createObjectURL(blob) });
              render();
            });
          }).catch(function (error) { onProblem(error.message || 'That photo could not be attached.'); });
        });
      }, Promise.resolve());
    }
    function clear() {
      items.forEach(function (item) { URL.revokeObjectURL(item.url); });
      items = [];
      render();
    }
    return {
      add: add,
      clear: clear,
      count: function () { return items.length; },
      payload: function () { return items.map(function (item) { return { data: item.data }; }); }
    };
  }

  // ---------------------------------------------------------------- the page elements
  var root = h('div', { class: 'nxc' });
  var styleTag = h('style', { text: css });

  var fab = h('button', { class: 'nxc-fab', type: 'button', 'aria-label': 'Chat with NexaPOS support', title: 'Chat with support', onclick: function () { setOpen(true); } });
  fab.innerHTML = ICON_CHAT;
  var badge = h('span', { class: 'nxc-badge', hidden: true, 'aria-hidden': 'true' });
  fab.appendChild(badge);

  var newBtn = h('button', { type: 'button', 'aria-label': 'Start a new chat', title: 'New chat', text: '+', hidden: true, onclick: function () { confirmBox.classList.add('show'); } });
  var closeBtn = h('button', { type: 'button', 'aria-label': 'Close chat', title: 'Close', text: '×', onclick: function () { setOpen(false); } });
  var subtitle = h('small', { text: 'Quick answers, or a person' });
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

  // Step 1: the assistant.
  var botLogEl = h('div', { class: 'nxc-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Quick answers' });
  var botInput = h('textarea', { rows: '1', maxlength: '300', 'aria-label': 'Type your question', placeholder: 'Type your question', onkeydown: onBotKey, oninput: function () { grow(botInput); botSend.disabled = botInput.value.trim() === ''; } });
  var botSend = h('button', { class: 'nxc-send', type: 'submit', 'aria-label': 'Ask', disabled: true });
  botSend.innerHTML = ICON_SEND;
  var botView = h('div', { class: 'nxc-view' }, [
    botLogEl,
    h('form', { class: 'nxc-compose', onsubmit: onBotAsk }, [botInput, botSend])
  ]);

  // Step 2: where should the agent's reply go.
  var nameInput = h('input', { type: 'text', id: 'nxc-name', maxlength: '80', autocomplete: 'name', placeholder: 'Your name (optional)' });
  var emailInput = h('input', { type: 'email', id: 'nxc-email', required: true, maxlength: '254', autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com', 'aria-describedby': 'nxc-email-hint' });
  var firstInput = h('textarea', { id: 'nxc-first', rows: '3', maxlength: String(MAX_LENGTH), placeholder: 'How can we help?', onpaste: function (event) { pasteInto(event, firstTray); } });
  var trapInput = h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  var formError = h('div', { class: 'nxc-error', role: 'alert' });
  var startBtn = h('button', { class: 'nxc-btn', type: 'submit', text: 'Start chat' });
  var formIntro = h('p', { text: 'An agent will respond to you shortly. Tell us where to send the reply - every reply is also emailed to you.' });
  var firstStrip = h('div', { class: 'nxc-strip', hidden: true });
  var firstFile = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, 'aria-label': 'Choose photos', onchange: function () { firstTray.add(firstFile.files).then(function () { firstFile.value = ''; }); } });
  var firstAttach = h('button', { class: 'nxc-attach', type: 'button', 'aria-label': 'Attach photos', title: 'Attach photos', onclick: function () { firstFile.click(); } });
  firstAttach.innerHTML = ICON_PHOTO;
  var firstTray = makeTray(firstStrip, function () {}, function (text) { showFormError(text); });
  var form = h('form', { class: 'nxc-form', novalidate: true, onsubmit: onStart }, [
    formIntro,
    h('div', {}, [h('label', { for: 'nxc-name', text: 'Name' }), nameInput]),
    h('div', {}, [
      h('label', { for: 'nxc-email', text: 'Email address (required)' }), emailInput,
      h('div', { class: 'nxc-hint', id: 'nxc-email-hint', text: 'We email you a copy of every reply.' })
    ]),
    h('div', {}, [h('label', { for: 'nxc-first', text: 'Message' }), firstInput]),
    h('div', { class: 'nxc-attach-row' }, [firstAttach, h('span', { class: 'nxc-hint', text: 'Add photos (optional)' }), firstFile]),
    firstStrip,
    h('div', { class: 'nxc-trap', 'aria-hidden': 'true' }, [h('label', { text: 'Leave this empty' }), trapInput]),
    formError,
    startBtn,
    h('button', { class: 'nxc-link', type: 'button', text: '← Back to quick answers', onclick: function () { state.botLog = []; state.mode = 'bot'; showView(); if (!smallScreen()) botInput.focus(); } }),
    h('div', { class: 'nxc-legal' }, ['By starting a chat you agree that we store your message, photos and email address to answer you. See our ',
      h('a', { href: 'privacy.html', text: 'Privacy Policy' }), '.'])
  ]);

  // Step 3: the conversation with support.
  var log = h('div', { class: 'nxc-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation with NexaPOS support' });
  var note = h('div', { class: 'nxc-note', hidden: true });
  var sendError = h('div', { class: 'nxc-error', role: 'alert', style: 'padding:0 14px' });
  var composer = h('textarea', { rows: '1', maxlength: String(MAX_LENGTH), 'aria-label': 'Write a message', placeholder: 'Write a message', onkeydown: onComposerKey, oninput: onComposerInput, onpaste: function (event) { pasteInto(event, composeTray); } });
  var sendBtn = h('button', { class: 'nxc-send', type: 'submit', 'aria-label': 'Send', disabled: true });
  sendBtn.innerHTML = ICON_SEND;
  var composeStrip = h('div', { class: 'nxc-strip', hidden: true });
  var composeFile = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, 'aria-label': 'Choose photos', onchange: function () { composeTray.add(composeFile.files).then(function () { composeFile.value = ''; }); } });
  var composeAttach = h('button', { class: 'nxc-attach', type: 'button', 'aria-label': 'Attach photos', title: 'Attach photos', onclick: function () { composeFile.click(); } });
  composeAttach.innerHTML = ICON_PHOTO;
  var composeTray = makeTray(composeStrip, function () { onComposerInput(); }, function (text) { sendError.textContent = text; });
  var footNote = h('div', { class: 'nxc-foot' });
  var chat = h('div', { class: 'nxc-view' }, [
    log, note, sendError, composeStrip,
    h('form', { class: 'nxc-compose', onsubmit: onSend }, [composeAttach, composeFile, composer, sendBtn]),
    footNote
  ]);

  var lightboxImg = h('img', { alt: 'Photo' });
  var lightbox = h('div', { class: 'nxc-lightbox', onclick: function () { lightbox.classList.remove('show'); } }, [lightboxImg]);

  var panel = h('section', { class: 'nxc-panel', role: 'dialog', 'aria-label': 'NexaPOS support chat' }, [head, confirmBox, botView, form, chat]);
  root.appendChild(fab);
  root.appendChild(panel);
  root.appendChild(lightbox);

  function grow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 110) + 'px';
  }

  function pasteInto(event, tray) {
    var files = event.clipboardData && event.clipboardData.files ? event.clipboardData.files : [];
    var pictures = Array.prototype.filter.call(files, function (file) { return /^image\//.test(file.type || ''); });
    if (pictures.length === 0) return;
    event.preventDefault();
    tray.add(pictures);
  }

  // Photos can also be dropped anywhere on the window while the form or the chat is showing.
  function takesPhotos() { return hasChat() || state.mode === 'form'; }
  panel.addEventListener('dragover', function (event) {
    if (!takesPhotos()) return;
    if (event.dataTransfer && Array.prototype.indexOf.call(event.dataTransfer.types || [], 'Files') !== -1) {
      event.preventDefault();
      panel.classList.add('drop');
    }
  });
  panel.addEventListener('dragleave', function () { panel.classList.remove('drop'); });
  panel.addEventListener('drop', function (event) {
    panel.classList.remove('drop');
    if (!takesPhotos()) return;
    if (!event.dataTransfer || !event.dataTransfer.files || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    (hasChat() ? composeTray : firstTray).add(event.dataTransfer.files);
  });

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

  // ---------------------------------------------------------------- the assistant
  function botSay(text, controls) { state.botLog.push({ from: 'bot', text: text, controls: controls || null }); renderBot(); }
  function botHear(text) { state.botLog.push({ from: 'me', text: text }); renderBot(); }

  function topicChips() {
    var chips = TOPICS.map(function (topic) { return { label: topic.title, run: function () { askTopic(topic); } }; });
    chips.push({ label: 'Talk to a person', kind: 'solid', run: function () { toAgent('', ''); } });
    return chips;
  }

  function greet() {
    state.botLog = [];
    botSay('Hi! I\'m the NexaPOS assistant. Pick a topic for a quick answer, or type your question below. You can also talk to a person at any time.', topicChips());
  }

  function askTopic(topic) {
    botHear(topic.title);
    answer(topic, '');
  }

  // The answer, then "Did this help you?": yes ends here, no hands over to an agent.
  function answer(topic, typed) {
    setTimeout(function () {
      botSay(topic.answer);
      setTimeout(function () {
        botSay('Did this help you?', [
          { label: 'Yes, thanks', kind: 'solid', run: function () { helped(); } },
          { label: 'No, I need an agent', kind: 'quiet', run: function () { notHelped(topic, typed); } }
        ]);
      }, 350);
    }, 350);
  }

  function helped() {
    botHear('Yes, thanks');
    setTimeout(function () {
      botSay('Great, glad that helped! If anything else comes up, pick a topic or type your question.', topicChips());
    }, 300);
  }

  function notHelped(topic, typed) {
    botHear('No, I need an agent');
    setTimeout(function () {
      botSay('Sorry about that. An agent will respond to you shortly - tell us where to send the reply and we will pass this on.');
      setTimeout(function () { toAgent(topic.title, typed); }, 900);
    }, 300);
  }

  function onBotAsk(event) {
    event.preventDefault();
    var text = botInput.value.trim();
    if (!text) return;
    botInput.value = '';
    grow(botInput);
    botSend.disabled = true;
    botHear(text);
    var topic = matchTopic(text);
    if (topic) { answer(topic, text); return; }
    setTimeout(function () {
      botSay('I do not have a quick answer for that, so I will bring in a person. An agent will respond to you shortly - tell us where to send the reply.');
      setTimeout(function () { toAgent('', text); }, 900);
    }, 350);
  }
  function onBotKey(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!botSend.disabled) onBotAsk(event);
    }
  }

  // Hands the visitor on to the agent form, with what they asked already in the message box.
  function toAgent(topicTitle, typed) {
    var lines = [];
    if (typed) lines.push(typed);
    if (topicTitle) lines.push('(I read the quick answer "' + topicTitle + '" but it did not solve this.)');
    if (lines.length) firstInput.value = lines.join('\n');
    state.mode = 'form';
    showView();
    if (!smallScreen()) (emailInput.value ? firstInput : emailInput).focus();
  }

  function renderBot() {
    botLogEl.textContent = '';
    state.botLog.forEach(function (entry, index) {
      var last = index === state.botLog.length - 1;
      var box = h('div', { class: 'nxc-msg ' + (entry.from === 'me' ? 'me' : 'them bot') }, [
        entry.from === 'bot' ? h('div', { class: 'nxc-who', text: 'NexaPOS assistant' }) : null,
        h('div', { class: 'nxc-bubble', text: entry.text })
      ]);
      botLogEl.appendChild(box);
      if (last && entry.controls) {
        var chips = h('div', { class: 'nxc-chips' });
        entry.controls.forEach(function (control) {
          chips.appendChild(h('button', {
            class: 'nxc-chip' + (control.kind ? ' ' + control.kind : ''), type: 'button', text: control.label,
            onclick: function () { entry.controls = null; control.run(); }
          }));
        });
        botLogEl.appendChild(chips);
      }
    });
    botLogEl.scrollTop = botLogEl.scrollHeight;
  }

  // ---------------------------------------------------------------- rendering the conversation
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
    var signature = JSON.stringify([state.messages, state.sending, state.pendingPhotos, state.status, Object.keys(photoUrls).length]);
    if (signature === state.signature) return;
    state.signature = signature;
    var stick = nearBottom() || log.childNodes.length === 0;
    log.textContent = '';
    var lastTime = 0;
    var lastOwnIndex = -1;
    var heardFromSupport = false;
    state.messages.forEach(function (m, index) {
      if (m.sender === 'customer') lastOwnIndex = index; else heardFromSupport = true;
    });
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
        var img = h('img', { class: 'nxc-photo', alt: mine ? 'Your photo' : 'Photo from support', onclick: function () { if (img.src) { lightboxImg.src = img.src; lightbox.classList.add('show'); } } });
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
    if (state.sending && (state.pendingText || state.pendingPhotos)) {
      var pending = h('div', { class: 'nxc-msg me pending' }, [
        state.pendingPhotos ? h('div', { class: 'nxc-bubble', text: '📷 ' + state.pendingPhotos + (state.pendingPhotos === 1 ? ' photo' : ' photos') }) : null,
        state.pendingText ? h('div', { class: 'nxc-bubble', text: state.pendingText }) : null,
        h('div', { class: 'nxc-sub', text: 'Sending…' })
      ]);
      log.appendChild(pending);
    }
    if (!heardFromSupport && state.messages.length > 0 && state.status !== 'closed') {
      log.appendChild(h('div', { class: 'nxc-msg them bot' }, [
        h('div', { class: 'nxc-who', text: 'NexaPOS assistant' }),
        h('div', { class: 'nxc-bubble', text: 'Thanks! An agent will respond to you shortly. We also email you a copy of every reply.' })
      ]));
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
    var mode = chatting ? 'chat' : state.mode;
    botView.classList.toggle('show', mode === 'bot');
    chat.classList.toggle('show', mode === 'chat');
    form.style.display = mode === 'form' ? '' : 'none';
    newBtn.hidden = !chatting;
    confirmBox.classList.remove('show');
    subtitle.textContent = chatting ? 'We reply here and by email' : (mode === 'form' ? 'An agent will reply here and by email' : 'Quick answers, or a person');
    if (mode === 'bot' && state.botLog.length === 0) greet();
    if (mode === 'bot') renderBot();
    if (chatting) renderStatus();
  }

  // ---------------------------------------------------------------- opening, polling
  function smallScreen() { return window.matchMedia && window.matchMedia('(max-width:600px)').matches; }

  function updateViewport() {
    if (!window.visualViewport) return;
    var viewport = window.visualViewport;
    root.style.setProperty('--nxc-view-left', viewport.offsetLeft + 'px');
    root.style.setProperty('--nxc-view-top', viewport.offsetTop + 'px');
    root.style.setProperty('--nxc-view-width', viewport.width + 'px');
    root.style.setProperty('--nxc-view-height', viewport.height + 'px');
  }

  function setOpen(open) {
    updateViewport();
    state.open = open;
    panel.classList.toggle('open', open);
    fab.style.display = open ? 'none' : 'flex';
    showView();
    if (open && !smallScreen()) {
      if (hasChat()) {
        composer.focus();
      } else if (state.mode === 'form') {
        (emailInput.value ? firstInput : emailInput).focus();
      } else {
        botInput.focus();
      }
    }
    if (open && hasChat()) poll(true);
    if (!open) {
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

  // The chat no longer exists on the server (for instance it was deleted): back to the form, with a note.
  function chatGone() {
    clearTimeout(state.pollTimer);
    state.ticketId = 0; state.token = ''; state.messages = []; state.signature = ''; state.lastSeen = 0;
    persist();
    emailInput.value = state.email;
    nameInput.value = state.name;
    state.mode = 'form';
    showView();
    showFormError('That chat is no longer available. You can start a new one.');
    updateBadge();
  }

  function resetChat() {
    clearTimeout(state.pollTimer);
    state.ticketId = 0; state.token = ''; state.messages = []; state.signature = ''; state.lastSeen = 0; state.status = 'open';
    persist();
    log.textContent = '';
    emailInput.value = state.email;
    nameInput.value = state.name;
    firstInput.value = '';
    firstTray.clear();
    composeTray.clear();
    formError.textContent = '';
    state.mode = 'bot';
    state.botLog = [];
    showView();
    updateBadge();
    if (!smallScreen()) botInput.focus();
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
    if (text && formError.scrollIntoView) formError.scrollIntoView({ block: 'nearest' });
  }

  function onStart(event) {
    event.preventDefault();
    var email = emailInput.value.trim();
    var message = firstInput.value.trim();
    var photos = firstTray.count();
    formError.textContent = '';
    if (!EMAIL_PATTERN.test(email)) { showFormError('Enter your email address - we send a copy of every reply there.'); emailInput.focus(); return; }
    if (message.length < 2 && photos === 0) { showFormError('Write your message first.'); firstInput.focus(); return; }
    primeSound();
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    request('web_chat_start', { body: { name: nameInput.value.trim(), email: email, message: message, attachments: firstTray.payload(), website: trapInput.value } }).then(function (res) {
      if (res.status === 201 && res.data && res.data.success && res.data.ticket_id > 0) {
        state.ticketId = res.data.ticket_id;
        state.token = res.data.token;
        state.email = email;
        state.name = nameInput.value.trim();
        state.lastSeen = 0;
        state.messages = []; state.signature = ''; state.status = 'open';
        persist();
        firstInput.value = '';
        firstTray.clear();
        playSent();
        showView();
        if (!smallScreen()) composer.focus();
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
    grow(composer);
    sendBtn.disabled = state.sending || (composer.value.trim() === '' && composeTray.count() === 0);
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
    var photos = composeTray.count();
    if ((!text && photos === 0) || state.sending || !hasChat()) return;
    primeSound();
    state.sending = true;
    state.pendingText = text;
    state.pendingPhotos = photos;
    var attachments = composeTray.payload();
    sendBtn.disabled = true;
    sendError.textContent = '';
    renderMessages();
    request('web_chat_send', { token: state.token, body: { ticket_id: state.ticketId, message: text, attachments: attachments } }).then(function (res) {
      if (res.status === 404) { chatGone(); return; }
      if (res.data && res.data.success) {
        composer.value = '';
        composeTray.clear();
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
      state.pendingPhotos = 0;
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
    updateViewport();
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewport);
      window.visualViewport.addEventListener('scroll', updateViewport);
    }
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
