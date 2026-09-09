const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeout = 300) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await sleep(2);
  }
}
const { setup } = require('./worker-harness.cjs');
function stream(parts, delay = 0) {
  const encoder = new TextEncoder(); let i = 0;
  return new Response(new ReadableStream({ async pull(controller) { if (delay) await sleep(delay); if (i === parts.length) controller.close(); else controller.enqueue(encoder.encode(parts[i++])); } }));
}
function answer(values) { return [JSON.stringify({ message: { content: JSON.stringify({ translations: values }) }, done: true, eval_count: 20, load_duration: 1000000 }) + '\n']; }
test('NDJSON byte fragmentation and first paragraph before final event; no preflight', async () => {
  let calls = 0; let body;
  const app = setup(async (url, options) => {
    calls++; assert.ok(url.endsWith('/api/chat')); body = JSON.parse(options.body);
    const first = JSON.stringify({ message: { content: '{"translations":["你好",' }, done: false }) + '\n';
    const second = JSON.stringify({ message: { content: '"保留 1.2.3"]}' }, done: true }) + '\n';
    return stream([first.slice(0, 12), first.slice(12), second], 25);
  });
  const req = app.request(['hello world', 'keep 1.2.3']);
  await waitFor(() => req.messages.some(m => m.type === 'item'));
  assert.equal(req.messages.filter(m => m.type === 'item')[0]?.text, '你好');
  assert.equal(req.messages.some(m => m.type === 'done'), false);
  const result = await req.done(); assert.equal(result.type, 'done');
  assert.equal(calls, 1); assert.equal(body.stream, true); assert.equal(body.think, false);
  assert.equal(req.messages.filter(m => m.type === 'item').at(-1).text, '保留 1.2.3');
});
test('global queue coalesces overlapping tab work via cache; session survives worker restart', async () => {
  let calls = 0; const session = {};
  const impl = async () => { calls++; return stream(answer(['译文']), 10); };
  const app = setup(impl, session);
  const a = app.request(['hello world']); const b = app.request(['hello world']);
  assert.equal((await a.done()).type, 'done'); assert.equal((await b.done()).type, 'done');
  assert.equal(calls, 1); assert.equal(b.messages.find(m => m.type === 'item').cached, true);
  await sleep(230);
  const restarted = setup(impl, session); await restarted.request(['hello world']).done(); assert.equal(calls, 1);
  restarted.config.model = 'other'; restarted.chrome.storage.onChanged.emit({}, 'sync');
  await restarted.request(['hello world']).done(); assert.equal(calls, 2);
});
test('abort cancels active fetch and queued work does not reach Ollama', async () => {
  let calls = 0, aborted = 0;
  const app = setup(async (url, options) => {
    calls++;
    if (calls > 1) return stream(answer(['新译文']));
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted++; reject(new DOMException('Aborted', 'AbortError')); }));
  });
  const a = app.request(['first words']); await sleep(5);
  const b = app.request(['queued words']); await sleep(5); b.cancel(); a.cancel(); await sleep(5);
  assert.equal(calls, 1); assert.equal(aborted, 1);
  assert.equal((await app.request(['new words']).done()).type, 'done');
});
test('invalid JSON, missing items and token limit are retryable and never cached', async () => {
  for (const raw of ['{"translations":["one"]}', '{"translations":["one", null]}', '{"translations":["one",']) {
    let calls = 0;
    const app = setup(async () => { calls++; return stream([JSON.stringify({ message: { content: raw }, done: true }) + '\n']); });
    const result = await app.request(['first text', 'second text']).done();
    assert.equal(result.type, 'error'); assert.equal(result.retryable, true);
    await app.request(['first text', 'second text']).done(); assert.equal(calls, 2);
  }
  const app = setup(async () => stream([JSON.stringify({ message: { content: '{"translations":["译文"]}' }, done: true, done_reason: 'length' })]));
  assert.equal((await app.request(['text input']).done()).retryable, true);
});
test('HTTP errors and broken streams fail without recursive model retries', async () => {
  for (const impl of [async () => new Response('Forbidden', { status: 403 }), async () => stream(['{"message":{"content":"x"}}\n'])]) {
    const app = setup(impl); const result = await app.request(['text input']).done();
    assert.equal(result.type, 'error'); assert.equal(result.retryable, false);
  }
});
test('duplicate inputs within a batch use one model output and preserve index mapping', async () => {
  const app = setup(async (url, options) => {
    assert.deepEqual(JSON.parse(JSON.parse(options.body).messages[1].content), ['repeat text']);
    return stream(answer(['相同译文']));
  });
  const req = app.request(['repeat text', 'repeat text']); await req.done();
  assert.deepEqual([...new Set(req.messages.filter(m => m.type === 'item').map(m => m.index))], [0, 1]);
});
