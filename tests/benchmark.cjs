// Node >= 20, no npm dependencies. Run with Ollama open on this Mac.
// Compares the original v0.3.0 request path with the actual v0.4.0 worker.
const { setup } = require('./worker-harness.cjs');
require('../translation-core.js');
const endpoint = process.env.OLLAMA_ENDPOINT || 'http://127.0.0.1:11434';
const model = process.env.OLLAMA_MODEL || 'qwen3:0.6b';
const texts = [
  'Local translation keeps your browsing content on this computer.',
  'The service is healthy and all database replicas are online.',
  'Check the network connection before restarting the application.',
  'The deployment completed successfully without any downtime.',
  'A rolling update replaces the old containers one at a time.',
  'The cache reduces repeated work and improves response time.',
  'Please preserve the original numbers, URLs and product names.',
  'The server received too many requests within the last minute.',
  'You can cancel the current task and start a new translation.',
  'Automatic translation processes new content as you scroll.',
  'A smaller first batch makes the first paragraph appear earlier.',
  'The backup should be stored separately from the production data.',
  'This setting controls the maximum number of concurrent requests.',
  'The model stays loaded for thirty minutes after the request.',
  'The application displays a clear error when the server is offline.',
  'Measure latency and translation quality using the same input text.'
];
async function baseline() {
  const start = performance.now();
  const response = await fetch(`${endpoint}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model, stream: false, think: false, keep_alive: '30m',
      format: { type: 'object', properties: { translations: { type: 'array', items: { type: 'string' }, minItems: texts.length, maxItems: texts.length } }, required: ['translations'] },
      options: { temperature: 0.1, num_ctx: 4096 },
      messages: [
        { role: 'system', content: '你是专业英译中引擎。只翻译，不解释。译文自然、准确、简洁；保留人名、数字、链接、代码和专有名词；每个输入严格对应一个输出；不要合并或遗漏。' },
        { role: 'user', content: `将以下 ${texts.length} 段英文翻译成简体中文：\n${texts.map((text, i) => `${i + 1}. ${text}`).join('\n')}` }
      ]
    })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const body = await response.json(); const translated = JSON.parse(body.message.content).translations;
  if (translated.length !== texts.length) throw new Error('基线译文数量不正确');
  const total = performance.now() - start;
  return { mode: 'v0.3.0（热模型、无缓存）', firstMs: total, totalMs: total, translations: translated };
}
async function optimized(app, label) {
  const start = performance.now(); let firstMs = null; const translated = [];
  for (const batch of TranslationCore.batches(texts.map(text => ({ text })), 8)) {
    const request = app.request(batch.map(item => item.text));
    const watch = setInterval(() => { if (firstMs === null && request.messages.some(m => m.type === 'item')) firstMs = performance.now() - start; }, 2);
    let result;
    try { result = await request.done(); } finally { clearInterval(watch); }
    if (result.type === 'error') throw new Error(result.error);
    const values = new Map(request.messages.filter(m => m.type === 'item').map(m => [m.index, m.text]));
    translated.push(...[...values].sort((a, b) => a[0] - b[0]).map(([i, value]) => value));
    firstMs ??= performance.now() - start;
  }
  return { mode: label, firstMs, totalMs: performance.now() - start, translations: translated };
}
(async () => {
  console.log(`模型 ${model}；接口 ${endpoint}。此脚本会向本机发送内置的 16 句英文测试文本。`);
  console.log('先预热双方请求路径；不卸载模型，不影响其他应用。首段时间为后台收到整段译文的时间，不包含页面绘制。');
  await baseline();
  let warm = setup(fetch); Object.assign(warm.config, { endpoint, model }); await optimized(warm, 'warmup');
  const rows = []; const outputs = [];
  for (let i = 0; i < 3; i++) {
    const app = setup(fetch); Object.assign(app.config, { endpoint, model });
    const runBaseline = async () => { const result = await baseline(); outputs.push(result); rows.push({ round: i + 1, ...result }); };
    const runOptimized = async () => {
      const result = await optimized(app, 'v0.4.0（热模型、无缓存）'); outputs.push(result); rows.push({ round: i + 1, ...result });
      rows.push({ round: i + 1, ...await optimized(app, 'v0.4.0（缓存命中）') });
    };
    if (i % 2) { await runOptimized(); await runBaseline(); } else { await runBaseline(); await runOptimized(); }
  }
  console.table(rows.map(({ round, mode, firstMs, totalMs }) => ({ round, mode, firstMs: Math.round(firstMs), totalMs: Math.round(totalMs) })));
  console.log('最后一轮译文，供人工检查翻译质量：');
  console.log(JSON.stringify(outputs.slice(-2), null, 2));
  console.log('以上是热模型对比，顺序交替以减小偏差；冷启动需在 Mac 空闲时单独测试。缓存计时受 5ms 轮询精度影响。');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
