const TRANSLATION_CLASS = "local-bilingual-translation";
const SOURCE_ATTR = "data-local-bilingual-source";
const TARGET_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,td,th,dt,dd,summary";
let running = false;
let cancelled = false;
let lastStatus = { message: "准备就绪", state: "idle", completed: 0, total: 0 };
let domainAutoEnabled = false;
let autoTimer = 0;
let lastUrl = location.href;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "START_TRANSLATION") {
    if (running) return sendResponse({ ok: false, error: "翻译正在进行中" });
    translatePage();
    sendResponse({ ok: true });
  } else if (message.type === "REMOVE_TRANSLATION") {
    removeTranslations();
    sendResponse({ ok: true });
  } else if (message.type === "GET_STATUS") {
    sendResponse({ ok: true, running, count: document.querySelectorAll(`.${TRANSLATION_CLASS}`).length, lastStatus });
  }
});

chrome.storage.sync.get({ autoTranslate: false, autoDomains: [] }).then(({ autoTranslate, autoDomains }) => {
  domainAutoEnabled = matchesAutoDomain(autoDomains);
  if ((autoTranslate || domainAutoEnabled) && looksEnglish(document.body?.innerText || "")) scheduleAutoTranslation(350);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.autoDomains) return;
  domainAutoEnabled = matchesAutoDomain(changes.autoDomains.newValue || []);
  if (domainAutoEnabled) scheduleAutoTranslation(100);
});

const pageObserver = new MutationObserver((mutations) => {
  if (!domainAutoEnabled) return;
  const hasPageContent = mutations.some((mutation) => [...mutation.addedNodes].some((node) =>
    node.nodeType === Node.TEXT_NODE || (node.nodeType === Node.ELEMENT_NODE && !node.matches?.(`.${TRANSLATION_CLASS}`))
  ));
  if (hasPageContent) scheduleAutoTranslation(900);
});
pageObserver.observe(document.documentElement, { childList: true, subtree: true });

setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  if (domainAutoEnabled) scheduleAutoTranslation(400);
}, 1000);

window.addEventListener("scroll", () => {
  if (domainAutoEnabled) scheduleAutoTranslation(220);
}, { passive: true });

function normalizeDomain(value) {
  return String(value).toLowerCase().trim().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "").replace(/:\d+$/, "");
}

function matchesAutoDomain(domains) {
  const hostname = normalizeDomain(location.hostname);
  return (domains || []).map(normalizeDomain).filter(Boolean).some((rule) => hostname === rule || hostname.endsWith(`.${rule}`));
}

function scheduleAutoTranslation(delay) {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    if (running) return scheduleAutoTranslation(700);
    translatePage({ quietWhenEmpty: true, viewportOnly: true });
  }, delay);
}

async function translatePage({ quietWhenEmpty = false, viewportOnly = false } = {}) {
  running = true;
  cancelled = false;
  try {
    const config = await chrome.storage.sync.get({ batchSize: 16, concurrency: 1, minLength: 3 });
    const candidates = collectCandidates(config.minLength, viewportOnly);
    if (!candidates.length) {
      if (!quietWhenEmpty) announce("没有发现需要翻译的英文段落", "done", 0, 0);
      return;
    }
    const health = await chrome.runtime.sendMessage({ type: "CHECK_OLLAMA" });
    if (!health?.ok) {
      announce(health?.error || "无法连接本机 Ollama", "error", 0, 0);
      return;
    }
    if (!health.selectedInstalled) {
      announce("Ollama 已连接，但设置中选择的模型尚未安装", "error", 0, 0);
      return;
    }
    announce(`发现 ${candidates.length} 段英文`, "running", 0, candidates.length);
    const batches = chunk(candidates, Math.max(1, Number(config.batchSize) || 16));
    let cursor = 0;
    let completed = 0;
    let failed = 0;
    let firstError = "";

    async function worker() {
      while (!cancelled) {
        const index = cursor++;
        if (index >= batches.length) return;
        const batch = batches[index];
        const result = await translateWithFallback(batch);
        completed += result.completed;
        failed += result.failed;
        if (!firstError && result.firstError) firstError = result.firstError;
        announce(`已翻译 ${completed}/${candidates.length}`, "running", completed, candidates.length);
      }
    }

    const workerCount = Math.min(Math.max(1, Number(config.concurrency) || 1), 4, batches.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    announce(
      failed ? `完成 ${completed} 段，${failed} 段失败：${firstError}` : `翻译完成，共 ${completed} 段`,
      failed ? "error" : "done",
      completed,
      candidates.length
    );
  } finally {
    running = false;
  }
}

// 超小模型在大批量时可能少返回一项。自动二分重试，避免一项异常拖累整批。
async function translateWithFallback(items) {
  if (cancelled || !items.length) return { completed: 0, failed: 0, firstError: "" };
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE_BATCH",
      texts: items.map((item) => item.text)
    });
    if (!response?.ok) throw new Error(response?.error || "翻译失败");
    items.forEach((item, index) => item.elements.forEach((element) => insertTranslation(element, response.translations[index])));
    return { completed: items.length, failed: 0, firstError: "" };
  } catch (error) {
    const fatal = /无法连接|HTTP|not found|模型.*安装|fetch/i.test(error.message);
    if (fatal) return { completed: 0, failed: items.length, firstError: error.message };
    if (items.length === 1) return { completed: 0, failed: 1, firstError: error.message };
    const middle = Math.ceil(items.length / 2);
    const left = await translateWithFallback(items.slice(0, middle));
    const right = await translateWithFallback(items.slice(middle));
    return {
      completed: left.completed + right.completed,
      failed: left.failed + right.failed,
      firstError: left.firstError || right.firstError || error.message
    };
  }
}

