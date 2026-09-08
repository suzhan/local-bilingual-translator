const status = document.querySelector("#status");
const progress = document.querySelector("#progress");
const translateButton = document.querySelector("#translate");
const autoSiteButton = document.querySelector("#autoSite");
let currentHostname = "";

document.querySelector("#translate").addEventListener("click", () => sendToTab("START_TRANSLATION"));
document.querySelector("#remove").addEventListener("click", () => sendToTab("REMOVE_TRANSLATION"));
document.querySelector("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
autoSiteButton.addEventListener("click", toggleCurrentSite);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "TRANSLATION_PROGRESS") return;
  setStatus(message.message, message.state === "error");
  translateButton.disabled = message.state === "running";
  progress.hidden = message.state !== "running";
  if (message.total) progress.style.setProperty("--progress", `${Math.max(5, message.completed / message.total * 100)}%`);
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(type) {
  try {
    const tab = await activeTab();
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type });
    } catch (error) {
      if (!isMissingContentScript(error)) throw error;
      await injectContentScript(tab);
      response = await chrome.tabs.sendMessage(tab.id, { type });
    }
    if (!response?.ok) throw new Error(response?.error || "操作失败");
    if (type === "START_TRANSLATION") {
      translateButton.disabled = true;
      progress.hidden = false;
      setStatus("正在提取英文段落…");
    } else setStatus("已移除译文");
  } catch (error) {
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
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
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
  const { autoDomains = [] } = await chrome.storage.sync.get({ autoDomains: [] });
  const normalized = [...new Set(autoDomains.map(normalizeDomain).filter(Boolean))];
  const enabled = normalized.some((rule) => domainMatches(currentHostname, rule));
  const next = enabled
    ? normalized.filter((rule) => !domainMatches(currentHostname, rule))
    : [...normalized, currentHostname.replace(/^www\./, "")];
  await chrome.storage.sync.set({ autoDomains: [...new Set(next)] });
  renderSiteToggle(!enabled);
  setStatus(!enabled ? `已开启 ${currentHostname} 自动翻译` : `已关闭 ${currentHostname} 自动翻译`);
  if (!enabled) await sendToTab("START_TRANSLATION");
}

function renderSiteToggle(enabled) {
  autoSiteButton.textContent = `此网站：自动翻译已${enabled ? "开启" : "关闭"}`;
  autoSiteButton.classList.toggle("enabled", enabled);
}

activeTab().then(async (tab) => {
  try {
    currentHostname = normalizeDomain(new URL(tab.url).hostname);
    const { autoDomains = [] } = await chrome.storage.sync.get({ autoDomains: [] });
    renderSiteToggle(autoDomains.map(normalizeDomain).some((rule) => domainMatches(currentHostname, rule)));
  } catch { autoSiteButton.hidden = true; }
  try {
    const current = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" });
    if (current?.running) { translateButton.disabled = true; progress.hidden = false; setStatus("翻译正在进行中…"); }
    else if (current?.lastStatus?.state === "error") setStatus(current.lastStatus.message, true);
    else if (current?.count) setStatus(`当前页面已有 ${current.count} 段译文`);
  } catch { /* Chrome 内部页面无 content script */ }
});
