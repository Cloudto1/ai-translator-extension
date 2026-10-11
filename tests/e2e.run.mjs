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

const API = {
  apiKey: process.env.AIT_API_KEY || 'sk-f2f79ea7182f4773a8ca58e767025f6c',
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

const ZH_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>人工智能的未来</title></head><body>
<h1>人工智能的未来</h1>
<p id="z1">人工智能正在改变我们的工作和生活方式。</p>
<p id="z2">大语言模型现在可以总结文档、翻译语言以及编写代码。</p>
<p id="z3">研究人员表示，这项技术在未来十年仍会快速进步，但他们也提醒要注意幻觉和隐私风险。</p>
</body></html>`;

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

function countCJK(text) {
  return (String(text || '').match(/[\u4e00-\u9fff]/g) || []).length;
}

let sw;

/* ---------------------------------------------------------------- */

async function main() {
  log('\n=== AI 翻译助手 · Edge 端到端测试 ===\n');

  // 本地测试站点
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url?.startsWith('/zh')) res.end(ZH_PAGE);
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
