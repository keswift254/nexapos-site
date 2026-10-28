const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const widget = fs.readFileSync(path.join(__dirname, '..', 'chat.js'), 'utf8');

function page(mobile) {
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.handlers = {};
      this.attributes = {};
      this.styles = {};
      this.style = { setProperty: (key, value) => { this.styles[key] = value; } };
      this.classes = new Set();
      this.classList = {
        add: name => this.classes.add(name),
        remove: name => this.classes.delete(name),
        contains: name => this.classes.has(name),
        toggle: (name, enabled) => {
          if (enabled) this.classes.add(name);
          else this.classes.delete(name);
        }
      };
      this.value = '';
      this.focusCount = 0;
      this.scrollHeight = 0;
      this.scrollTop = 0;
      this.clientHeight = 0;
      this._text = '';
    }
    set className(value) { this.classes = new Set(value.split(/\s+/)); }
    get className() { return [...this.classes].join(' '); }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(key, handler) { this.handlers[key] = handler; }
    click() { if (this.handlers.click) this.handlers.click({ preventDefault() {} }); }
    focus() { this.focusCount++; }
  }

  const viewport = {
    offsetLeft: 0, offsetTop: 0, width: 390, height: 640,
    handlers: {},
    addEventListener(key, handler) { this.handlers[key] = handler; }
  };
  const document = {
    currentScript: { getAttribute: () => null, src: 'https://nexapos.cc/chat.js' },
    head: new Element('head'), body: new Element('body'),
    createElement: tag => new Element(tag),
    createTextNode: value => ({ textContent: value }),
    addEventListener() {}
  };
  const window = {
    visualViewport: viewport,
    matchMedia: () => ({ matches: mobile }),
    localStorage: { getItem: () => null, setItem() {} }
  };
  vm.runInNewContext(widget, {
    document, window, setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    URL, console
  });
  function find(predicate, node = document.body) {
    if (predicate(node)) return node;
    for (const child of node.children || []) {
      const result = find(predicate, child);
      if (result) return result;
    }
    return null;
  }
  function button(text) { return find(node => node.tagName === 'button' && node.textContent === text); }
  return { window, viewport, find, button };
}

test('returning from the agent form restores quick-answer topics', () => {
  const app = page(true);
  app.window.NexaposChat.open();
  app.button('Receipt printing').click();
  app.button('No, I need an agent').click();
  assert.equal(app.find(node => node.tagName === 'form' && node.classes.has('nxc-form')).style.display, '');
  app.button('← Back to quick answers').click();
  assert.ok(app.button('Receipt printing'));
  assert.ok(app.button('Talk to a person'));
  assert.equal(app.find(node => node.tagName === 'form' && node.classes.has('nxc-form')).style.display, 'none');
});

test('mobile support opens without forcing the keyboard and tracks the visible viewport', () => {
  const app = page(true);
  app.window.NexaposChat.open();
  const input = app.find(node => node.attributes['aria-label'] === 'Type your question');
  const root = app.find(node => node.classes && node.classes.has('nxc'));
  assert.equal(input.focusCount, 0);
  assert.equal(root.styles['--nxc-view-height'], '640px');
  app.viewport.height = 350;
  app.viewport.offsetTop = 42;
  app.viewport.handlers.resize();
  assert.equal(root.styles['--nxc-view-height'], '350px');
  assert.equal(root.styles['--nxc-view-top'], '42px');
});
