// Content lifecycle regression tests with a minimal DOM/Chrome double (not a real browser).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function event() { const listeners = []; return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) }; }
function setup(texts, mode = 'normal') {
  const nodes = [], progress = [], connections = [];
  const root = { parentElement: null };
  class Element {
    constructor(text = '', tag = 'p') { this.textContent = text; this.tag = tag; this.attrs = new Map(); this.children = []; this.isConnected = true; this.parentElement = root; this.style = { setProperty() {} }; this.dataset = {}; this.className = ''; }
    get innerText() { return this.textContent + this.children.filter(n => n.isConnected).map(n => '\n' + n.innerText).join(''); }
    closest() { return null; }
    querySelector() { return null; }
    getBoundingClientRect() { return { width: 300, height: 40, top: 0, bottom: 40 }; }
    hasAttribute(key) { return this.attrs.has(key); }
    setAttribute(key, value) { this.attrs.set(key, value); }
    removeAttribute(key) { this.attrs.delete(key); }
    contains(node) { return this.children.includes(node); }
    matches(selector) { return selector.split(',').includes(this.tag); }
    append(node) { this.children.push(node); node.parentElement = this; nodes.push(node); }
    insertAdjacentElement(where, node) { nodes.push(node); }
    remove() { this.isConnected = false; }
  }
  const sources = texts.map(text => new Element(text)); nodes.push(...sources);
  const document = { documentElement: root, createElement: tag => new Element('', tag), querySelectorAll: selector => {
    if (selector.startsWith('.')) return nodes.filter(n => n.isConnected && n.className === 'local-bilingual-translation');
    if (selector.startsWith('[')) return sources.filter(n => n.hasAttribute('data-local-bilingual-source'));
    return sources.filter(n => n.isConnected);
  } };
  const chrome = { runtime: { onMessage: event(), sendMessage: async message => progress.push(message), connect: () => {
    let closed = false;
    const port = { onMessage: event(), onDisconnect: event(), disconnect: () => { if (!closed) { closed = true; port.onDisconnect.emit(); } }, postMessage: message => {
      setTimeout(() => {
        if (closed) return;
        message.texts.forEach((text, index) => port.onMessage.emit({ type: 'item', index, text: '中文 ' + text, cached: false }));
      }, 15);
      setTimeout(() => {
        if (closed) return;
        port.onMessage.emit(mode === 'invalid' && message.texts.length > 1 ? { type: 'error', error: 'bad format', retryable: true } : { type: 'done' });
      }, 40);
    } };
    connections.push(port); return port;
  } }, storage: { sync: { get: async defaults => ({ ...defaults, autoTranslate: false, autoDomains: [] }) }, onChanged: event() } };
  const context = vm.createContext({ chrome, document, location: { href: 'https://test.example/', hostname: 'test.example' }, window: { innerHeight: 900, addEventListener() {} }, MutationObserver: class { observe() {} }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, performance, DOMException, setTimeout, clearTimeout, setInterval: (...args) => setInterval(...args).unref(), getComputedStyle: () => ({ visibility: 'visible', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0,0,0,0)', colorScheme: 'light' }) });
  for (const file of ['translation-core.js', 'content.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const command = type => { let response; chrome.runtime.onMessage.emit({ type }, {}, value => { response = value; }); return response; };
  const done = async () => { for (let i = 0; i < 100; i++) { if (!command('GET_STATUS').running) return; await sleep(5); } throw new Error('did not finish'); };
  return { sources, nodes, progress, connections, command, done, count: () => document.querySelectorAll('.local-bilingual-translation').length };
}
test('remove during generation prevents stale painting and permits immediate restart', async () => {
  const app = setup(['Hello world', 'Next sentence']);
  app.command('START_TRANSLATION'); await sleep(5); app.command('REMOVE_TRANSLATION');
  assert.equal(app.command('GET_STATUS').running, false);
  app.command('START_TRANSLATION'); await app.done(); await sleep(50);
  assert.equal(app.count(), 2); assert.equal(app.command('GET_STATUS').lastStatus.state, 'done');
  app.command('REMOVE_TRANSLATION'); await sleep(50); assert.equal(app.count(), 0);
});
test('invalid batch rolls back provisional DOM before split retry and restores source ownership', async () => {
  const app = setup(['Hello world', 'Next sentence'], 'invalid');
  app.command('START_TRANSLATION'); await app.done();
  assert.equal(app.count(), 2); assert.equal(app.connections.length, 3);
  assert.equal(app.command('GET_STATUS').lastStatus.completed, 2);
  app.command('START_TRANSLATION'); await app.done(); assert.equal(app.connections.length, 3);
});
test('source changed during inference is never paired with stale translation', async () => {
  const app = setup(['Original paragraph']); app.command('START_TRANSLATION'); await sleep(5);
  app.sources[0].textContent = 'Replacement paragraph'; await app.done(); assert.equal(app.count(), 0);
  app.command('START_TRANSLATION'); await app.done(); assert.equal(app.count(), 1);
});
test('translated list source is stable across rescans; changed text is retranslated', async () => {
  const app = setup(['List item words']); app.sources[0].tag = 'li';
  app.command('START_TRANSLATION'); await app.done();
  app.command('START_TRANSLATION'); await app.done(); assert.equal(app.connections.length, 1); assert.equal(app.count(), 1);
  app.sources[0].textContent = 'New list words'; app.command('START_TRANSLATION'); await app.done();
  assert.equal(app.connections.length, 2); assert.equal(app.count(), 1);
});
