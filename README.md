# Local Bilingual Translator / 本地双语翻译 v0.5.0

[中文](#中文说明) · [English](#english)

A fast, privacy-first Chrome extension that translates English webpages into readable English–Chinese bilingual layouts with a local Ollama model on macOS.

一个快速、隐私优先的 Chrome 扩展，使用 macOS 本机 Ollama 模型，将英文网页排版为易读的中英双语页面。

---

## 中文说明

### 功能特点

- 保留英文原文，在下方逐段插入中文译文，不破坏原有链接和文字。
- 流式显示完整段落：首批最多两段，不必等待整批翻译结束。
- 自动模式优先翻译视口附近内容，滚动时继续处理动态内容。
- 支持深色、浅色及混合背景，逐段计算文字对比度。
- 文本去重和会话缓存；缓存按 Ollama 地址、模型和温度隔离。
- 所有标签页共享请求队列，支持取消、超时、格式校验和失败拆分重试。
- 弹窗可将当前网站加入或移出自动翻译名单。
- 支持三类网站规则：
  - 自动翻译名单：进入该域名下任意页面后自动翻译。
  - 不自动翻译名单：不自动处理，但仍可手动翻译。
  - 不使用插件名单：完全禁止该网站使用插件，优先级最高。
- 无云端 API Key，网页文字只发送到本机 Ollama。

### 1. 安装 Ollama 和模型

从 [Ollama 官网](https://ollama.com/download) 安装 macOS 版本并启动，然后运行：

```bash
ollama pull qwen3:0.6b
```

`qwen3:0.6b` 约 523 MB，适合速度优先的设备。若希望提升质量，可安装：

```bash
ollama pull qwen3:1.7b
```

然后在插件设置中把模型名称改为 `qwen3:1.7b`。

### 2. 加载 Chrome 扩展

1. 克隆或下载本仓库。
2. 在 Chrome 打开 `chrome://extensions/`。
3. 开启右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择仓库根目录并将插件固定到工具栏。

### 3. 解决 Ollama HTTP 403

Ollama 可能拒绝来自 `chrome-extension://` 的 POST 请求。先打开插件的“设置与连接测试”，复制页面生成的专属授权命令，在终端执行后彻底退出并重新打开 Ollama。

如果当前 Ollama 版本仍拒绝精确插件 ID，可使用下面的兼容配置：

```bash
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
```

再次重启 Ollama 后点击“测试连接”。注意：通配配置会允许本机所有 Chrome 扩展访问 Ollama；只应在你信任已安装扩展的设备上使用。

### 4. 使用与网站规则

- 点击“翻译当前网页”进行手动翻译。
- 点击“移除中文译文”可取消在途请求并移除译文。
- 点击“将此网站加入自动翻译”可记录当前域名；再次点击可移出名单。
- 在设置页可批量编辑自动翻译、不自动翻译和不使用插件名单，每行填写一个域名。
- 填写 `bbc.com` 会匹配 `bbc.com`、`www.bbc.com` 及其其他子域名，但不会匹配 `fakebbc.com`。

规则优先级：`不使用插件` > `不自动翻译` > `自动翻译`。

### 5. 性能设置

默认每批最多 8 段、全局并发 1。首批最多 2 段，后续批次还会受字符预算限制。提高并发不一定更快，尤其当 Ollama 本身只允许一个并行请求时。模型会保持加载 30 分钟以减少重复冷启动。

### 6. 测试

需要 Node.js 20 或更高版本，无需安装 npm 依赖：

```bash
node --test tests/*.test.cjs
node tests/benchmark.cjs
```

使用其他模型测速：

```bash
OLLAMA_MODEL=qwen3:1.7b node tests/benchmark.cjs
```

浏览器交互测试：

```bash
python3 -m http.server 8765
```

然后打开 `http://127.0.0.1:8765/tests/browser.html`。

### 7. 限制

- Chrome 内部页面、Chrome 网上应用店和内置 PDF 阅读器不允许普通内容脚本注入。
- 不翻译画布、图片、视频字幕、代码块和封闭 Shadow DOM 中的文字。
- 超小模型优先保证速度，专业术语和长句质量不及大型模型。
- 流式显示能显著缩短首段等待时间，但不保证整页生成耗时一定减少。

### 8. 从旧版升级

保留原扩展目录，在 `chrome://extensions/` 点击“重新加载”，并刷新已打开的网页。v0.4.0 起后台通信协议发生变化，旧页面必须刷新。使用原目录可以保留扩展 ID、设置和 Ollama 授权。

---

## English

### Features

- Keeps the original English text and inserts Chinese translations below it without replacing links or source content.
- Streams complete translated paragraphs as soon as available; the first batch contains at most two paragraphs.
- Prioritizes content near the viewport and continues translating dynamic content while scrolling.
- Calculates contrast per paragraph for dark, light, and mixed-background pages.
- Deduplicates source text and keeps a session cache isolated by endpoint, model, and temperature.
- Uses a global request queue across tabs with cancellation, timeouts, final JSON validation, rollback, and split retries.
- Adds or removes the current site from the auto-translate list directly from the popup.
- Supports three domain policies:
  - Auto-translate: translate every page under the configured domain.
  - Never auto-translate: allow manual translation but disable automatic translation.
  - Disable extension: disable both manual and automatic translation for the domain; this has the highest priority.
- Requires no cloud API key. Page text is sent only to the local Ollama service.

### 1. Install Ollama and a model

Install and launch Ollama from the [official download page](https://ollama.com/download), then run:

```bash
ollama pull qwen3:0.6b
```

`qwen3:0.6b` is approximately 523 MB and optimized for responsiveness. For better translation quality, use:

```bash
ollama pull qwen3:1.7b
```

Then change the model name to `qwen3:1.7b` in the extension settings.

### 2. Load the Chrome extension

1. Clone or download this repository.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository root and pin the extension to the toolbar.

### 3. Fix Ollama HTTP 403

Ollama may reject POST requests from a `chrome-extension://` origin. Open **Settings and connection test**, copy the generated origin command, run it in Terminal, then quit and relaunch Ollama completely.

If your Ollama version still rejects the exact extension ID, use this compatibility setting:

```bash
launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
```

Restart Ollama and test the connection again. Security note: the wildcard allows every locally installed Chrome extension to access Ollama. Use it only on a machine where you trust the installed extensions.

### 4. Usage and domain policies

- Click **Translate current page** for manual translation.
- Click **Remove Chinese translations** to cancel active requests and remove inserted translations.
- Click **Add this site to auto-translate** to save the current domain; click it again to remove the domain.
- Edit the auto-translate, never-auto-translate, and disabled-domain lists in Settings, one domain per line.
- A rule for `bbc.com` matches `bbc.com`, `www.bbc.com`, and other subdomains, but not `fakebbc.com`.

Policy precedence: `Disable extension` > `Never auto-translate` > `Auto-translate`.

### 5. Performance settings

The defaults are eight paragraphs per batch and one globally concurrent request. The first batch contains at most two paragraphs, and later batches are also limited by a character budget. Increasing concurrency may not improve speed when Ollama itself processes only one request at a time. The model is kept loaded for 30 minutes to reduce repeated cold starts.

### 6. Tests and benchmark

Node.js 20 or newer is required. No npm dependencies are needed:

```bash
node --test tests/*.test.cjs
node tests/benchmark.cjs
```

Benchmark another local model with:

```bash
OLLAMA_MODEL=qwen3:1.7b node tests/benchmark.cjs
```

For browser interaction tests, run:

```bash
python3 -m http.server 8765
```

Then open `http://127.0.0.1:8765/tests/browser.html`.

### 7. Limitations

- Chrome internal pages, the Chrome Web Store, and Chrome's built-in PDF viewer do not allow normal content-script injection.
- Canvas text, images, video subtitles, code blocks, and closed Shadow DOM content are not translated.
- The tiny default model favors speed over expert terminology and long-sentence quality.
- Streaming improves time to first paragraph, but may not reduce total full-page generation time.

### 8. Upgrading

Keep using the same extension directory, click **Reload** on `chrome://extensions/`, and refresh existing webpages. The background communication protocol changed in v0.4.0, so tabs running an older content script must be refreshed. Reusing the same directory preserves the extension ID, settings, and Ollama origin authorization.

---

## Project structure / 项目结构

- `background.js` — Ollama streaming, global queue, session cache, cancellation, and timeouts.
- `content.js` — webpage text detection, scheduling, DOM insertion, and contrast handling.
- `translation-core.js` — shared batching, streaming JSON parsing, and cache-key helpers.
- `popup.*` — toolbar controls and current-site auto-translate management.
- `options.*` — model, performance, and domain-policy settings.
- `tests/` — Node regression tests, browser interaction page, and local benchmark.
- `优化说明.md` — detailed Chinese optimization notes and test scope.

## Privacy and security / 隐私与安全

Translations are requested from the endpoint configured in the extension. The default is `http://127.0.0.1:11434`, and no cloud API key is required. Review any custom endpoint before using it. / 翻译请求会发送到插件中配置的地址；默认仅为 `http://127.0.0.1:11434`，无需云端 API Key。使用自定义地址前请确认其可信性。

## License / 许可证

No license file has been added yet. Copyright remains with the repository owner. / 当前尚未添加许可证文件，著作权归仓库所有者。
