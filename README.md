# AI 翻译助手（Microsoft Edge / Chrome 扩展）

基于大模型的浏览器翻译插件，提供 **全页面翻译**、**划词翻译**、**网页总结** 三大能力。
兼容 OpenAI Chat Completions 协议，API Key、Base URL、模型名全部由用户自行配置，数据只在你与所选服务商之间流转。

## 功能

| 功能 | 说明 |
| --- | --- |
| 全页面翻译 | 自动识别页面正文，分批调用模型翻译；支持「替换原文」与「双语对照」两种模式，再次点击即可一键恢复原文 |
| 划词翻译 | 选中文字后出现悬浮按钮，点击即得到译文；也可开启「划词后自动翻译」直接出结果，译文支持流式输出与一键复制 |
| 网页总结 | 抽取页面正文，生成「一句话总结 + 要点列表」，流式展示在右侧抽屉中 |
| 中英互译 | 目标语言为「自动」时，中文内容译成英文、其它语言译成中文；也可手动指定 10 种语言 |
| 快捷入口 | 扩展弹窗、右键菜单、快捷键（`Alt+Shift+T` 整页 / `Alt+Shift+S` 总结 / `Alt+Shift+E` 划词）三处入口 |

## 安装（Edge）

1. 打开 `edge://extensions/`，开启左下角的 **开发人员模式**。
2. 点击 **加载解压缩的扩展**，选择本项目根目录（含 `manifest.json` 的目录）。
3. 点击工具栏中的扩展图标，在弹出的 **设置** 页填写：
   - **API Key**：如 `sk-xxxxxxxx`
   - **Base URL**：如 `https://api.deepseek.com`（可填 OpenAI、DeepSeek、各类网关地址）
   - **模型**：如 `deepseek-flash`、`gpt-4o-mini` 等
4. 点击 **测试连接**，看到「连接成功 · xxx ms」即可使用。

> Base URL 会自动补全为 `.../v1/chat/completions`；直接粘贴完整端点也能正确识别。

## 使用

- **翻译整页**：点扩展图标 → 翻译整个页面；或右键页面 → 「AI 翻译：翻译整个页面」；或 `Alt+Shift+T`。再执行一次即恢复原文。
- **划词翻译**：在页面上选中任意文字 → 点击悬浮的「译 划词翻译」按钮（或在快捷操作中开启自动翻译）。
- **总结网页**：点扩展图标 → 总结当前网页；或右键页面 → 「AI 翻译：总结此页面」；或 `Alt+Shift+S`。按 `Esc` 关闭面板。

设置项说明：

| 设置 | 作用 |
| --- | --- |
| 目标语言 | `自动` = 中 ⇄ 英 互译；也可固定为某一语言。总结在「自动」时输出中文 |
| 划词后自动翻译 | 选中即翻译，省去点击按钮 |
| 页面翻译方式 | 「替换原文」或「双语对照（原文 + 译文）」 |
| 总结详细程度 | 简短 / 标准 / 详细 |
| 关闭模型思考过程 | 对推理类模型发送 `thinking: {"type":"disabled"}`，显著提速降本；若服务商不支持该参数，插件会自动去掉并重试 |

## 项目结构

```
manifest.json                     MV3 清单
src/
  lib/
    config.js                     默认设置、Base URL 规范化、校验
    api.js                        OpenAI 协议客户端（含 SSE 流式解析、错误友好化）
    prompts.js                    提示词构造与语言判定
    translate.js                  批量翻译：分批、并发、解析、漏译重试
    summarize.js                  正文清洗与总结
    protocol.js                   消息/端口协议常量
    storage.js                    chrome.storage 读写
  background/service-worker.js    集中发起 AI 请求、右键菜单、快捷键、端口路由
  content/content.js              页面内 UI（Shadow DOM）、三种功能实现
  popup/                          配置与快捷操作弹窗
icons/                            图标
tests/
  unit.test.mjs                   离线单元测试
  integration.test.mjs            真实 API 集成测试
  e2e.run.mjs                     Edge 端到端测试（真实加载扩展）
```

设计要点：

- 所有 AI 请求都在 **Service Worker** 中发起，绕开页面 CORS 限制，且 API Key 不会被页面脚本读取。
- 页面内 UI 全部渲染在 **Shadow DOM** 中，与宿主页面样式完全隔离。
- 全页面翻译按「条目数 + 字符数」双阈值分批，3 路并发；模型返回格式异常时自动拆批重试，若整句被当作专有名词原样返回则会强引导重试补译。

## 开发与测试

```bash
npm install          # 安装测试依赖（playwright）
npm test             # 单元测试 + 真实 API 集成测试
npm run test:unit    # 仅离线单元测试
npm run test:e2e     # 在真实 Edge 中加载扩展跑端到端测试
```

测试使用的 API 配置可通过环境变量覆盖：`AIT_API_KEY`、`AIT_BASE_URL`、`AIT_MODEL`。
E2E 测试会自动启动本地站点、加载扩展并验证 popup、整页翻译、恢复原文、双语对照、划词翻译、自动划词、网页总结、未配置提示等 13 个场景，截图输出到 `tests/.artifacts/`。

## 兼容性

- 浏览器：Edge / Chrome 110+（Manifest V3）。
- 模型：任何兼容 OpenAI `chat/completions` 的服务，包括 DeepSeek、OpenAI、通义、Moonshot 以及自建网关。
- 使用 DeepSeek 时注意：模型列表里的显示名 `DeepSeek-V4.1-Flash` 对应的 API 模型 ID 是 **`deepseek-flash`**，请填写 ID。
- 翻译与总结均为纯文本调用，不依赖工具调用 / 多模态能力。

## 隐私

- 仅在你主动触发翻译或总结时，才会把对应文本发送到你配置的模型服务商。
- 插件自身不收集、不上报任何数据，API Key 存放在 `chrome.storage.sync` 中。
