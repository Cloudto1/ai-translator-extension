// 由 icons/icon.svg 生成扩展与官网用的 PNG 图标（16 / 32 / 48 / 128）。
// 用法：node tools/build-icons.mjs
// 渲染走 Playwright 的 Edge，SVG 是唯一源文件，改完它再跑一次即可。
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(path.join(root, 'icons', 'icon.svg'), 'utf8');
const sizes = [16, 32, 48, 128];
const outDirs = [path.join(root, 'icons'), path.join(root, 'docs', 'icons')];

const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
    );
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    for (const dir of outDirs) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `icon${size}.png`), png);
    }
    console.log(`icon${size}.png  ${png.length} B`);
  }
  // 官网 favicon 直接用 SVG 源文件
  await writeFile(path.join(root, 'docs', 'icons', 'icon.svg'), svg);
} finally {
  await browser.close();
}
