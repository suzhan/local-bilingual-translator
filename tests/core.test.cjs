const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../translation-core.js');
const { TranslationParser, batches, cacheKey } = global.TranslationCore;
test('streams complete strings across every split including unicode and escaped quotes', () => {
  const expected = ['你好，"世界"', '路径 C:\\tmp\n换行', 'emoji 🐈', '保留 1.2.3'];
  const json = JSON.stringify({ translations: expected });
  for (let split = 0; split <= json.length; split++) {
    const out = [];
    const parser = new TranslationParser((index, text) => { assert.equal(index, out.length); out.push(text); });
    parser.push(json.slice(0, split)); parser.push(json.slice(split));
    assert.deepEqual(out, expected);
  }
  const out = []; const parser = new TranslationParser((i, text) => out.push(text));
  for (const char of '{"translations":["\\u4f60\\u597d", "a\\\\\\\"b"]}') parser.push(char);
  assert.deepEqual(out, ['你好', 'a\\"b']);
});
test('first complete paragraph arrives before entire JSON document', () => {
  const out = []; const parser = new TranslationParser((i, text) => out.push(text));
  parser.push('{"translations":["首段", "未完'); assert.deepEqual(out, ['首段']);
  parser.push('成"]}'); assert.deepEqual(out, ['首段', '未完成']);
});
test('adaptive batches preserve all items with small first batch and bounded chars', () => {
  const input = Array.from({ length: 60 }, (_, i) => ({ text: 'x'.repeat(i % 3 ? 100 : 1800) }));
  for (const size of [1, 2, 8, 32]) {
    const result = batches(input, size);
    assert.deepEqual(result.flat(), input);
    assert.ok(result[0].length <= Math.min(size, 2));
    for (const batch of result) { assert.ok(batch.length <= size); assert.ok(batch.reduce((n, i) => n + i.text.length, 0) <= 1800); }
  }
});
test('cache separates endpoint/model/temperature and preserves punctuation', () => {
  const base = { endpoint: 'http://localhost:11434', model: 'qwen3:0.6b', temperature: 0.1 };
  const key = cacheKey(base, 'text');
  for (const change of [{ endpoint: 'http://127.0.0.1:11434' }, { model: 'different' }, { temperature: 0.5 }]) assert.notEqual(cacheKey({ ...base, ...change }, 'text'), key);
  assert.equal(cacheKey({ ...base, endpoint: base.endpoint + '/' }, 'text'), key);
});
