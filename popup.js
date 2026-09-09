const status = document.querySelector("#status");
const progress = document.querySelector("#progress");
const translateButton = document.querySelector("#translate");
const autoSiteButton = document.querySelector("#autoSite");
let currentHostname = "";
let currentTabId = null;
let currentSiteDisabled = false;

document.querySelector("#translate").addEventListener("click", () => sendToTab("START_TRANSLATION"));
document.querySelector("#remove").addEventListener("click", () => sendToTab("REMOVE_TRANSLATION"));
document.querySelector("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
autoSiteButton.addEventListener("click", toggleCurrentSite);

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== "TRANSLATION_PROGRESS" || sender.tab?.id !== currentTabId) return;
  setStatus(message.message, message.state === "error");
  translateButton.disabled = currentSiteDisabled || message.state === "running";
  progress.hidden = message.state !== "running";
  if (message.total) progress.style.setProperty("--progress", `${Math.max(5, message.completed / message.total * 100)}%`);
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;
  return tab;
}

async function sendToTab(type) {
  try {
    const tab = await activeTab();
    if (type === "START_TRANSLATION") {
      translateButton.disabled = true; progress.hidden = false; setStatus("正在提取英文段落…");
    }
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type });
    } catch (error) {
      if (!isMissingContentScript(error)) throw error;
      await injectContentScript(tab);
      response = await chrome.tabs.sendMessage(tab.id, { type });
    }
    if (!response?.ok) throw new Error(response?.error || "操作失败");
    if (type !== "START_TRANSLATION") { translateButton.disabled = false; progress.hidden = true; setStatus("已移除译文，自动翻译已暂停"); }
  } catch (error) {
    translateButton.disabled = false; progress.hidden = true;
    setStatus(isRestrictedPageError(error) ? "Chrome 禁止插件在此页面运行，请打开普通网页后重试" : error.message, true);
  }
}

function isMissingContentScript(error) {
  return /Receiving end does not exist|Could not establish connection/i.test(error?.message || "");
}

function isRestrictedPageError(error) {
  return /Cannot access contents of url|The extensions gallery cannot be scripted|Missing host permission|chrome:\/\//i.test(error?.message || "");
}

async function injectContentScript(tab) {
  if (!tab?.id || !/^https?:|^file:/.test(tab.url || "")) {
    throw new Error("Chrome 禁止插件在此页面运行，请打开普通网页后重试");
  }
  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["translation-core.js", "content.js"] });
}

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function normalizeDomain(value) {
  return value.toLowerCase().trim().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "").replace(/:\d+$/, "");
}

function domainMatches(hostname, rule) {
  return hostname === rule || hostname.endsWith(`.${rule}`);
}

async function toggleCurrentSite() {
  if (!currentHostname) return setStatus("当前页面没有可用域名", true);
  const { autoDomains = [], disabledDomains = [], noAutoDomains = [] } = await chrome.storage.sync.get({ autoDomains: [], disabledDomains: [], noAutoDomains: [] });
  const normalized = [...new Set(autoDomains.map(normalizeDomain).filter(Boolean))];
  if (disabledDomains.map(normalizeDomain).some((rule) => domainMatches(currentHostname, rule))) {
    return setStatus("此网站位于“不使用插件”名单，请先在设置中移除", true);
  }
  const excluded = noAutoDomains.map(normalizeDomain).some((rule) => domainMatches(currentHostname, rule));
  const enabled = !excluded && normalized.some((rule) => domainMatches(currentHostname, rule));
  const next = enabled
    ? normalized.filter((rule) => !domainMatches(currentHostname, rule))
    : [...normalized, currentHostname.replace(/^www\./, "")];
  const nextNoAuto = noAutoDomains.map(normalizeDomain).filter((rule) => !domainMatches(currentHostname, rule));
  await chrome.storage.sync.set({ autoDomains: [...new Set(next)], noAutoDomains: nextNoAuto });
  renderSiteToggle(!enabled);
  setStatus(!enabled ? `已开启 ${currentHostname} 自动翻译` : `已关闭 ${currentHostname} 自动翻译`);
  if (!enabled) await sendToTab("START_TRANSLATION");
}

function renderSiteToggle(enabled) {
  autoSiteButton.textContent = enabled ? "将此网站移出自动翻译" : "将此网站加入自动翻译";
  autoSiteButton.classList.toggle("enabled", enabled);
}

activeTab().then(async (tab) => {
  try {
    currentHostname = normalizeDomain(new URL(tab.url).hostname);
    const { autoDomains = [], disabledDomains = [], noAutoDomains = [] } = await chrome.storage.sync.get({ autoDomains: [], disabledDomains: [], noAutoDomains: [] });
    currentSiteDisabled = disabledDomains.map(normalizeDomain).some((rule) => domainMatches(currentHostname, rule));
    const autoExcluded = noAutoDomains.map(normalizeDomain).some((rule) => domainMatches(currentHostname, rule));
    renderSiteToggle(!autoExcluded && autoDomains.map(normalizeDomain).some((rule) => domainMatches(currentHostname, rule)));
    if (currentSiteDisabled) {
      translateButton.disabled = true;
      autoSiteButton.disabled = true;
      setStatus("此网站位于“不使用插件”名单", true);
    }
  } catch { autoSiteButton.hidden = true; }
  if (currentSiteDisabled) return;
  try {
    const current = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" });
    if (current?.running) { translateButton.disabled = true; progress.hidden = false; setStatus("翻译正在进行中…"); }
    else if (current?.lastStatus) setStatus(current.lastStatus.message, current.lastStatus.state === "error");
    else if (current?.count) setStatus(`当前页面已有 ${current.count} 段译文`);
  } catch { /* Chrome 内部页面无 content script */ }
});
