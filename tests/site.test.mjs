// 官网（docs/）验收：加载、布局、交互、图标、可访问性。
// 运行：npm run test:site（需要本机安装 Edge，与 e2e 一致）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
const URL_ = pathToFileURL(path.join(docs, 'index.html')).href;

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge' }); });
after(async () => { await browser?.close(); });

async function open(opts = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    ...opts,
  });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url()));
  await page.goto(URL_);
  return { page, context, problems };
}

test('页面加载无报错、无失败请求，标题与图标就位', async () => {
  const { page, context, problems } = await open();
  assert.match(await page.title(), /AI 翻译助手/);
  const broken = await page.evaluate(() =>
    [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src));
  assert.deepEqual(broken, [], '存在加载失败的图片');
  assert.deepEqual(problems, []);
  await context.close();
});

test('图标精灵：每个 <use> 引用的符号都存在', async () => {
  const { page, context } = await open();
  const missing = await page.evaluate(() => {
    const ids = new Set([...document.querySelectorAll('symbol')].map((s) => s.id));
    return [...document.querySelectorAll('use')]
      .map((u) => u.getAttribute('href').replace('#', ''))
      .filter((id) => !ids.has(id));
  });
  assert.deepEqual(missing, []);
  await context.close();
});

test('锚点导航：所有 #hash 链接都指向存在的元素', async () => {
  const { page, context } = await open();
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll('a[href^="#"]')]
      .map((a) => a.getAttribute('href'))
      .filter((h) => h.length > 1 && !document.querySelector(h)));
  assert.deepEqual(bad, []);
  await context.close();
});

for (const w of [360, 390, 768, 1024, 1440]) {
  test(`${w}px 宽：无横向溢出`, async () => {
    const { page, context } = await open({ viewport: { width: w, height: 900 } });
    const r = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      offenders: [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1
          && getComputedStyle(el).position !== 'fixed' && !el.closest('.icon-sprite'))
        .slice(0, 5)
        .map((el) => el.tagName + '.' + el.className),
    }));
    assert.ok(r.sw <= r.cw, `scrollWidth ${r.sw} > clientWidth ${r.cw}；${r.offenders.join(', ')}`);
    await context.close();
  });
}

for (const w of [360, 768, 1024, 1440]) {
  test(`${w}px 宽：克隆命令完整可见，不被省略号截断`, async () => {
    const { page, context } = await open({ viewport: { width: w, height: 900 } });
    const r = await page.locator('#clone-cmd').evaluate((el) => ({
      sw: el.scrollWidth, cw: el.clientWidth, h: el.getBoundingClientRect().height,
    }));
    assert.ok(r.sw <= r.cw + 1, `命令被截断：scrollWidth ${r.sw} > clientWidth ${r.cw}`);
    await context.close();
  });
}

test('阅读器演示：原文 / 双语 / 仅译文三种模式切换正确，aria-pressed 同步', async () => {
  const { page, context } = await open();
  const reader = page.locator('[data-demo="page"]');
  const src = reader.locator('.pair .s');
  const dst = reader.locator('.pair .t');
  const n = await src.count();
  assert.ok(n >= 3 && n === await dst.count(), '每段原文都应有对应译文');

  const expect = { source: [n, 0], bilingual: [n, n], target: [0, n] };
  for (const mode of ['source', 'target', 'bilingual']) {
    await page.click(`[data-mode="${mode}"]`);
    assert.equal(await reader.getAttribute('data-view'), mode);
    const shown = [await reader.locator('.pair .s:visible').count(), await reader.locator('.pair .t:visible').count()];
    assert.deepEqual(shown, expect[mode], `「${mode}」模式显示数量不对`);
    const pressed = await reader.locator('[data-mode]').evaluateAll((els) =>
      els.filter((e) => e.getAttribute('aria-pressed') === 'true').map((e) => e.dataset.mode));
    assert.deepEqual(pressed, [mode]);
  }
  await context.close();
});

test('常见问题：可展开与收起', async () => {
  const { page, context } = await open();
  const first = page.locator('#faq details').first();
  assert.equal(await first.locator('p').isVisible(), false);
  await first.locator('summary').click();
  assert.equal(await first.locator('p').isVisible(), true);
  await first.locator('summary').click();
  assert.equal(await first.locator('p').isVisible(), false);
  await context.close();
});

test('首屏在桌面端两栏、手机端单栏，演示不被裁切', async () => {
  for (const [w, cols] of [[1440, 2], [390, 1]]) {
    const { page, context } = await open({ viewport: { width: w, height: 900 } });
    const n = await page.locator('.hero__inner').evaluate((el) =>
      getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.equal(n, cols, `${w}px 下首屏应为 ${cols} 栏`);
    const r = await page.locator('.reader').boundingBox();
    assert.ok(r.x >= 0 && r.x + r.width <= w, `${w}px 下阅读器超出视口`);
    await context.close();
  }
});

test('复制克隆命令：写入完整命令、按钮与状态文案变化后自动复位', async () => {
  const { page, context } = await open();
  const cmd = (await page.locator('#clone-cmd').innerText()).trim();
  assert.equal(cmd, 'git clone https://github.com/Cloudto1/ai-translator-extension.git');
  await page.click('[data-copy]');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), cmd);
  assert.equal(await page.locator('[data-copy-label]').innerText(), '已复制');
  assert.match(await page.locator('[data-copy-status]').innerText(), /已复制/);
  await page.waitForTimeout(2500);
  assert.equal(await page.locator('[data-copy-label]').innerText(), '复制');
  assert.match(await page.locator('[data-copy-status]').innerText(), /下载 ZIP/);
  await context.close();
});

