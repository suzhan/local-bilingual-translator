/* Shared pure helpers: imported by the worker and content script; tested with node:test. */
(() => {
  function batches(items, size = 8) {
    const result = [];
    let current = [], chars = 0;
    for (const item of items) {
      // A tiny first batch reduces prompt latency; cap later batches by text length too.
      const limit = result.length ? Math.min(32, Math.max(1, size)) : Math.min(2, size);
      const budget = result.length ? 1800 : 600;
      if (current.length && (current.length >= limit || chars + item.text.length > budget)) {
        result.push(current); current = []; chars = 0;
      }
      current.push(item); chars += item.text.length;
    }
    if (current.length) result.push(current);
    return result;
  }

  // Emit only fully decoded JSON string items. Never paint an unterminated escape/string.
  class TranslationParser {
    constructor(onItem) { this.onItem = onItem; this.buffer = ''; this.pos = 0; this.started = false; this.count = 0; }
    push(text) {
      this.buffer += text;
      if (!this.started) {
        const match = /^\s*\{\s*"translations"\s*:\s*\[/.exec(this.buffer);
        if (!match) return;
        this.pos = match[0].length; this.started = true;
      }
      while (this.pos < this.buffer.length) {
        while (/[\s,]/.test(this.buffer[this.pos] || '\0')) this.pos++;
        if (this.buffer[this.pos] !== '"') return;
        let end = this.pos + 1;
        for (; end < this.buffer.length; end++) {
          if (this.buffer[end] === '\\') { end++; continue; }
          if (this.buffer[end] === '"') break;
        }
        if (end >= this.buffer.length) return;
        const value = JSON.parse(this.buffer.slice(this.pos, end + 1));
        this.pos = end + 1;
        this.onItem(this.count++, value);
      }
    }
  }
  function cacheKey(config, text) {
    return JSON.stringify(['v4', config.endpoint.replace(/\/+$/, ''), config.model, config.temperature, text]);
  }
  globalThis.TranslationCore = { batches, TranslationParser, cacheKey };
})();
