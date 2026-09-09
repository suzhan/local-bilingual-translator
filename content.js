(() => {
if (globalThis.__localBilingualV4) return;
globalThis.__localBilingualV4 = true;
const TRANSLATION_CLASS = "local-bilingual-translation";
const SOURCE_ATTR = "data-local-bilingual-source";
const TARGET_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,td,th,dt,dd,summary";
let running = false;
let generation = 0;
let autoEnabled = false;
let autoPaused = false;
let pluginDisabled = false;
let autoTimer = 0;
let lastUrl = location.href;
let viewportRevision = 0;
let lastStatus = { message: "准备就绪", state: "idle", completed: 0, total: 0 };
const activeRequests = new Set();
const sourceTranslations = new Map();
const isCurrent = run => run === generation;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "START_TRANSLATION") {
    if (pluginDisabled) return sendResponse({ ok: false, error: "此网站位于“不使用插件”名单" });
    if (running) return sendResponse({ ok: false, error: "翻译正在进行中" });
    autoPaused = false;
    sendResponse({ ok: true });
    translatePage();
  } else if (message.type === "REMOVE_TRANSLATION") {
    removeTranslations(); sendResponse({ ok: true });
  } else if (message.type === "GET_STATUS") {
    sendResponse({ ok: true, running, count: document.querySelectorAll(`.${TRANSLATION_CLASS}`).length, lastStatus });
  }
});
async function refreshAutoSettings() {
  const settings = await chrome.storage.sync.get({
    autoTranslate: false, autoDomains: [], disabledDomains: [], noAutoDomains: []
  });
  pluginDisabled = matchesDomainList(settings.disabledDomains);
  const autoExcluded = matchesDomainList(settings.noAutoDomains);
  autoEnabled = !pluginDisabled && !autoExcluded && (settings.autoTranslate || matchesDomainList(settings.autoDomains));
  if (pluginDisabled) {
    removeTranslations({ pause: false, message: "此网站位于“不使用插件”名单" });
    return;
  }
  if (autoEnabled && !autoPaused) scheduleAutoTranslation(150);
  else clearTimeout(autoTimer);
}
refreshAutoSettings().catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.endpoint || changes.model || changes.temperature) removeTranslations();
  if (changes.autoTranslate || changes.autoDomains || changes.disabledDomains || changes.noAutoDomains) {
    autoPaused = false;
    refreshAutoSettings().catch(() => {});
  }
});
const pageObserver = new MutationObserver(mutations => {
  if (!autoEnabled || autoPaused) return;
  const hasPageContent = mutations.some(mutation => {
    if (mutation.target.parentElement?.closest(`.${TRANSLATION_CLASS}`) || mutation.target.closest?.(`.${TRANSLATION_CLASS}`)) return false;
    if (mutation.type === 'characterData') return true;
    return [...mutation.addedNodes].some(node =>
      node.nodeType === Node.TEXT_NODE || (node.nodeType === Node.ELEMENT_NODE && !node.matches?.(`.${TRANSLATION_CLASS}`))
    );
  });
  if (hasPageContent) scheduleAutoTranslation(250);
});
pageObserver.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  cancelRun();
  autoPaused = false;
  if (autoEnabled) scheduleAutoTranslation(150);
}, 1000);
window.addEventListener('pagehide', cancelRun);
window.addEventListener("scroll", () => {
  viewportRevision++;
  if (autoEnabled && !autoPaused) scheduleAutoTranslation(150);
}, { passive: true });
function normalizeDomain(value) {
  return String(value).toLowerCase().trim().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "").replace(/:\d+$/, "");
}
function matchesAutoDomain(domains) {
  return matchesDomainList(domains);
}
function matchesDomainList(domains) {
  const hostname = normalizeDomain(location.hostname);
  return (domains || []).map(normalizeDomain).filter(Boolean).some(rule => hostname === rule || hostname.endsWith(`.${rule}`));
}
function scheduleAutoTranslation(delay) {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    if (!autoEnabled || autoPaused) return;
    if (running) return scheduleAutoTranslation(300);
    translatePage({ quietWhenEmpty: true, viewportOnly: true });
  }, delay);
}
async function translatePage({ quietWhenEmpty = false, viewportOnly = false } = {}) {
  const run = ++generation;
  running = true;
  const startedAt = performance.now();
  let firstItemMs = null, completed = 0, cached = 0;
  try {
    announce('正在提取英文段落…', 'running', 0, 0);
    const config = await chrome.storage.sync.get({ batchSize: 8, concurrency: 1, minLength: 3 });
    if (!isCurrent(run)) return;
    const candidates = collectCandidates(config.minLength, viewportOnly);
    if (!candidates.length) {
      announce(quietWhenEmpty ? `当前视口已翻译，滚动后继续` : '没有发现需要翻译的英文段落', 'done', 0, 0);
      return;
    }
    // The translation POST itself verifies connectivity; no GET/POST preflight on the hot path.
    announce(`正在翻译 ${candidates.length} 段英文…`, 'running', 0, candidates.length);
    const batches = TranslationCore.batches(candidates, Math.max(1, Number(config.batchSize) || 8));
    let cursor = 0;
    let scheduledViewport = viewportRevision;
    const displayed = new Set();
    const update = (item, isCached) => {
      if (!isCurrent(run) || displayed.has(item)) return;
      displayed.add(item); completed++; cached += Number(isCached);
      firstItemMs ??= performance.now() - startedAt;
      announce(`已显示 ${completed}/${candidates.length} 段`, 'running', completed, candidates.length);
    };
    const rollback = item => { if (displayed.delete(item)) completed--; };
    async function worker() {
      while (isCurrent(run)) {
        if (scheduledViewport !== viewportRevision) {
          scheduledViewport = viewportRevision;
          const priority = batch => {
            const source = batch[0].elements.find(element => element.isConnected);
            if (!source) return Infinity;
            const rect = source.getBoundingClientRect();
            return rect.bottom >= 0 && rect.top <= window.innerHeight ? 0 : Math.abs(rect.top);
          };
          const pending = batches.slice(cursor).map(batch => ({ batch, rank: priority(batch) })).sort((a, b) => a.rank - b.rank);
          batches.splice(cursor, batches.length - cursor, ...pending.map(item => item.batch));
        }
        const index = cursor++;
        if (index >= batches.length) return;
        await translateWithFallback(batches[index], run, update, rollback);
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, Math.max(1, Number(config.concurrency) || 1), batches.length) }, worker));
    if (!isCurrent(run)) return;
    const elapsedMs = performance.now() - startedAt;
    announce(`翻译完成，共 ${completed} 段 · 首段 ${((firstItemMs || 0) / 1000).toFixed(2)} 秒 · 总耗时 ${(elapsedMs / 1000).toFixed(1)} 秒 · 缓存 ${cached} 段`, 'done', completed, candidates.length);
  } catch (error) {
    if (isCurrent(run)) {
      cancelRun();
      announce(`已显示 ${completed} 段：${error.message}`, 'error', completed, 0);
      // Offline/invalid model should not retry indefinitely on every mutation.
      autoPaused = true;
    }
  } finally { if (isCurrent(run)) running = false; }
}
function requestBatch(items, run, onItem) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'translation-v4' });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(watchdog); activeRequests.delete(cancel);
      port.disconnect();
      if (error) reject(error); else resolve(result);
    };
    const cancel = () => finish(new DOMException('翻译已取消', 'AbortError'));
    let watchdog;
    const touch = () => { clearTimeout(watchdog); watchdog = setTimeout(() => finish(new Error('翻译后台响应超时，请重试')), 100_000); };
    activeRequests.add(cancel); touch();
    port.onDisconnect.addListener(() => finish(new Error(chrome.runtime.lastError?.message || '翻译后台连接已断开，请重试')));
    port.onMessage.addListener(message => {
      touch();
      if (!isCurrent(run)) return cancel();
      if (message.type === 'item') onItem(message);
      if (message.type === 'done') finish(null, message.metrics);
      if (message.type === 'error') { const error = new Error(message.error); error.retryable = message.retryable; finish(error); }
    });
    port.postMessage({ type: 'translate', texts: items.map(item => item.text) });
  });
}
async function translateWithFallback(items, run, update, rollback, depth = 0) {
  if (!isCurrent(run) || !items.length) return;
  const provisional = new Map();
  const accepted = new Set();
  try {
    await requestBatch(items, run, message => {
      const item = items[message.index];
      if (!item || !isCurrent(run)) return;
      if (message.cached) accepted.add(item);
      if (provisional.has(item)) return;
      const nodes = [];
      item.elements.forEach(element => {
        // Frameworks may replace text without replacing the element while inference runs.
        if (normalizeText(element.innerText) !== item.text) return;
        const node = insertTranslation(element, message.text);
        if (node) nodes.push([element, node]);
      });
      provisional.set(item, nodes);
      if (nodes.length) update(item, message.cached);
    });
  } catch (error) {
    for (const [item, nodes] of provisional) {
      if (accepted.has(item)) continue;
      for (const [source, node] of nodes) {
        node.remove();
        if (sourceTranslations.get(source)?.node === node) { source.removeAttribute(SOURCE_ATTR); sourceTranslations.delete(source); }
      }
      rollback(item);
    }
    if (!isCurrent(run)) return;
    const remaining = items.filter(item => !accepted.has(item));
    if (!error.retryable || remaining.length <= 1 || depth >= 5) throw error;
    const middle = Math.ceil(remaining.length / 2);
    await translateWithFallback(remaining.slice(0, middle), run, update, rollback, depth + 1);
    await translateWithFallback(remaining.slice(middle), run, update, rollback, depth + 1);
  }
}
function collectCandidates(minLength, viewportOnly = false) {
  for (const [source, record] of sourceTranslations) {
    let rawText = source.innerText || '';
    if (source.contains(record.node)) {
      const index = rawText.lastIndexOf(record.node.innerText);
      if (index >= 0) rawText = rawText.slice(0, index) + rawText.slice(index + record.node.innerText.length);
    }
    const currentText = normalizeText(rawText);
    if (!source.isConnected || !record.node.isConnected || currentText !== record.text) {
      record.node.remove(); source.removeAttribute(SOURCE_ATTR); sourceTranslations.delete(source);
    }
  }
  const height = window.innerHeight;
  const items = [];
  for (const element of document.querySelectorAll(TARGET_SELECTOR)) {
    if (element.hasAttribute(SOURCE_ATTR) || element.closest(`.${TRANSLATION_CLASS},script,style,noscript,textarea,input,select,option,code,pre,[contenteditable], [hidden], [aria-hidden="true"]`)) continue;
    if (element.querySelector(TARGET_SELECTOR)) continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (viewportOnly && (rect.bottom < -height * 0.35 || rect.top > height * 1.35)) continue;
    if (getComputedStyle(element).visibility === 'hidden') continue;
    const text = normalizeText(element.innerText);
    if (text.length < minLength || text.length > 1800 || !looksEnglish(text)) continue;
    items.push({ element, text, visible: rect.bottom >= 0 && rect.top <= height, top: Math.abs(rect.top) });
  }
  items.sort((a, b) => Number(b.visible) - Number(a.visible) || a.top - b.top);
  const unique = new Map();
  for (const item of items) {
    const existing = unique.get(item.text);
    if (existing) existing.elements.push(item.element);
    else unique.set(item.text, { ...item, elements: [item.element] });
  }
  return [...unique.values()];
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
  const originalText = normalizeText(source.innerText);
  const translated = document.createElement("div");
  translated.className = TRANSLATION_CLASS;
  translated.lang = "zh-CN";
  translated.textContent = translation;
  translated.setAttribute("data-local-bilingual-owned", "true");
  source.setAttribute(SOURCE_ATTR, "true");
  if (source.matches("li,td,th")) source.append(translated);
  else source.insertAdjacentElement("afterend", translated);
  applyReadableTheme(source, translated);
  sourceTranslations.set(source, { node: translated, text: originalText });
  return translated;
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

function cancelRun() {
  generation++; running = false;
  clearTimeout(autoTimer);
  for (const cancel of [...activeRequests]) cancel();
}
function removeTranslations({ pause = true, message = "已移除译文，自动翻译已暂停；点击翻译可继续" } = {}) {
  autoPaused = pause;
  cancelRun();
  document.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach(element => element.remove());
  document.querySelectorAll(`[${SOURCE_ATTR}]`).forEach(element => element.removeAttribute(SOURCE_ATTR));
  sourceTranslations.clear();
  announce(message, 'done', 0, 0);
}
function announce(message, state, completed, total) {
  lastStatus = { message, state, completed, total };
  chrome.runtime.sendMessage({ type: 'TRANSLATION_PROGRESS', message, state, completed, total }).catch(() => {});
}
})();
