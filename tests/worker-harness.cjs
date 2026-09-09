const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function event() { const listeners = []; return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) }; }
function setup(fetchImpl, session = {}) {
  const config = { endpoint: 'http://localhost:11434', model: 'test', temperature: 0.1, concurrency: 1 };
  const chrome = { runtime: { onInstalled: event(), onConnect: event(), onMessage: event() }, storage: { onChanged: event(), sync: { get: async defaults => ({ ...defaults, ...config }), set: async () => {} }, session: { get: async () => session, set: async value => Object.assign(session, value) } } };
  const context = vm.createContext({ chrome, fetch: fetchImpl, performance, AbortController, AbortSignal, DOMException, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval });
  context.importScripts = name => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context);
  function request(texts) {
    const messages = []; const port = { name: 'translation-v4', onDisconnect: event(), onMessage: event(), postMessage: message => messages.push(message) };
    chrome.runtime.onConnect.emit(port); port.onMessage.emit({ type: 'translate', texts });
    return { messages, cancel: () => port.onDisconnect.emit(), done: async () => {
      for (let i = 0; i < 36000; i++) { const final = messages.find(m => ['done', 'error'].includes(m.type)); if (final) { port.onDisconnect.emit(); return final; } await sleep(5); }
      port.onDisconnect.emit(); throw new Error('test request timed out');
    } };
  }
  return { request, config, chrome, context };
}

module.exports = { setup };
