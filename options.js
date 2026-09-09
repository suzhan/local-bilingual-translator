const DEFAULTS = {
  endpoint: "http://127.0.0.1:11434", model: "qwen3:0.6b", batchSize: 8,
  concurrency: 1, autoTranslate: false, autoDomains: [], disabledDomains: [], noAutoDomains: []
};
const DOMAIN_LIST_IDS = new Set(["autoDomains", "disabledDomains", "noAutoDomains"]);
const ids = Object.keys(DEFAULTS);
const originCommand = `launchctl setenv OLLAMA_ORIGINS "chrome-extension://${chrome.runtime.id}"`;
document.querySelector("#originCommand").textContent = originCommand;
document.querySelector("#copyCommand").addEventListener("click", async () => {
  await navigator.clipboard.writeText(originCommand);
  document.querySelector("#copyCommand").textContent = "已复制";
});

async function restore() {
  const values = await chrome.storage.sync.get(DEFAULTS);
  ids.forEach((id) => {
    const element = document.getElementById(id);
    if (element.type === "checkbox") element.checked = values[id];
    else if (DOMAIN_LIST_IDS.has(id)) element.value = (values[id] || []).join("\n");
    else element.value = values[id];
  });
}

document.querySelector("#save").addEventListener("click", async () => {
  const values = {
    endpoint: document.querySelector("#endpoint").value.trim().replace(/\/+$/, ""),
    model: document.querySelector("#model").value.trim(),
    batchSize: Math.min(32, Math.max(1, (Number(document.querySelector("#batchSize").value) || 8))),
    concurrency: Math.min(4, Math.max(1, (Number(document.querySelector("#concurrency").value) || 1))),
    autoTranslate: document.querySelector("#autoTranslate").checked,
    autoDomains: parseDomains(document.querySelector("#autoDomains").value),
    disabledDomains: parseDomains(document.querySelector("#disabledDomains").value),
    noAutoDomains: parseDomains(document.querySelector("#noAutoDomains").value)
  };
  await chrome.storage.sync.set(values);
  flash("saveResult", "设置已保存", true);
});

function parseDomains(value) {
  return [...new Set(value.split(/[\n,]+/).map((item) => item.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "").replace(/:\d+$/, "")).filter(Boolean))];
}

document.querySelector("#test").addEventListener("click", async () => {
  const button = document.querySelector("#test");
  button.disabled = true;
  flash("testResult", "正在连接…");
  try {
    await chrome.storage.sync.set({
      endpoint: document.querySelector("#endpoint").value.trim().replace(/\/+$/, ""),
      model: document.querySelector("#model").value.trim()
    });
    const response = await chrome.runtime.sendMessage({ type: "CHECK_OLLAMA" });
    if (!response?.ok) throw new Error(response?.error || "连接失败");
    const suffix = response.selectedInstalled ? "所选模型已安装" : "已连接，但所选模型尚未安装";
    flash("testResult", suffix, response.selectedInstalled);
  } catch (error) {
    flash("testResult", error.message, false);
  } finally { button.disabled = false; }
});

function flash(id, message, ok) {
  const target = document.getElementById(id);
  target.textContent = message;
  target.className = ok === undefined ? "" : ok ? "ok" : "bad";
}

restore();
