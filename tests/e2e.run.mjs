/**
 * 端到端测试：在真实的 Microsoft Edge（Chromium）中加载扩展，
 * 验证 popup 配置、全页面翻译、划词翻译、网页总结与错误提示。
 *
 * 运行：npm run test:e2e
 */

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(__dirname, '.artifacts');
fs.mkdirSync(ARTIFACTS, { recursive: true });

// 密钥只从环境变量读取，绝不硬编码（.env 已被 .gitignore 排除）
const API = {
  apiKey: process.env.AIT_API_KEY || '',
  baseUrl: process.env.AIT_BASE_URL || 'https://api.deepseek.com',
  model: process.env.AIT_MODEL || 'deepseek-flash',
};

const EN_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>The Future of Artificial Intelligence</title>
<style>body{font:16px/1.7 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px}nav a{margin-right:12px}</style>
</head><body>
<nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>
<main>
<h1>The Future of Artificial Intelligence</h1>
<article>
<p id="p1">Artificial intelligence is transforming the way we work and live.</p>
<p id="p2">Large language models can now summarize documents, translate between languages, and write code.</p>
<p id="p3">Researchers say the technology will keep improving rapidly over the next decade, but they also warn about hallucination and privacy risks.</p>
<p id="p4">Many companies are experimenting with AI assistants to reduce repetitive work.</p>
<p id="p5">Early results suggest that productivity improves when people review the model output instead of trusting it blindly.</p>
</article>
</main>
<footer>Copyright 2026 Example Inc. All rights reserved.</footer>
</body></html>`;

/** 同站点的另一个地址，正文只有一段与 EN_PAGE 的 #p1 完全相同的英文，用于验证缓存复用。 */
const EN_REPEAT_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Repeated paragraph</title></head><body>
<main><p id="r1">Artificial intelligence is transforming the way we work and live.</p></main>
</body></html>`;

const ZH_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>人工智能的未来</title></head><body>
<h1>人工智能的未来</h1>
<p id="z1">人工智能正在改变我们的工作和生活方式。</p>
<p id="z2">大语言模型现在可以总结文档、翻译语言以及编写代码。</p>
<p id="z3">研究人员表示，这项技术在未来十年仍会快速进步，但他们也提醒要注意幻觉和隐私风险。</p>
</body></html>`;

/**
 * 超长页面：每个段落一个文本节点，总数远超过单轮采集额度（1500）
 * 与单次上限（3000），用于验证「只翻译一半」这个回归。
 */
const LONG_ITEMS = 3200;
const LONG_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Long page for page limit regression</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:16px}p{margin:0 0 4px}</style>
</head><body>
<div id="content">
${Array.from(
  { length: LONG_ITEMS },
  (_, i) =>
    `<p id="l${i}">Paragraph number ${i + 1} describes release notes, deployment status and rollback steps of the service.</p>`,
).join('\n')}
</div>
</body></html>`;

/**
 * 本地 mock 的 OpenAI 兼容端点：按批量提示词里的 [编号] 逐条回中文译文。
 * 让「整页翻译」这类需要成百上千次调用的用例可以零成本、确定性地跑。
 */
let mockDelayMs = 0;

