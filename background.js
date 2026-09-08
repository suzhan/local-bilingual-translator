const DEFAULTS = {
  endpoint: "http://127.0.0.1:11434",
  model: "qwen3:0.6b",
  batchSize: 16,
  concurrency: 1,
  temperature: 0.1,
  autoTranslate: false,
  autoDomains: [],
  minLength: 3
};
const translationCache = new Map();
let healthCache = { key: "", time: 0, value: null };

chrome.runtime.onInstalled.addListener(async () => {
  const saved = await chrome.storage.sync.get(DEFAULTS);
  if (!saved.performanceV3) {
    if (saved.batchSize === 8) saved.batchSize = 16;
    if (saved.concurrency === 2) saved.concurrency = 1;
    saved.performanceV3 = true;
  }
  await chrome.storage.sync.set(saved);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "TRANSLATE_BATCH") {
    translateBatch(message.texts)
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
    return true;
  }
  if (message.type === "CHECK_OLLAMA") {
    checkOllama()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: friendlyError(error) }));
    return true;
  }
});

async function settings() {
  return chrome.storage.sync.get(DEFAULTS);
}

function cleanEndpoint(value) {
  return value.replace(/\/+$/, "");
}

async function checkOllama() {
  const { endpoint, model } = await settings();
  const cacheKey = `${endpoint}\u0000${model}`;
  if (healthCache.key === cacheKey && Date.now() - healthCache.time < 30_000 && healthCache.value) return healthCache.value;
  const response = await fetch(`${cleanEndpoint(endpoint)}/api/tags`);
  if (!response.ok) throw new Error(`Ollama 返回 HTTP ${response.status}`);
  const data = await response.json();
  const models = (data.models || []).map((item) => item.name);
  const selectedInstalled = models.some((name) => name === model || name.startsWith(`${model}:`));
  if (selectedInstalled) {
    // GET 可能成功但 POST 被 CORS 拒绝；/api/show 可无推理开销地验证真实权限。
    const postCheck = await fetch(`${cleanEndpoint(endpoint)}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model })
    });
    if (postCheck.status === 403) throw new Error("Ollama 拒绝了 Chrome 扩展（HTTP 403）。请打开设置页，复制专属授权命令并重启 Ollama");
    if (!postCheck.ok) throw new Error(`Ollama POST 检查返回 HTTP ${postCheck.status}`);
  }
  const result = { models, selectedInstalled };
  healthCache = { key: cacheKey, time: Date.now(), value: result };
  return result;
}

async function translateBatch(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const { endpoint, model, temperature } = await settings();
  const results = Array(texts.length);
  const missingTexts = [];
  const missingIndexes = [];
  texts.forEach((text, index) => {
    const key = `${model}\u0000${text}`;
    if (translationCache.has(key)) results[index] = translationCache.get(key);
    else { missingTexts.push(text); missingIndexes.push(index); }
  });
  if (!missingTexts.length) return results;
  const schema = {
    type: "object",
    properties: {
      translations: {
        type: "array",
        items: { type: "string" },
        minItems: missingTexts.length,
        maxItems: missingTexts.length
      }
    },
    required: ["translations"]
  };
  const numbered = missingTexts.map((text, index) => `${index + 1}. ${text}`).join("\n");
  const response = await fetch(`${cleanEndpoint(endpoint)}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      keep_alive: "10m",
      format: schema,
      options: { temperature, num_ctx: 4096 },
      messages: [
        {
          role: "system",
          content: "你是专业英译中引擎。只翻译，不解释。译文自然、准确、简洁；保留人名、数字、链接、代码和专有名词；每个输入严格对应一个输出；不要合并或遗漏。"
        },
        { role: "user", content: `将以下 ${missingTexts.length} 段英文翻译成简体中文：\n${numbered}` }
      ]
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 403) {
      throw new Error("Ollama 拒绝了 Chrome 扩展（HTTP 403）。请打开设置页，复制专属授权命令并重启 Ollama");
    }
    throw new Error(`Ollama HTTP ${response.status}: ${detail.slice(0, 180)}`);
  }
  const data = await response.json();
  const raw = data.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("模型未返回有效 JSON，请重试或换用稍大的模型");
  }
  if (!Array.isArray(parsed.translations) || parsed.translations.length !== missingTexts.length) {
    throw new Error(`模型返回了 ${parsed.translations?.length ?? 0} 条译文，预期 ${missingTexts.length} 条`);
  }
  parsed.translations.forEach((item, translatedIndex) => {
    const value = String(item).trim().replace(/^\d+[.)、]\s*/, "");
    const originalIndex = missingIndexes[translatedIndex];
    results[originalIndex] = value;
    translationCache.set(`${model}\u0000${texts[originalIndex]}`, value);
  });
  if (translationCache.size > 1500) {
    const oldest = translationCache.keys().next().value;
    translationCache.delete(oldest);
  }
  return results;
}

function friendlyError(error) {
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return "无法连接本机 Ollama。请确认 Ollama 已启动，并查看设置页的连接说明。";
  }
  return error?.message || String(error);
}