test('复制失败时给出可见提示而不是静默', async () => {
  const { page, context } = await open({ permissions: [] });
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) } });
    document.execCommand = () => false;
  });
  await page.click('[data-copy]');
  await page.waitForTimeout(100);
  assert.match(await page.locator('[data-copy-status]').innerText(), /复制失败/);
  await context.close();
});

test('移动端导航：可开合、Esc 关闭、点击链接后收起', async () => {
  const { page, context } = await open({ viewport: { width: 390, height: 844 } });
  const toggle = page.locator('[data-nav-toggle]');
  const nav = page.locator('#nav');
  assert.equal(await nav.isVisible(), false);
  await toggle.click();
  assert.equal(await nav.isVisible(), true);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await nav.isVisible(), false);
  await toggle.click();
  await nav.locator('a[href="#install"]').click();
  assert.equal(await nav.isVisible(), false);
  await context.close();
});

test('键盘可达：首个 Tab 到跳转链接，交互控件聚焦时有 ≥2px 焦点环', async () => {
  const { page, context } = await open();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'skip-link');
  for (const sel of ['[data-mode="target"]', '[data-copy]', '#faq summary']) {
    await page.locator(sel).first().focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement);
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    assert.ok(ring.style !== 'none' && ring.width >= 2, `${sel} 聚焦时应有 ≥2px 焦点环`);
  }
  await context.close();
});

// ---------- 对比度（WCAG）----------
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

test('关键色对对比度：正文 ≥ 4.5:1', async () => {
  const css = await readFile(path.join(docs, 'styles.css'), 'utf8');
  const tok = (name) => css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))[1];
  const pairs = [
    ['text', 'bg'], ['muted', 'bg'], ['muted', 'bg-alt'], ['muted', 'surface'],
    ['brand', 'bg'], ['ink', 'surface'], ['ok', 'bg'], ['ok', 'surface'],
    ['on-brand', 'brand'], ['on-brand', 'brand-hover'],
  ];
  for (const [fg, bg] of pairs) {
    const r = ratio(tok(fg), tok(bg));
    assert.ok(r >= 4.5, `--${fg} 对 --${bg} 只有 ${r.toFixed(2)}:1`);
  }
});

test('实际渲染：关键文字与它真正所在的背景对比度 ≥ 4.5:1', async () => {
  const { page, context } = await open();
  const samples = await page.evaluate(() => {
    const hex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('');
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        const a = c.startsWith('rgba') ? parseFloat(c.split(',')[3]) : 1;
        if (a >= 0.5) return hex(c);
      }
      return '#ffffff';
    };
    return ['#clone-cmd', '.cmd__copy', '.hero__lead', '.pair .t', '.use__d', '.field b', '.hint']
      .map((sel) => { const el = document.querySelector(sel); return { sel, fg: hex(getComputedStyle(el).color), bg: bgOf(el) }; });
  });
  for (const { sel, fg, bg } of samples) {
    const r = ratio(fg, bg);
    assert.ok(r >= 4.5, `${sel} 文字 ${fg} 在 ${bg} 上只有 ${r.toFixed(2)}:1`);
  }
  await context.close();
});

// ---------- 图标 ----------
function pngSize(buf) {
  assert.equal(buf.toString('latin1', 1, 4), 'PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

test('图标：扩展与官网两份 PNG 尺寸正确且内容一致，manifest 引用都存在', async () => {
  for (const size of [16, 32, 48, 128]) {
    const a = await readFile(path.join(root, 'icons', `icon${size}.png`));
    const b = await readFile(path.join(docs, 'icons', `icon${size}.png`));
    assert.deepEqual(pngSize(a), { w: size, h: size });
    assert.ok(a.equals(b), `icon${size}.png 两份不一致，重新运行 node tools/build-icons.mjs`);
  }
  const svgA = await readFile(path.join(root, 'icons', 'icon.svg'), 'utf8');
  const svgB = await readFile(path.join(docs, 'icons', 'icon.svg'), 'utf8');
  assert.equal(svgA, svgB);
  assert.doesNotMatch(svgA, /<text/, '图标应为矢量轮廓，不依赖运行环境字体');

  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const refs = new Set([...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]);
  for (const ref of refs) await stat(path.join(root, ref));
});

test('图标渲染：16px 下靛蓝底与白色字形都有足够的像素', async () => {
  const { page, context } = await open();
  // file:// 下直接读 PNG 会污染 canvas，改用 data URL
  const dataUrl = 'data:image/png;base64,' + (await readFile(path.join(docs, 'icons', 'icon16.png'))).toString('base64');
  const stats = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, 16, 16).data;
    let base = 0, glyph = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      if (d[i + 2] > 150 && d[i] < 120 && d[i + 1] < 130) base++;
      if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) glyph++;
    }
    return { base, glyph };
  }, dataUrl);
  assert.ok(stats.base > 80, `靛蓝底像素过少：${stats.base}`);
  assert.ok(stats.glyph > 20, `字形像素过少：${stats.glyph}`);
  await context.close();
});