async function handleMockApi(req, res) {
  if (req.url?.startsWith('/mock/delay')) {
    mockDelayMs = Number(new URL(req.url, 'http://localhost').searchParams.get('ms')) || 0;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, mockDelayMs }));
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    body = {};
  }
  const userText = (body.messages || []).find((m) => m.role === 'user')?.content || '';

  const items = [];
  for (const line of String(userText).split('\n')) {
    const m = line.match(/^\[(\d+)\]\s(.*)$/);
    if (m) items[Number(m[1])] = m[2];
  }
  const translations = [];
  for (let i = 0; i < items.length; i += 1) {
    const source = items[i] ?? '';
    translations.push(`【译】${String(source).slice(0, 40)} ${i + 1}`);
  }

  if (mockDelayMs) await new Promise((r) => setTimeout(r, mockDelayMs));

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(
    JSON.stringify({
      model: body.model || 'mock-model',
      choices: [
        {
          message: { role: 'assistant', content: JSON.stringify(translations) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 120, total_tokens: 240 },
    }),
  );
}

/* ---------------------------------------------------------------- */

const results = [];
let server;
let browser;
let ctx;
let page;
let extensionId;
let baseUrl;

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    log(`  ✔ ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: err });
    log(`  ✖ ${name} (${Date.now() - started}ms)\n      ${err?.message || err}`);
    await page?.screenshot({ path: path.join(ARTIFACTS, `fail-${results.length}.png`) }).catch(() => {});
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** 深度查询（穿透 Shadow DOM）。 */
async function deepText(selector) {
  return page.evaluate((sel) => {
    const find = (root) => {
      const direct = root.querySelector(sel);
      if (direct) return direct;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const found = find(el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    };
    const el = find(document);
    return el ? el.textContent : null;
  }, selector);
}

async function waitFor(fn, { timeout = 45000, interval = 400, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    if (Date.now() > deadline) throw new Error(`等待超时：${label}（最后结果：${JSON.stringify(last)}）`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** 通过后台向指定标签页下发命令（等价于 popup / 右键菜单的调用路径）。 */
async function sendToTab(tabUrlPrefix, type, payload = {}) {
  return sw.evaluate(
    async ({ urlPrefix, msgType, extra }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => (t.url || '').startsWith(urlPrefix));
      if (!tab) return { ok: false, message: `未找到标签页 ${urlPrefix}` };
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: msgType, ...extra });
        return { ok: true, res };
      } catch (err) {
        return { ok: false, message: err.message };
      }
    },
    { urlPrefix: tabUrlPrefix, msgType: type, extra: payload },
  );
}

async function setSettings(patch) {
  await sw.evaluate(async (p) => {
    const key = 'ait_settings';
    const current = (await chrome.storage.sync.get(key))[key] || {};
    await chrome.storage.sync.set({ [key]: { ...current, ...p } });
  }, patch);
}

async function readSettings() {
  return sw.evaluate(async () => (await chrome.storage.sync.get('ait_settings')).ait_settings);
}

/** 整页翻译请求会在历史里各留一条记录，用条数变化判断是否真的调用了模型。 */
async function countPageHistory() {
  return sw.evaluate(async () => {
    const data = await chrome.storage.local.get('ait_history');
    const list = Array.isArray(data?.ait_history) ? data.ait_history : [];
    return list.filter((e) => e?.kind === 'page').length;
  });
}

function countCJK(text) {
  return (String(text || '').match(/[\u4e00-\u9fff]/g) || []).length;
}

/** 超长页面里已被翻译的段落数（mock 译文含中文，据此判断落地情况）。 */
async function countTranslatedParagraphs() {
  return page.$$eval('#content > p', (els) => els.filter((el) => /[\u4e00-\u9fff]/.test(el.textContent)).length);
}

/** 读取内容脚本内部的翻译状态快照（已译记录 / 脱离节点数）。 */
async function readTranslateState(urlPrefix = baseUrl) {
  return sw.evaluate(async (prefix) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => (t.url || '').startsWith(prefix));
    if (!tab) return null;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
      return res?.state || null;
    } catch {
      return null;
    }
  }, urlPrefix);
}

async function paragraphTranslated(index) {
  return /[\u4e00-\u9fff]/.test(await page.textContent(`#l${index}`));
}

/** 切到本地 mock 模型端点，避免整页用例真的花钱。 */
async function useMockModel(extra = {}) {
  await setSettings({
    apiKey: 'mock-key',
    baseUrl: `${baseUrl}/v1`,
    model: 'mock-model',
    cacheEnabled: false,
    autoTranslateDynamic: false,
    pageMode: 'replace',
    ...extra,
  });
}

let sw;

/**
 * 在扩展内容脚本的隔离环境里执行一段代码（等价于「内容脚本被页面里的漏洞间接操控」）。
 * 普通的 page.evaluate 跑在页面主世界，拿不到 chrome.runtime，没法模拟内容脚本发出的消息。
 */
async function evalInContentScript(targetPage, expression) {
  const cdp = await ctx.newCDPSession(targetPage);
  try {
    const contexts = [];
    cdp.on('Runtime.executionContextCreated', (event) => contexts.push(event.context));
    await cdp.send('Runtime.enable');
    // 内容脚本在 document_idle 才注入，给它一点时间
    const deadline = Date.now() + 10000;
    let isolated;
    while (!(isolated = contexts.find((c) => c.auxData?.type === 'isolated' && String(c.origin).includes(extensionId)))) {
      if (Date.now() > deadline) throw new Error('未找到扩展内容脚本的隔离执行环境');
      await new Promise((r) => setTimeout(r, 150));
    }
    const res = await cdp.send('Runtime.evaluate', {
      expression,
      contextId: isolated.id,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || '内容脚本内执行失败');
    return res.result.value;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/* ---------------------------------------------------------------- */

async function main() {
  log('\n=== AI 翻译助手 · Edge 端到端测试 ===\n');

  // 本地测试站点
  server = http.createServer((req, res) => {
    // mock 模型端点：与测试站点共用一个端口，省掉额外进程
    if (req.url?.startsWith('/v1/') || req.url?.startsWith('/mock/')) {
      handleMockApi(req, res).catch(() => res.end('{}'));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url?.startsWith('/zh')) res.end(ZH_PAGE);
    else if (req.url?.startsWith('/en-repeat')) res.end(EN_REPEAT_PAGE);
    else if (req.url?.startsWith('/long')) res.end(LONG_PAGE);
    else res.end(EN_PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  log(`本地测试站点：${baseUrl}\n`);

  const launchArgs = [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`];
  const modes = [
    { label: 'Edge headless（新无头模式）', opts: { channel: 'msedge', headless: true } },
    { label: 'Edge 有界面模式', opts: { channel: 'msedge', headless: false } },
    { label: 'Chromium 无头模式', opts: { headless: true } },
  ];

  for (const mode of modes) {
    const userDataDir = path.join(os.tmpdir(), `ait-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      ctx = await chromium.launchPersistentContext(userDataDir, {
        ...mode.opts,
        args: launchArgs,
        viewport: { width: 1280, height: 860 },
      });
      sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null));
      if (!sw) {
        await ctx.close();
        ctx = null;
        log(`  · ${mode.label} 未能加载扩展，尝试下一种模式`);
        continue;
      }
      browser = ctx.browser();
      log(`  · 浏览器模式：${mode.label}`);
      break;
    } catch (err) {
      ctx = null;
      log(`  · ${mode.label} 启动失败：${String(err.message).split('\n')[0]}`);
    }
  }

  assert(ctx && sw, '无法在浏览器中加载扩展，请确认已安装 Microsoft Edge (Chromium)');
  extensionId = new URL(sw.url()).host;
  assert(extensionId && extensionId.length > 10, '无法获取扩展 ID');
  log(`扩展已加载，ID = ${extensionId}\n`);

  page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {});

  log('【1】扩展与 popup');
  await step('后台 Service Worker 正常启动', async () => {
    const title = await sw.evaluate(() => chrome.runtime.getManifest().name);
    assert(title === 'AI 翻译助手', `manifest 名称异常：${title}`);
  });

  await step('popup 页面渲染（语言选项 / 标签页切换）', async () => {
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    // 未配置时应自动跳到「设置」页
    await page.waitForSelector('[data-panel="settings"].is-active');
    assert(await page.locator('#apiKey').isVisible(), '设置面板未显示');
    await page.click('.tab[data-tab="actions"]');
    assert(await page.locator('[data-panel="actions"].is-active').isVisible(), '快捷操作面板未切换');
    await page.waitForSelector('#targetLang', { state: 'visible' });
    const options = await page.locator('#targetLang option').count();
    assert(options >= 8, `语言选项数量异常：${options}`);
    const actions = await page.locator('.action').count();
    assert(actions === 3, `快捷操作按钮数量异常：${actions}`);
  });

  await step('popup 保存 API 配置', async () => {
    await page.click('.tab[data-tab="settings"]');
    await page.fill('#apiKey', API.apiKey);
    await page.fill('#baseUrl', API.baseUrl);
    await page.fill('#model', API.model);
    await page.click('.tab[data-tab="actions"]');
    const saved = await waitFor(
      async () => {
        const s = await readSettings();
        return s?.apiKey === API.apiKey && s?.model === API.model && s?.baseUrl === API.baseUrl;
      },
      { label: '配置写入 storage', timeout: 15000 },
    );
    assert(saved, '配置未写入 storage');
    const status = await page.textContent('#statusText');
    assert(status.includes('已配置'), `状态提示异常：${status}`);
  });

  await step('popup 一键测试连接成功', async () => {
    await page.click('.tab[data-tab="settings"]');
    await page.click('#testBtn');
    const text = await waitFor(
      async () => {
        const t = (await page.textContent('#testResult')) || '';
        return t.includes('连接成功') || t.includes('失败') ? t : null;
      },
      { label: '测试连接结果', timeout: 40000 },
    );
    assert(text.includes('连接成功'), `测试连接失败：${text}`);
    await page.screenshot({ path: path.join(ARTIFACTS, 'popup.png') });
  });

  log('\n【2】全页面翻译');
  await page.goto(`${baseUrl}/en`);
  await waitFor(async () => page.locator('#p1').isVisible(), { label: '测试页面加载' });

  await step('触发整页翻译，英文段落被替换为中文', async () => {
    const res = await sendToTab(`${baseUrl}/en`, 'RUN_TRANSLATE_PAGE');
    assert(res.ok, `命令下发失败：${res.message}`);
    await waitFor(
      async () => {
        const text = await page.textContent('#p1');
        return countCJK(text) >= 5 ? text : null;
      },
      { label: '段落 #p1 出现中文译文', timeout: 60000 },
    );
    const body = await page.textContent('main');
    assert(countCJK(body) > 80, `页面整体翻译不足：${body.slice(0, 120)}`);
    const html = await page.getAttribute('html', 'data-ait-translated');
    assert(html === '1', '页面未标记为已翻译');
    assert(await page.locator('.ait-progress').isHidden(), '进度条未隐藏');
    // 页脚（版权声明）也应被翻译，不能被模型当成专有名词跳过
    const footer = await page.textContent('footer');
    assert(countCJK(footer) > 0, `页脚未翻译：${footer}`);
    // 页面上不应残留任何可见的浮层
    assert(await page.locator('.ait-selbtn').isHidden(), '划词按钮不应常驻显示');
    assert(await page.locator('.ait-panel').isHidden(), '总结面板不应常驻显示');
    await page.screenshot({ path: path.join(ARTIFACTS, 'page-translated.png') });
  });

  await step('再次触发可恢复原文', async () => {
    assert((await page.getAttribute('html', 'data-ait-translated')) === '1', '前置状态应为已翻译');
    await sendToTab(`${baseUrl}/en`, 'RUN_TRANSLATE_PAGE');
    await waitFor(async () => (await page.getAttribute('html', 'data-ait-translated')) === null, {
      label: '恢复原文',
      timeout: 20000,
    });
    const text = await page.textContent('#p1');
    assert(countCJK(text) === 0, `段落未恢复英文：${text}`);
  });

  await step('双语对照模式插入译文节点', async () => {
    await setSettings({ pageMode: 'bilingual' });
    await sendToTab(`${baseUrl}/en`, 'RUN_TRANSLATE_PAGE');
    const count = await waitFor(
      async () => {
        const n = await page.locator('.ait-trans-node').count();
        return n >= 5 ? n : null;
      },
      { label: '双语节点', timeout: 60000 },
    );
    assert(count >= 5, `双语节点数量不足：${count}`);
    const p1 = await page.textContent('#p1');
    assert(countCJK(p1) >= 2, '原文应以双语形式保留英文');
    await page.screenshot({ path: path.join(ARTIFACTS, 'page-bilingual.png') });
    await sendToTab(`${baseUrl}/en`, 'RUN_TRANSLATE_PAGE');
    await waitFor(async () => (await page.locator('.ait-trans-node').count()) === 0, {
      label: '双语节点清理',
      timeout: 20000,
    });
    await setSettings({ pageMode: 'replace' });
  });

  log('\n【2.5】持续翻译（动态内容自动补译）');
  await step('翻译完成后新增的 DOM 内容被自动补译', async () => {
    await setSettings({ pageMode: 'replace', autoTranslateDynamic: true });
    await sendToTab(`${baseUrl}/en`, 'RUN_TRANSLATE_PAGE');
    await waitFor(async () => countCJK(await page.textContent('#p1')) >= 5, {
      label: '重新整页翻译',
      timeout: 60000,
    });

    // 模拟 SPA 在翻译完成后异步插入的新内容
    const t0 = Date.now();
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'dyn1';
      p.textContent = 'This paragraph was added after the page had already been translated.';
      document.querySelector('main').appendChild(p);
    });

    const text = await waitFor(
      async () => {
        const t = await page.textContent('#dyn1');
        return countCJK(t) >= 5 ? t : null;
      },
      { label: '动态新增内容被补译', timeout: 45000 },
    );
    log(`  ↳ 新内容补译耗时约 ${Date.now() - t0}ms（含 400ms 轮询误差）`);
    assert(countCJK(text) >= 5, `动态内容未翻译：${text}`);
    // 原有段落应保持译文，不应被回滚
    assert(countCJK(await page.textContent('#p1')) >= 5, '原有译文被破坏');
    await page.screenshot({ path: path.join(ARTIFACTS, 'dynamic-translated.png') });
  });

  await step('重复文案命中翻译记忆，不再请求模型', async () => {
    await page.waitForTimeout(900); // 等上一轮的历史写入落盘
    const before = await countPageHistory();

    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'memo1';
      // 与 #p1 原文完全一致，应直接复用已有译文而不是重新请求
      p.textContent = 'Artificial intelligence is transforming the way we work and live.';
      document.querySelector('main').appendChild(p);
    });

    // 用细粒度轮询量出真实延迟（默认 waitFor 每 400ms 才探一次，误差过大）
    const t0 = Date.now();
    let text = '';
    for (let i = 0; i < 400; i += 1) {
      text = (await page.textContent('#memo1')) || '';
      if (countCJK(text) >= 5) break;
      await page.waitForTimeout(50);
    }
    log(`  ↳ 记忆命中耗时约 ${Date.now() - t0}ms`);
    assert(countCJK(text) >= 5, `重复文案未翻译：${text}`);
    assert(
      text.trim() === (await page.textContent('#p1')).trim(),
      '复用译文应与首次翻译一致',
    );

    const after = await countPageHistory();
    assert(after === before, `命中翻译记忆不应产生新请求：${before} → ${after}`);
  });

  await step('隐藏内容展开后被自动补译', async () => {
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'collapsed';
      box.style.display = 'none';
      const p = document.createElement('p');
      p.id = 'hidden1';
      p.textContent = 'Hidden content becomes visible only after expanding this panel.';
      box.appendChild(p);
      document.querySelector('main').appendChild(box);
    });
    // 等过一个防抖周期，确认不可见内容不会被翻译
    await page.waitForTimeout(1500);
    assert(
      countCJK(await page.textContent('#hidden1')) === 0,
      `不可见内容不应被翻译：${await page.textContent('#hidden1')}`,
    );

    await page.evaluate(() => {
      document.querySelector('#collapsed').style.display = 'block';
    });

    const text = await waitFor(
      async () => {
        const t = await page.textContent('#hidden1');
        return countCJK(t) >= 5 ? t : null;
      },
      { label: '展开后被补译', timeout: 45000 },
    );
    assert(countCJK(text) >= 5, `展开内容未翻译：${text}`);
  });

  await step('恢复原文后不再继续补译', async () => {
    await sendToTab(`${baseUrl}/en`, 'RUN_TRANSLATE_PAGE');
    await waitFor(async () => (await page.getAttribute('html', 'data-ait-translated')) === null, {
      label: '恢复原文',
      timeout: 20000,
    });
    assert(countCJK(await page.textContent('#p1')) === 0, '原文未恢复');

    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'afterRestore';
      p.textContent = 'This content should stay untranslated after restoring the original page.';
      document.querySelector('main').appendChild(p);
    });
    await page.waitForTimeout(2500);
    const t = await page.textContent('#afterRestore');
    assert(countCJK(t) === 0, `恢复原文后不应继续翻译：${t}`);
  });

  log('\n【2.6】翻译缓存（按站点跨页面复用）');
  await step('同站点另一个页面完全命中缓存，不再调用模型', async () => {
    await sw.evaluate(() => chrome.storage.local.remove('ait_translation_cache'));

    // 页面 A：整页翻译，把译文写进缓存
    await page.goto(`${baseUrl}/en`);
    await waitFor(async () => page.locator('#p1').isVisible(), { label: '缓存页 A 加载' });
    await page.waitForTimeout(500);
    await sendToTab(`${baseUrl}/en`, 'RUN_TRANSLATE_PAGE');
    const translatedA = await waitFor(
      async () => {
        const t = await page.textContent('#p1');
        return countCJK(t) >= 5 ? t : null;
      },
      { label: '页面 A 翻译完成', timeout: 60000 },
    );
    const afterA = await countPageHistory();

    // 页面 B：同站点另一个地址，正文只有与 A 的 #p1 完全相同的一段英文
    await page.goto(`${baseUrl}/en-repeat`);
    await waitFor(async () => page.locator('#r1').isVisible(), { label: '缓存页 B 加载' });
    await page.waitForTimeout(500);
    const sent = await sendToTab(`${baseUrl}/en-repeat`, 'RUN_TRANSLATE_PAGE');
    assert(sent.ok, `命令下发失败：${sent.message}`);

    const translatedB = await waitFor(
      async () => {
        const t = await page.textContent('#r1');
        return countCJK(t) >= 5 ? t : null;
      },
      { label: '页面 B 复用译文', timeout: 30000 },
    );
    assert(
      translatedB.trim() === translatedA.trim(),
      `跨页面复用应得到同一译文：${translatedA} vs ${translatedB}`,
    );

    const afterB = await countPageHistory();
    assert(afterB === afterA, `全量命中缓存不应新增模型调用：${afterA} → ${afterB}`);

    // 回到标准测试页，后面的用例依赖这个地址
    await page.goto(`${baseUrl}/en`);
    await waitFor(async () => page.locator('#p1').isVisible(), { label: '返回测试页' });
  });

  log('\n【2.7】站内连续导航（模拟"点着点着就不翻了"）');
  await step('连续切换路由触发补译限流后，翻译不会永久失效', async () => {
    await setSettings({ pageMode: 'replace', autoTranslateDynamic: true });
    await sendToTab(`${baseUrl}/en`, 'RUN_TRANSLATE_PAGE');
    await waitFor(async () => countCJK(await page.textContent('#p1')) >= 5, {
      label: '整页翻译就绪',
      timeout: 60000,
    });

    // 模拟 SPA 路由：整体替换主内容区并推进 history，外壳（nav）保持不变
    const route = (i) =>
      page.evaluate((n) => {
        document.querySelector('main').innerHTML =
          `<h1 id="pane-h">Panel ${n} overview</h1>` +
          `<p id="pane-a">Release ${n} finished building and is now serving production traffic.</p>` +
          `<p id="pane-b">Rolling back release ${n} takes a single click from this screen.</p>`;
        history.pushState({}, '', `/panel-${n}`);
      }, i);

    const paneTranslated = async () => {
      const texts = await page.$$eval('#pane-h, #pane-a, #pane-b', (els) => els.map((el) => el.textContent));
      return texts.length === 3 && texts.every((t) => countCJK(t) >= 3);
    };
    const shellStillTranslated = async () => countCJK(await page.textContent('nav')) >= 2;

    // 先跑满每分钟的补译配额（默认 20 轮），后续导航必然被限流
    const WARMUP = 20;
    let auto = 0;
    for (let i = 1; i <= WARMUP; i += 1) {
      await route(i);
      if (await waitFor(paneTranslated, { timeout: 8000, interval: 200 }).catch(() => null)) auto += 1;
    }
    log(`  ↳ 配额内自动补译 ${auto}/${WARMUP} 次`);
    assert(auto >= WARMUP - 3, `站内导航后自动补译异常，仅成功 ${auto}/${WARMUP} 次`);

    // 第 21 次：配额已耗尽，自动补译被拦下；此时用户点「翻译整页」必须能补上，
    // 而不是把已经译好的外壳恢复成原文（后者正是用户遇到的 bug）
    await route(21);
    const auto21 = await waitFor(paneTranslated, { timeout: 4000, interval: 200 }).catch(() => null);
    if (auto21) {
      log('  ↳ 第 21 次仍在配额内，未进入限流分支');
    } else {
      log('  ↳ 第 21 次被限流拦下，按下「翻译整页」');
      await sendToTab(baseUrl, 'RUN_TRANSLATE_PAGE');
      assert(
        await waitFor(paneTranslated, { timeout: 15000, interval: 300 }).catch(() => null),
        '被限流后按「翻译整页」仍无法补译',
      );
      assert(await shellStillTranslated(), '「翻译整页」把已翻译的外壳还原成了原文');
    }

    // 第 22 次：不再手动干预，验证限流只是退避、会自动恢复（旧实现会永久停表）
    await route(22);
    const recovered = await waitFor(paneTranslated, { timeout: 45000, interval: 500 }).catch(() => null);
    assert(recovered, '限流退避后未能自动恢复补译（旧实现会永久停止监听）');
    assert(await shellStillTranslated(), '恢复补译后外壳译文应保持');

    await page.screenshot({ path: path.join(ARTIFACTS, 'spa-navigation.png') });

    // 地址已被 history.pushState 改到 /panel-N，后面的用例依赖 /en
    await page.goto(`${baseUrl}/en`);
    await waitFor(async () => page.locator('#p1').isVisible(), { label: '回到测试页', timeout: 20000 });
  });

  log('\n【2.8】整页翻译：长页面分轮推进与单次上限');
  await step('越过旧上限（1500 处）继续翻译，达到 3000 处时提示再点继续', async () => {
    const backup = await readSettings();
    await sw.evaluate(() => chrome.storage.local.remove(['ait_history', 'ait_stats', 'ait_translation_cache']));
    await useMockModel({ pageTranslateLimit: 3000, pageTranslateUnlimited: false });
    try {
      await page.goto(`${baseUrl}/long`);
      await waitFor(async () => page.locator('#l0').isVisible(), { label: '长页面加载', timeout: 20000 });

      await sendToTab(`${baseUrl}/long`, 'RUN_TRANSLATE_PAGE');
      const once = await waitFor(
        async () => {
          const n = await countTranslatedParagraphs();
          return n >= 3000 ? n : null;
        },
        { label: '单次上限内的翻译完成', timeout: 180000 },
      );
      assert(once >= 3000 && once <= 3010, `单次应翻译约 3000 处文本，实际 ${once}`);

      // 旧实现扫满 1500 个节点就停，且再点也不会动；这里必须越过它
      assert(await paragraphTranslated(1500), '越过第 1500 处后应继续翻译（旧实现停在 1500）');
      assert(await paragraphTranslated(2999), '上限内的最后一段应已翻译');
      assert(!(await paragraphTranslated(3100)), `超出上限的段落应留待下一次点击：${await page.textContent('#l3100')}`);

      const toast = (await deepText('.ait-toast')) || '';
      assert(/上限/.test(toast) && /继续/.test(toast), `应提示达到上限并可继续：${toast}`);
      await page.screenshot({ path: path.join(ARTIFACTS, 'page-limit.png') });

      // 再点一次：从断点接着翻完，而不是把已译内容恢复成原文
      await sendToTab(`${baseUrl}/long`, 'RUN_TRANSLATE_PAGE');
      const all = await waitFor(
        async () => {
          const n = await countTranslatedParagraphs();
          return n >= LONG_ITEMS ? n : null;
        },
        { label: '再次点击后翻完整页', timeout: 180000 },
      );
      assert(all >= LONG_ITEMS, `再次点击应翻完整页，实际 ${all}/${LONG_ITEMS}`);
      assert(await paragraphTranslated(LONG_ITEMS - 1), '最后一段应已翻译');
      assert((await page.getAttribute('html', 'data-ait-translated')) === '1', '页面应保持已翻译状态');
    } finally {
      await setSettings(backup);
      await page.goto(`${baseUrl}/en`);
      await waitFor(async () => page.locator('#p1').isVisible(), { label: '回到测试页' });
    }
  });

  await step('打开「不设上限」后一次点击翻完整页', async () => {
    const backup = await readSettings();
    await useMockModel({ pageTranslateUnlimited: true, pageTranslateLimit: 3000 });
    try {
      await page.goto(`${baseUrl}/long`);
      await waitFor(async () => page.locator('#l0').isVisible(), { label: '长页面加载', timeout: 20000 });

      await sendToTab(`${baseUrl}/long`, 'RUN_TRANSLATE_PAGE');
      const all = await waitFor(
        async () => {
          const n = await countTranslatedParagraphs();
          return n >= LONG_ITEMS ? n : null;
        },
        { label: '不设上限时一次翻完', timeout: 240000 },
      );
      assert(all >= LONG_ITEMS, `不设上限应一次翻完整页，实际 ${all}/${LONG_ITEMS}`);
      assert(await paragraphTranslated(LONG_ITEMS - 1), '最后一段应已翻译');
    } finally {
      await setSettings(backup);
      await page.goto(`${baseUrl}/en`);
      await waitFor(async () => page.locator('#p1').isVisible(), { label: '回到测试页' });
    }
  });

  await step('进度条上的「取消」能停下分轮翻译', async () => {
    const backup = await readSettings();
    // 让 mock 变慢，才有机会在翻译途中点取消
    await fetch(`${baseUrl}/mock/delay?ms=500`);
    await sw.evaluate(() => chrome.storage.local.remove('ait_translation_cache'));
    await useMockModel({ pageTranslateUnlimited: true });
    try {
      await page.goto(`${baseUrl}/long`);
      await waitFor(async () => page.locator('#l0').isVisible(), { label: '长页面加载', timeout: 20000 });

      await sendToTab(`${baseUrl}/long`, 'RUN_TRANSLATE_PAGE');
      await waitFor(async () => page.locator('.ait-progress').isVisible(), { label: '进度条出现', timeout: 15000 });

      // 译文按「轮」落地：等第一轮真正落了地，再取消（此时下一轮正在请求中）
      const landed = await waitFor(
        async () => {
          const n = await countTranslatedParagraphs();
          return n >= 1000 ? n : null;
        },
        { label: '第一轮译文落地', timeout: 120000 },
      );
      await page.click('.ait-progress [data-act="cancel"]');

      const toast = await waitFor(
        async () => {
          const t = (await deepText('.ait-toast')) || '';
          return t.includes('已取消翻译') ? t : null;
        },
        { label: '取消提示', timeout: 20000 },
      );
      assert(toast.includes('已取消翻译'), `取消提示异常：${toast}`);
      await waitFor(async () => page.locator('.ait-progress').isHidden(), { label: '进度条收起', timeout: 20000 });

      // 取消后不应再有新译文出现（已翻译的部分保留，不再回滚）
      const stopped = await countTranslatedParagraphs();
      assert(stopped >= landed && stopped < LONG_ITEMS, `取消时应已翻译一部分且未翻完，实际 ${stopped}/${LONG_ITEMS}`);
      await page.waitForTimeout(2500);
      const later = await countTranslatedParagraphs();
      assert(later === stopped, `取消后不应继续翻译：${stopped} → ${later}`);
    } finally {
      await fetch(`${baseUrl}/mock/delay?ms=0`);
      await setSettings(backup);
      await page.goto(`${baseUrl}/en`);
      await waitFor(async () => page.locator('#p1').isVisible(), { label: '回到测试页' });
    }
  });

  log('\n【2.9】站内换页后不残留已卸载节点的记录');
  await step('整块替换页面内容后，已译节点记录被回收（不再只增不减）', async () => {
    const backup = await readSettings();
    await useMockModel({ pageTranslateUnlimited: true, pageTranslateLimit: 3000 });
    await sw.evaluate(() => chrome.storage.local.remove('ait_translation_cache'));
    try {
      await page.goto(`${baseUrl}/long`);
      await waitFor(async () => page.locator('#l0').isVisible(), { label: '长页面加载', timeout: 20000 });
      await sendToTab(`${baseUrl}/long`, 'RUN_TRANSLATE_PAGE');
      await waitFor(
        async () => {
          const s = await readTranslateState(`${baseUrl}/long`);
          return s && s.originals >= LONG_ITEMS ? s : null;
        },
        { label: '整页翻译完成', timeout: 240000 },
      );
      const before = await readTranslateState(`${baseUrl}/long`);
      assert(before.originals >= LONG_ITEMS, `前置条件：应记录 ${LONG_ITEMS} 处已译节点，实际 ${before.originals}`);
      assert(before.detached === 0, `翻译完成后不应有脱离节点，实际 ${before.detached}`);

      // 模拟 SPA 站内换页：整块替换路由内容，旧节点被卸载且不会再回来
      await page.evaluate(() => {
        document.querySelector('#content').innerHTML =
          '<p id="n0">The route changed, so the previous content was removed entirely.</p>' +
          '<p id="n1">Only these short paragraphs should stay tracked afterwards.</p>';
      });

      // 下一次翻译轮次开工时会顺手回收这些残影
      await sendToTab(`${baseUrl}/long`, 'RUN_TRANSLATE_PAGE');
      const after = await waitFor(
        async () => {
          const s = await readTranslateState(`${baseUrl}/long`);
          return s && s.originals <= 10 ? s : null;
        },
        { label: '已卸载节点被回收', timeout: 60000 },
      );
      assert(after.detached === 0, `回收后不应再有脱离节点，实际 ${after.detached}`);
      // 页面仍处于「已翻译」状态（证明是回收而不是走了恢复原文那条路）
      assert(after.active === true, '页面应仍处于已翻译状态');
      assert((await page.getAttribute('html', 'data-ait-translated')) === '1', '页面应保持已翻译标记');
      const n0 = (await page.textContent('#n0')) || '';
      assert(/^【译】/.test(n0.trim()), `换页后的新内容应被翻译：${n0}`);
      const n1 = (await page.textContent('#n1')) || '';
      assert(/^【译】/.test(n1.trim()), `换页后的新内容应被翻译：${n1}`);

      // 稳态：只留下换页后新译的两段，3200 条旧记录已被回收
      const settled = await readTranslateState(`${baseUrl}/long`);
      assert(
        settled.originals > 0 && settled.originals <= 10,
        `稳态应只剩新内容的记录，实际 ${settled.originals}`,
      );
      log(`  ↳ 记录数：${before.originals} → ${settled.originals}（页面只剩 2 段新内容）`);
    } finally {
      await setSettings(backup);
      await page.goto(`${baseUrl}/en`);
      await waitFor(async () => page.locator('#p1').isVisible(), { label: '回到测试页' });
    }
  });

  log('\n【3】划词翻译');
  await page.reload();
  await waitFor(async () => page.locator('#p2').isVisible(), { label: '页面重载' });

  await step('选中文字后出现翻译按钮，点击得到译文', async () => {
    assert(await page.locator('.ait-selbtn').isHidden(), '未选中文字时不应显示翻译按钮');
    assert(await page.locator('.ait-card').isHidden(), '未触发时不应显示翻译卡片');
    await page.evaluate(() => {
      const node = document.getElementById('p2');
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
    });
    const btn = page.locator('.ait-selbtn');
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    await btn.click();
    const text = await waitFor(
      async () => {
        const state = await page.getAttribute('.ait-card .ait-body', 'data-state');
        if (state !== 'done') return null;
        return deepText('.ait-card .ait-body');
      },
      { label: '划词译文', timeout: 60000 },
    );
    assert(countCJK(text) >= 3, `划词译文异常：${text}`);
    assert(await page.locator('.ait-card').isVisible(), '翻译卡片未显示');
    await page.screenshot({ path: path.join(ARTIFACTS, 'selection.png') });
    await page.keyboard.press('Escape');
    await waitFor(async () => page.locator('.ait-card').isHidden(), { label: '卡片关闭', timeout: 8000 });
  });

  await step('开启「划词后自动翻译」后无需再点按钮', async () => {
    await setSettings({ autoTranslateSelection: true });
    await page.reload();
    await waitFor(async () => page.locator('#p3').isVisible(), { label: '页面重载' });
    await page.evaluate(() => {
      const node = document.getElementById('p3');
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
    });
    const text = await waitFor(
      async () => {
        const state = await page.getAttribute('.ait-card .ait-body', 'data-state').catch(() => null);
        if (state !== 'done') return null;
        return deepText('.ait-card .ait-body');
      },
      { label: '自动划词翻译', timeout: 60000 },
    );
    assert(countCJK(text) >= 3, `自动划词译文异常：${text}`);
    assert(await page.locator('.ait-selbtn').isHidden(), '自动模式下不应出现翻译按钮');
    await page.keyboard.press('Escape');
    await setSettings({ autoTranslateSelection: false });
  });

  log('\n【4】网页总结');
  await step('生成结构化中文总结面板', async () => {
    const res = await sendToTab(`${baseUrl}/en`, 'RUN_SUMMARIZE_PAGE');
    assert(res.ok, `命令下发失败：${res.message}`);
    const panel = page.locator('.ait-panel');
    await panel.waitFor({ state: 'visible', timeout: 15000 });
    const text = await waitFor(
      async () => {
        const state = await page.getAttribute('.ait-panel .ait-body', 'data-state');
        if (state !== 'done') return null;
        return deepText('.ait-panel .ait-body');
      },
      { label: '总结内容', timeout: 90000 },
    );
    assert(countCJK(text) > 60, `总结过短：${text}`);
    const listCount = await page.locator('.ait-panel .ait-li').count();
    assert(listCount >= 3, `缺少要点列表，li=${listCount}`);
    await page.screenshot({ path: path.join(ARTIFACTS, 'summary.png') });
    await page.keyboard.press('Escape');
  });

  log('\n【5】异常与边界');
  await step('未配置 API Key 时给出明确提示', async () => {
    const backup = await readSettings();
    await setSettings({ apiKey: '' });
    await page.reload();
    await waitFor(async () => page.locator('#p1').isVisible(), { label: '页面重载' });
    await sendToTab(`${baseUrl}/en`, 'RUN_TRANSLATE_PAGE');
    const toast = await waitFor(
      async () => {
        const t = await deepText('.ait-toast');
        return t && t.includes('API Key') ? t : null;
      },
      { label: '配置错误提示', timeout: 20000 },
    );
    assert(toast.includes('API Key'), `提示内容异常：${toast}`);
    await setSettings({ apiKey: backup.apiKey });
  });

  await step('划词翻译：中文 -> 英文（auto 反向）', async () => {
    await page.goto(`${baseUrl}/zh`);
    await waitFor(async () => page.locator('#z1').isVisible(), { label: '中文页面加载' });
    await page.evaluate(() => {
      const node = document.getElementById('z1');
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
    });
    const btn = page.locator('.ait-selbtn');
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    await btn.click();
    const text = await waitFor(
      async () => {
        const state = await page.getAttribute('.ait-card .ait-body', 'data-state');
        if (state !== 'done') return null;
        const t = await deepText('.ait-card .ait-body');
        return t && /[A-Za-z]{4,}/.test(t) && countCJK(t) < 3 ? t : null;
      },
      { label: '中文->英文译文', timeout: 60000 },
    );
    assert(/[A-Za-z]{4,}/.test(text), `译文异常：${text}`);
    await page.screenshot({ path: path.join(ARTIFACTS, 'selection-zh-to-en.png') });
  });

  /* -------------------------------------------------------------- */

  log('\n【6】popup 按钮 -> 后台 -> 内容脚本全链路');
  await step('点击 popup「翻译整个页面」按钮驱动当前页面', async () => {
    await page.goto(`${baseUrl}/en`);
    await waitFor(async () => page.locator('#p1').isVisible(), { label: '页面加载' });

    // 打开 popup 页面（模拟点击扩展图标），再把测试页设为活动标签
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await popup.waitForSelector('.action[data-action="translate-page"]');
    await sw.evaluate(async (prefix) => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((t) => (t.url || '').startsWith(prefix));
      if (target) await chrome.tabs.update(target.id, { active: true });
    }, `${baseUrl}/en`);

    await popup.click('.action[data-action="translate-page"]');
    await waitFor(
      async () => {
        const text = await page.textContent('#p1');
        return countCJK(text) >= 5 ? text : null;
      },
      { label: '通过 popup 按钮触发的翻译', timeout: 60000 },
    );
    await page.screenshot({ path: path.join(ARTIFACTS, 'popup-driven.png') });
    await popup.close().catch(() => {});
  });

  log('\n【6.5】入口与权限（弹窗划词按钮 / 内容脚本鉴权 / 受限页面）');
  const popupUrl = `chrome-extension://${extensionId}/src/popup/popup.html`;

  await step('popup「翻译选中文本」按钮能驱动当前页面的选区翻译', async () => {
    await page.goto(`${baseUrl}/en`);
    await waitFor(async () => page.locator('#p2').isVisible(), { label: '页面加载' });
    // 只做选区，不派发 mouseup：确保译文卡片是由 popup 按钮触发的，而不是划词悬浮按钮
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('p2'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    assert(await page.locator('.ait-card').isHidden(), '触发前不应有翻译卡片');

    const popup = await ctx.newPage();
    await popup.goto(popupUrl);
    await popup.waitForSelector('.action[data-action="translate-selection"]');
    await sw.evaluate(async (prefix) => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((t) => (t.url || '').startsWith(prefix));
      if (target) await chrome.tabs.update(target.id, { active: true });
    }, `${baseUrl}/en`);

    await popup.click('.action[data-action="translate-selection"]', { noWaitAfter: true });
    const text = await waitFor(
      async () => {
        const state = await page.getAttribute('.ait-card .ait-body', 'data-state').catch(() => null);
        if (state !== 'done') return null;
        return deepText('.ait-card .ait-body');
      },
      { label: '弹窗按钮触发的划词译文', timeout: 60000 },
    );
    assert(countCJK(text) >= 3, `译文异常：${text}`);
    await page.keyboard.press('Escape');
    await popup.close().catch(() => {});
  });

  await step('内容脚本拿不到 API Key，也调不动改配置 / 测连接 / 清缓存等特权操作', async () => {
    await page.goto(`${baseUrl}/en`);
    await waitFor(async () => page.locator('#p1').isVisible(), { label: '页面加载' });
    const before = await readSettings();

    const probe = await evalInContentScript(
      page,
      `(async () => {
        const send = (m) => chrome.runtime.sendMessage(m);
        return {
          get: await send({ type: 'GET_SETTINGS' }),
          save: await send({ type: 'SAVE_SETTINGS', settings: { targetLang: 'ja', baseUrl: 'https://attacker.example' } }),
          reset: await send({ type: 'RESET_SETTINGS' }),
          test: await send({ type: 'TEST_CONNECTION', settings: { baseUrl: 'https://attacker.example' } }),
          clear: await send({ type: 'CLEAR_CACHE' }),
          stats: await send({ type: 'GET_CACHE_STATS' }),
          run: await send({ type: 'RUN_ON_TAB', tabId: 1, command: 'CMD_TRANSLATE_PAGE' }),
        };
      })()`,
    );

    // 读设置：能读到（内容脚本要用语言、模式等），但 Key 必须是空的
    assert(probe.get?.ok === true, '内容脚本应能读取（脱敏后的）设置');
    assert(probe.get.settings.apiKey === '', `内容脚本不应拿到 API Key，实际：${JSON.stringify(probe.get.settings.apiKey)}`);
    assert(!JSON.stringify(probe).includes(API.apiKey), '内容脚本收到的任何响应里都不应出现 API Key');
    assert(probe.get.settings.targetLang === before.targetLang, '脱敏不应改动其它设置项');

    // 特权操作：全部被拒
    for (const name of ['save', 'reset', 'test', 'clear', 'stats', 'run']) {
      assert(
        probe[name]?.ok === false && probe[name]?.code === 'FORBIDDEN',
        `内容脚本不应能执行 ${name}：${JSON.stringify(probe[name])}`,
      );
    }

    // 被拒之后存储里的配置必须原封不动
    const after = await readSettings();
    assert(after.apiKey === before.apiKey, 'API Key 被改动');
    assert(after.baseUrl === before.baseUrl, `baseUrl 被改动：${after.baseUrl}`);
    assert(after.targetLang === before.targetLang, `targetLang 被改动：${after.targetLang}`);

    // 对照：扩展自己的页面读到的是完整设置
    const popup = await ctx.newPage();
    await popup.goto(popupUrl);
    const full = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }));
    assert(full?.ok && full.settings.apiKey === API.apiKey, '扩展页面应能读到完整设置');
    await popup.close().catch(() => {});
  });

  await step('受限页面与非法命令：弹窗得到明确反馈，而不是静默失败', async () => {
    const popup = await ctx.newPage();
    await popup.goto(popupUrl);
    // 受限页面：扩展无权注入内容脚本。无头浏览器里 Playwright 打不开 chrome:// 内置页，
    // 改用 data: 页面——它不在 <all_urls> 的覆盖范围内，同样会被 scripting.executeScript 拒绝
    const restricted = await ctx.newPage();
    await restricted.goto('data:text/html,<title>restricted</title><h1>restricted page</h1>');
    await restricted.bringToFront();
    // 没有主机权限的页面，tab.url 会被浏览器隐藏，没法按地址找；它是活动标签页，直接取活动标签
    const tabId = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id ?? null;
    });
    assert(tabId, '未能取得受限页面的标签 ID');

    const res = await popup.evaluate(
      (id) => chrome.runtime.sendMessage({ type: 'RUN_ON_TAB', tabId: id, command: 'RUN_TRANSLATE_PAGE' }),
      tabId,
    );
    assert(res?.ok === false && /不支持/.test(res.message || ''), `受限页面应返回明确提示：${JSON.stringify(res)}`);

    // 白名单之外的命令不得经由后台透传给标签页
    const bad = await popup.evaluate(
      (id) => chrome.runtime.sendMessage({ type: 'RUN_ON_TAB', tabId: id, command: 'GET_STATE' }),
      tabId,
    );
    assert(bad?.ok === false && bad?.code === 'BAD_REQUEST', `非法命令应被拒绝：${JSON.stringify(bad)}`);

    await restricted.close().catch(() => {});
    await popup.close().catch(() => {});
  });

  log('\n【7】管理面板（配置 / 语言 / 历史 / Token 统计）');
  let optionsPage;

  await step('打开管理面板并完成首屏渲染', async () => {
    // 翻译记录与用量统计是两份独立数据，这里都重置，让后面的面板断言从同一基线开始
    await sw.evaluate(() => chrome.storage.local.remove(['ait_history', 'ait_stats']));
    optionsPage = await ctx.newPage();
    optionsPage.on('dialog', (dialog) => dialog.accept());
    await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    await optionsPage.waitForSelector('.nav-item[data-view="dashboard"]');

    const navCount = await optionsPage.locator('.nav-item').count();
    assert(navCount === 4, `导航项数量异常：${navCount}`);
    const stats = await optionsPage.locator('.stat').count();
    assert(stats === 4, `统计卡片数量异常：${stats}`);
    assert((await optionsPage.locator('.chart-col').count()) === 14, '趋势图应渲染 14 天');
    const conn = await optionsPage.textContent('#connStatus');
    assert(conn.includes('已配置'), `连接状态异常：${conn}`);

    await optionsPage.click('.nav-item[data-view="history"]');
    assert(await optionsPage.locator('#historyList .empty').isVisible(), '空历史应显示空状态');
    await optionsPage.click('.nav-item[data-view="dashboard"]');
  });

  await step('管理面板可切换源语言与目标语言并写回配置', async () => {
    await optionsPage.click('.nav-item[data-view="language"]');
    await optionsPage.waitForSelector('#sourceLang');
    const langOptions = await optionsPage.locator('#sourceLang option').count();
    assert(langOptions >= 8, `语言选项异常：${langOptions}`);

    await optionsPage.selectOption('#sourceLang', 'en');
    await optionsPage.selectOption('#targetLang', 'ja');
    await waitFor(
      async () => {
        const s = await readSettings();
        return s?.sourceLang === 'en' && s?.targetLang === 'ja';
      },
      { label: '语言设置写入 storage', timeout: 10000 },
    );
    const hint = await optionsPage.textContent('#langHint');
    assert(hint.includes('English') && hint.includes('日本語'), `语言提示异常：${hint}`);

    await optionsPage.click('#swapLang');
    await waitFor(
      async () => {
        const s = await readSettings();
        return s?.sourceLang === 'ja' && s?.targetLang === 'en';
      },
      { label: '交换语言', timeout: 10000 },
    );

    await optionsPage.click('.chip[data-pair="en|zh"]');
    await waitFor(
      async () => {
        const s = await readSettings();
        return s?.sourceLang === 'en' && s?.targetLang === 'zh';
      },
      { label: '常用语言组合', timeout: 10000 },
    );
    await optionsPage.screenshot({ path: path.join(ARTIFACTS, 'options-language.png') });
  });

  await step('管理面板可开关持续翻译', async () => {
    await optionsPage.click('.nav-item[data-view="language"]');
    const toggle = optionsPage.locator('#autoTranslateDynamic');
    // 自定义样式的开关：input 被 .track 覆盖，点击需要落在包裹它的 label 上
    const label = optionsPage.locator('label.switch:has(#autoTranslateDynamic)');
    assert(await toggle.isVisible(), '持续翻译开关应可见');
    assert(await toggle.isChecked(), '持续翻译默认应为开启');

    await label.click();
    await waitFor(async () => (await readSettings())?.autoTranslateDynamic === false, {
      label: '持续翻译关闭写入 storage',
      timeout: 10000,
    });
    assert(!(await toggle.isChecked()), '开关应切换到关闭');

    await label.click();
    await waitFor(async () => (await readSettings())?.autoTranslateDynamic === true, {
      label: '持续翻译开启写入 storage',
      timeout: 10000,
    });
    assert(await toggle.isChecked(), '开关应切回开启');
  });

  await step('管理面板可开关翻译缓存并清空', async () => {
    await optionsPage.click('.nav-item[data-view="language"]');
    const cacheToggle = optionsPage.locator('#cacheEnabled');
    const cacheLabel = optionsPage.locator('label.switch:has(#cacheEnabled)');
    assert(await cacheToggle.isChecked(), '翻译缓存默认应为开启');

    await cacheLabel.click();
    await waitFor(async () => (await readSettings())?.cacheEnabled === false, {
      label: '缓存开关关闭写入 storage',
      timeout: 10000,
    });
    await cacheLabel.click();
    await waitFor(async () => (await readSettings())?.cacheEnabled === true, {
      label: '缓存开关回到开启',
      timeout: 10000,
    });

    const stats = await optionsPage.textContent('#cacheStats');
    assert(stats && stats.length > 0, '缓存占用应展示出来');

    // 清空按钮带确认框；对话框处理器已在【7】初始化时统一接管
    await optionsPage.click('#clearCache');
    await waitFor(
      async () => {
        const text = await optionsPage.textContent('#cacheStats');
        return text?.includes('缓存为空') ? text : null;
      },
      { label: '缓存已清空', timeout: 10000 },
    );
  });

  await step('管理面板可设置整页翻译上限与「不设上限」开关', async () => {
    await optionsPage.click('.nav-item[data-view="language"]');
    const limitInput = optionsPage.locator('#pageTranslateLimit');
    const unlimited = optionsPage.locator('#pageTranslateUnlimited');
    const label = optionsPage.locator('label.switch:has(#pageTranslateUnlimited)');

    const initial = await limitInput.inputValue();
    assert(Number(initial) === 3000, `默认上限应为 3000，实际 ${initial}`);
    assert(!(await unlimited.isChecked()), '「不设上限」默认应关闭');
    assert(!(await limitInput.isDisabled()), '默认状态下上限应可编辑');

    await limitInput.fill('1200');
    await limitInput.blur();
    await waitFor(async () => (await readSettings())?.pageTranslateLimit === 1200, {
      label: '上限写入 storage',
      timeout: 10000,
    });

    await label.click();
    await waitFor(async () => (await readSettings())?.pageTranslateUnlimited === true, {
      label: '「不设上限」写入 storage',
      timeout: 10000,
    });
    assert(await limitInput.isDisabled(), '打开「不设上限」后上限输入框应禁用');
    const unlimitedHint = await optionsPage.textContent('#pageLimitHint');
    assert(unlimitedHint.includes('关闭上限'), `提示文案异常：${unlimitedHint}`);

    // 复位，避免影响后续用例
    await label.click();
    await waitFor(async () => (await readSettings())?.pageTranslateUnlimited === false, {
      label: '关闭「不设上限」',
      timeout: 10000,
    });
    assert(!(await limitInput.isDisabled()), '关闭「不设上限」后上限输入框应恢复可编辑');
    await limitInput.fill('3000');
    await limitInput.blur();
    await waitFor(async () => (await readSettings())?.pageTranslateLimit === 3000, {
      label: '上限复位',
      timeout: 10000,
    });
    await optionsPage.screenshot({ path: path.join(ARTIFACTS, 'options-page-limit.png') });
  });

  await step('管理面板可测试 API 连接', async () => {
    await optionsPage.click('.nav-item[data-view="api"]');
    await optionsPage.waitForSelector('#testBtn');
    await optionsPage.click('#testBtn');
    const text = await waitFor(
      async () => {
        const t = (await optionsPage.textContent('#testResult')) || '';
        return t.includes('连接成功') || t.includes('失败') ? t : null;
      },
      { label: '管理面板连接测试', timeout: 40000 },
    );
    assert(text.includes('连接成功'), `测试连接失败：${text}`);
    await optionsPage.screenshot({ path: path.join(ARTIFACTS, 'options-api.png') });
  });

  await step('翻译后历史记录自动出现（无需刷新面板）', async () => {
    await page.goto(`${baseUrl}/en`);
    await waitFor(async () => page.locator('#p1').isVisible(), { label: '测试页面加载' });
    await page.evaluate(() => {
      const node = document.getElementById('p1');
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
    });
    const btn = page.locator('.ait-selbtn');
    await btn.waitFor({ state: 'visible', timeout: 10000 });
    await btn.click();
    await waitFor(
      async () => (await page.getAttribute('.ait-card .ait-body', 'data-state')) === 'done',
      { label: '划词翻译完成', timeout: 60000 },
    );

    await optionsPage.click('.nav-item[data-view="history"]');
    await optionsPage.waitForSelector('.history-item', { timeout: 15000 });
    const count = await optionsPage.locator('.history-item').count();
    assert(count === 1, `历史记录数量应为 1，实际 ${count}`);

    const itemText = await optionsPage.textContent('.history-item');
    assert(itemText.includes('划词翻译'), `记录类型异常：${itemText}`);
    assert(/Token/.test(itemText), '记录应展示 Token 消耗');
    const badge = await optionsPage.textContent('#historyBadge');
    assert(badge.trim() === '1', `侧边栏徽标异常：${badge}`);
    await optionsPage.screenshot({ path: path.join(ARTIFACTS, 'options-history.png') });
  });

  await step('Token 统计随使用情况更新', async () => {
    await optionsPage.click('.nav-item[data-view="dashboard"]');
    await waitFor(
      async () => {
        const text = await optionsPage.textContent('#statGrid');
        return /总 Token/.test(text) ? text : null;
      },
      { label: '统计数据渲染', timeout: 10000 },
    );
    const values = await optionsPage.locator('.stat .stat-value').allTextContents();
    assert(values[0] === '1', `调用次数应为 1，实际「${values[0]}」`);
    assert(values[1] !== '0', `总 Token 应大于 0，实际「${values[1]}」`);

    const bars = await optionsPage.locator('.chart-col').count();
    assert(bars === 14, `趋势图应有 14 天，实际 ${bars}`);
    const today = await optionsPage.locator('.chart-col:last-child').getAttribute('title');
    assert(/\d+ Token/.test(today), `今日柱状图信息异常：${today}`);
    assert(/[1-9]/.test(today), `今日应统计到 Token：${today}`);
    const todayBar = await optionsPage.locator('.chart-col:last-child').getAttribute('class');
    assert(!todayBar.includes('is-empty'), '今日应有 Token 消耗记录');

    const kindText = await optionsPage.textContent('#kindDist');
    assert(kindText.includes('划词翻译'), `功能分布异常：${kindText}`);
    await optionsPage.screenshot({ path: path.join(ARTIFACTS, 'options-dashboard.png') });
  });

  await step('历史筛选、搜索与删除', async () => {
    await optionsPage.click('.nav-item[data-view="history"]');
    await optionsPage.selectOption('#historyKind', 'summary');
    assert(await optionsPage.locator('#historyList .empty').isVisible(), '筛选为「网页总结」时应为空');

    await optionsPage.selectOption('#historyKind', 'all');
    await optionsPage.fill('#historySearch', '不可能出现的字符串xyz');
    assert(await optionsPage.locator('#historyList .empty').isVisible(), '搜索无结果时应为空');
    await optionsPage.fill('#historySearch', '');
    await optionsPage.waitForSelector('.history-item');

    await optionsPage.click('.history-item [data-action="delete"]');
    await waitFor(
      async () => (await optionsPage.locator('.history-item').count()) === 0,
      { label: '删除记录', timeout: 10000 },
    );
    const stored = await sw.evaluate(async () => (await chrome.storage.local.get('ait_history')).ait_history?.length ?? 0);
    assert(stored === 0, `storage 中应已清空，实际 ${stored}`);
  });

  await step('历史记录的来源链接只放行 http(s)，javascript: 之类的不会变成可点击链接', async () => {
    const mk = (id, url) => ({
      id,
      ts: Date.now(),
      kind: 'page',
      model: 'mock',
      sourceLang: 'en',
      targetLang: 'zh',
      itemCount: 1,
      inputChars: 3,
      outputChars: 2,
      durationMs: 10,
      tokens: { prompt: 1, completion: 1, total: 2 },
      url,
      title: id,
      sourcePreview: 'src',
      resultPreview: 'dst',
    });
    await sw.evaluate(
      (entries) => chrome.storage.local.set({ ait_history: entries }),
      [
        mk('h-evil-js', 'javascript:alert(document.domain)'),
        mk('h-evil-data', 'data:text/html,<script>alert(1)</script>'),
        mk('h-good', 'https://example.com/a?x=1&y=2'),
      ],
    );
    await optionsPage.click('.nav-item[data-view="history"]');
    await waitFor(async () => (await optionsPage.locator('.history-item').count()) === 3, {
      label: '三条构造的历史记录渲染',
      timeout: 10000,
    });
    const hrefs = await optionsPage.$$eval('.history-item a.link', (as) => as.map((a) => a.getAttribute('href')));
    assert(hrefs.length === 1, `只应保留 1 个安全链接，实际 ${JSON.stringify(hrefs)}`);
    assert(hrefs[0] === 'https://example.com/a?x=1&y=2', `安全链接被改写：${hrefs[0]}`);
    const rel = await optionsPage.getAttribute('.history-item a.link', 'rel');
    assert(/noopener/.test(rel || '') && /noreferrer/.test(rel || ''), `外链缺少 rel 保护：${rel}`);
    await sw.evaluate(() => chrome.storage.local.set({ ait_history: [] }));
    await waitFor(async () => (await optionsPage.locator('.history-item').count()) === 0, {
      label: '清理构造记录',
      timeout: 10000,
    });
  });

  await step('两个界面各改各的设置，互不覆盖（只提交改动字段）', async () => {
    await optionsPage.click('.nav-item[data-view="language"]');
    await optionsPage.waitForSelector('#pageMode');
    const before = await readSettings();

    // 模拟「另一个界面（如弹窗）」刚改了目标语言；本页表单还停留在旧值
    await setSettings({ targetLang: 'ko', sourceLang: 'auto' });
    // 本页只改页面翻译方式——旧实现会把整份旧设置写回，目标语言被还原
    await optionsPage.selectOption('#pageMode', 'bilingual');
    await waitFor(async () => (await readSettings())?.pageMode === 'bilingual', {
      label: '页面翻译方式写入',
      timeout: 10000,
    });
    const after = await readSettings();
    assert(after.targetLang === 'ko', `另一界面的改动被覆盖：targetLang=${after.targetLang}`);

    // 本页表单也会同步到外部改动
    await waitFor(async () => (await optionsPage.inputValue('#targetLang')) === 'ko', {
      label: '表单同步外部改动',
      timeout: 10000,
    });

    // 复位
    await setSettings({ targetLang: before.targetLang, sourceLang: before.sourceLang, pageMode: before.pageMode });
    await waitFor(async () => (await optionsPage.inputValue('#pageMode')) === before.pageMode, {
      label: '表单复位',
      timeout: 10000,
    });
  });

  await step('popup 里刚填的配置在失焦时立刻落盘（不用等 400ms 防抖）', async () => {
    const popup = await ctx.newPage();
    await popup.goto(popupUrl);
    await popup.click('.tab[data-tab="settings"]');
    const original = (await readSettings()).model;

    await popup.fill('#model', 'flush-test-model');
    const started = Date.now();
    await popup.locator('#model').blur();
    await waitFor(async () => (await readSettings())?.model === 'flush-test-model', {
      label: '失焦后立即写入',
      timeout: 5000,
      interval: 20,
    });
    const elapsed = Date.now() - started;
    assert(elapsed < 350, `失焦后应立即保存，实际用了 ${elapsed}ms（防抖是 400ms）`);

    await popup.fill('#model', original);
    await popup.locator('#model').blur();
    await waitFor(async () => (await readSettings())?.model === original, { label: '复位模型名', timeout: 5000 });
    await popup.close().catch(() => {});
  });

  await step('导航高亮与当前视图保持一致', async () => {
    for (const name of ['dashboard', 'history', 'language', 'api']) {
      await optionsPage.click(`.nav-item[data-view="${name}"]`);
      await optionsPage.waitForTimeout(220);
      const activeView = await optionsPage.locator('.view.is-active').getAttribute('data-view');
      assert(activeView === name, `内容区应显示 ${name}，实际 ${activeView}`);
      const activeNav = await optionsPage.locator('.nav-item.is-active').getAttribute('data-view');
      assert(activeNav === name, `侧边栏高亮应为 ${name}，实际 ${activeNav}`);
      const highlighted = await optionsPage.locator('.nav-item.is-active').count();
      assert(highlighted === 1, `高亮项应唯一，实际 ${highlighted}`);
    }
  });

  await step('popup 语言切换与管理面板入口', async () => {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await popup.waitForSelector('#sourceLang', { state: 'visible' });
    await popup.selectOption('#sourceLang', 'zh');
    await waitFor(
      async () => (await readSettings())?.sourceLang === 'zh',
      { label: 'popup 源语言写入', timeout: 10000 },
    );
    await popup.selectOption('#sourceLang', 'auto');
    await popup.selectOption('#targetLang', 'auto');

    assert(await popup.locator('#openOptions').isVisible(), 'popup 应有管理面板入口');
    // openOptionsPage 会复用已打开的管理面板标签页，这里先关闭以便验证新开页面
    await optionsPage.close().catch(() => {});
    const [opened] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 15000 }),
      popup.click('#openOptions', { noWaitAfter: true }),
    ]);
    await opened.waitForLoadState('domcontentloaded');
    assert(opened.url().includes('/src/options/options.html'), `应打开管理面板，实际 ${opened.url()}`);
    await opened.waitForSelector('.nav-item[data-view="dashboard"]');
    await opened.close().catch(() => {});
    await popup.close().catch(() => {});
  });

  const failed = results.filter((r) => !r.ok);
  log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    log('失败用例：');
    for (const f of failed) log(`  - ${f.name}: ${f.error?.message || f.error}`);
  }
  log(`截图目录：${ARTIFACTS}\n`);
  return failed.length === 0;
}

let success = false;
try {
  success = await main();
} catch (err) {
  log(`\n致命错误：${err?.stack || err}`);
} finally {
  await ctx?.close().catch(() => {});
  await new Promise((resolve) => {
    if (!server?.listening) return resolve();
    server.close(() => resolve());
  });
}
process.exit(success ? 0 : 1);