function collectCandidates(minLength, viewportOnly = false) {
  const viewportHeight = window.innerHeight;
  const items = [...document.querySelectorAll(TARGET_SELECTOR)]
    .filter((element) => isEligible(element, minLength))
    .map((element) => {
      const text = normalizeText(element.innerText);
      const rect = element.getBoundingClientRect();
      const visible = rect.bottom >= 0 && rect.top <= viewportHeight;
      return { element, text, visible, nearViewport: rect.bottom >= -viewportHeight * 0.35 && rect.top <= viewportHeight * 1.35, top: Math.abs(rect.top) };
    })
    .filter((item) => !viewportOnly || item.nearViewport)
    .sort((a, b) => Number(b.visible) - Number(a.visible) || a.top - b.top);
  const unique = new Map();
  for (const item of items) {
    const existing = unique.get(item.text);
    if (existing) existing.elements.push(item.element);
    else unique.set(item.text, { ...item, elements: [item.element] });
  }
  return [...unique.values()];
}

function isEligible(element, minLength) {
  if (element.closest(`.${TRANSLATION_CLASS},script,style,noscript,textarea,input,select,option,code,pre,[contenteditable=true]`)) return false;
  if (element.hasAttribute(SOURCE_ATTR) || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (element.querySelector(TARGET_SELECTOR)) return false;
  const text = normalizeText(element.innerText);
  if (text.length < minLength || text.length > 1800) return false;
  return looksEnglish(text);
}

function looksEnglish(text) {
  const latinWords = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const cjk = text.match(/[\u3400-\u9fff]/g) || [];
  return latinWords.length >= 2 && latinWords.join("").length >= Math.max(5, cjk.length * 1.5);
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function insertTranslation(source, translation) {
  if (!source.isConnected || !translation || source.hasAttribute(SOURCE_ATTR)) return;
  const translated = document.createElement(source.matches("li") ? "div" : "div");
  translated.className = TRANSLATION_CLASS;
  translated.lang = "zh-CN";
  translated.textContent = translation;
  translated.setAttribute("data-local-bilingual-owned", "true");
  source.setAttribute(SOURCE_ATTR, "true");
  if (source.matches("li,td,th")) source.append(translated);
  else source.insertAdjacentElement("afterend", translated);
  applyReadableTheme(source, translated);
}

function applyReadableTheme(source, translated) {
  const background = effectiveBackground(translated);
  const sourceColor = parseColor(getComputedStyle(source).color);
  const black = [38, 50, 68, 1];
  const white = [235, 241, 248, 1];
  let textColor = contrastRatio(sourceColor, background) >= 4.5 ? sourceColor : null;
  if (!textColor) textColor = contrastRatio(black, background) >= contrastRatio(white, background) ? black : white;
  const darkSurface = relativeLuminance(background) < 0.42;
  translated.style.setProperty("--local-translation-color", cssColor(textColor));
  translated.style.setProperty("--local-translation-border", darkSurface ? "#60a5fa" : "#2563eb");
  translated.style.setProperty("--local-translation-bg", darkSurface ? "rgb(96 165 250 / 0.12)" : "rgb(37 99 235 / 0.06)");
  translated.dataset.surface = darkSurface ? "dark" : "light";
}

function effectiveBackground(element) {
  let result = [0, 0, 0, 0];
  for (let current = element.parentElement; current; current = current.parentElement) {
    const color = parseColor(getComputedStyle(current).backgroundColor);
    if (color[3] > 0) result = composite(result, color);
    if (result[3] >= 0.98) break;
  }
  const canvas = getComputedStyle(document.documentElement).colorScheme.includes("dark") ? [18, 20, 24, 1] : [255, 255, 255, 1];
  return composite(result, canvas);
}

function parseColor(value) {
  const parts = String(value).match(/[\d.]+/g)?.map(Number) || [];
  if (parts.length < 3) return [0, 0, 0, 0];
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

function composite(foreground, background) {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (!alpha) return [0, 0, 0, 0];
  return [0, 1, 2].map((index) =>
    (foreground[index] * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha
  ).concat(alpha);
}

function relativeLuminance(color) {
  const channels = color.slice(0, 3).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function cssColor(color) {
  return `rgb(${color.slice(0, 3).map(Math.round).join(" ")})`;
}

function removeTranslations() {
  cancelled = true;
  document.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((element) => element.remove());
  document.querySelectorAll(`[${SOURCE_ATTR}]`).forEach((element) => element.removeAttribute(SOURCE_ATTR));
  announce("已移除译文", "done", 0, 0);
}

function announce(message, state, completed, total) {
  lastStatus = { message, state, completed, total };
  chrome.runtime.sendMessage({ type: "TRANSLATION_PROGRESS", message, state, completed, total }).catch(() => {});
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
