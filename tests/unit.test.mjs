/** 离线单元测试：不发起网络请求。 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBaseUrl,
  normalizeSettings,
  validateSettings,
  DEFAULT_SETTINGS,
} from '../src/lib/config.js';
import {
  detectLanguage,
  resolveTargetLang,
  buildBatchTranslateMessages,
  buildTranslateMessages,
  resolveLanguagePair,
  languageHint,
} from '../src/lib/prompts.js';
import {
  siteKeyOf,
  cacheKeyOf,
  lookupTranslations,
  putTranslations,
  pruneCache,
  isCacheable,
  cacheSizeBytes,
  MAX_CACHED_SOURCE_CHARS,
} from '../src/lib/cache.js';
import {
  makeEntry,
  pruneHistory,
  sumEntries,
  computeStats,
  createStats,
  normalizeStats,
  accumulateStats,
  pruneStats,
  statsView,
  STATS_KEY,
  STATS_LIMIT_DAYS,
  formatNumber,
  compactNumber,
  formatDuration,
  formatRelativeTime,
  formatTime,
  kindLabel,
  PREVIEW_LIMIT,
} from '../src/lib/history.js';
import { normalizeUsage, mergeUsage } from '../src/lib/api.js';
import {
  chunkTexts,
  parseTranslationArray,
  estimateMaxTokens,
  cleanRaw,
  looksUntranslated,
  findUntranslated,
} from '../src/lib/translate.js';
import { condensePageText } from '../src/lib/summarize.js';

test('normalizeBaseUrl 兼容各种写法', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(
    normalizeBaseUrl('https://gateway.example.com/v1/chat/completions'),
    'https://gateway.example.com/v1/chat/completions',
  );
  assert.equal(normalizeBaseUrl(''), 'https://api.deepseek.com/v1/chat/completions');
});

test('normalizeSettings 会把脏数据纠正为安全值', () => {
  const s = normalizeSettings({ targetLang: 'klingon', pageMode: 'weird', disableThinking: 0, apiKey: '  abc  ' });
  assert.equal(s.targetLang, DEFAULT_SETTINGS.targetLang);
  assert.equal(s.pageMode, 'replace');
  assert.equal(s.disableThinking, false);
  assert.equal(s.apiKey, 'abc');
});

test('validateSettings 能发现缺失配置', () => {
  assert.deepEqual(validateSettings({ apiKey: '', baseUrl: 'ftp://x' }), [
    '请填写 API Key',
    'Base URL 需要以 http:// 或 https:// 开头',
  ]);
  assert.deepEqual(validateSettings({ apiKey: 'k', baseUrl: 'https://a.com', model: 'm' }), []);
  // 模型留空时回落到默认模型，不应报错
  assert.equal(normalizeSettings({ model: '  ' }).model, DEFAULT_SETTINGS.model);
});

test('detectLanguage / resolveTargetLang 实现中英互译', () => {
  assert.equal(detectLanguage('这是一段中文文本'), 'zh');
  assert.equal(detectLanguage('This is English text'), 'en');
  assert.equal(resolveTargetLang('auto', '这是一段中文文本'), 'en');
  assert.equal(resolveTargetLang('auto', 'This is English text'), 'zh');
  assert.equal(resolveTargetLang('ja', 'This is English text'), 'ja');
  assert.equal(resolveTargetLang('auto', '1234 5678'), 'zh');
});

test('chunkTexts 按条目数与字符数切分', () => {
  const texts = Array.from({ length: 50 }, (_, i) => `item-${i}`.padEnd(100, 'x'));
  const batches = chunkTexts(texts, { maxChars: 1400, maxItems: 20 });
  // 每批最多 14 条（1400 字符 / 100 字符），50 条 → 4 批
  assert.equal(batches.length, 4);
  assert.equal(batches[0].length, 14);
  assert.equal(batches.at(-1).at(-1), 49);
  assert.equal(
    batches.flat().length,
    50,
    '所有条目都应被覆盖',
  );
  assert.deepEqual(new Set(batches.flat()).size, 50);
});

test('parseTranslationArray 支持 JSON、代码块与编号列表', () => {
  assert.deepEqual(parseTranslationArray('["一","二"]', 2), ['一', '二']);
  assert.deepEqual(parseTranslationArray('```json\n["一","二"]\n```', 2), ['一', '二']);
  assert.deepEqual(parseTranslationArray('[0] 一\n[1] 二', 2), ['一', '二']);
  assert.deepEqual(parseTranslationArray('0. 一\n1. 二', 2), ['一', '二']);
  assert.equal(parseTranslationArray('["一"]', 2), null, '数量不符应返回 null');
  assert.equal(parseTranslationArray('随便一句话', 2), null);
});

test('cleanRaw 去掉代码围栏与包裹引号', () => {
  assert.equal(cleanRaw('```\n你好\n```'), '你好');
  assert.equal(cleanRaw('"你好"'), '你好');
  assert.equal(cleanRaw(' 你好 '), '你好');
});

test('looksUntranslated 能识别漏译并放过正常情况', () => {
  // 整句原样返回 → 判定为漏译
  assert.equal(looksUntranslated('Copyright 2026 Example Inc. All rights reserved.', 'Copyright 2026 Example Inc. All rights reserved.', 'zh'), true);
  // 已翻译 → 不是漏译
  assert.equal(looksUntranslated('Home', '首页', 'zh'), false);
  // 短词/专有名词 → 不算漏译，避免多余请求
  assert.equal(looksUntranslated('AI', 'AI', 'zh'), false);
  assert.equal(looksUntranslated('ChatGPT', 'ChatGPT', 'zh'), false);
  // 原文已是目标语言 → 不算漏译
  assert.equal(looksUntranslated('这是一段中文说明文字', '这是一段中文说明文字', 'zh'), false);
  // 中文漏译成英文的场景
  assert.equal(looksUntranslated('人工智能正在改变世界', '人工智能正在改变世界', 'en'), true);
});

test('findUntranslated 返回正确的下标', () => {
  const list = ['Home', 'Copyright 2026 Example Inc. All rights reserved.', 'About'];
  const translations = ['首页', 'Copyright 2026 Example Inc. All rights reserved.', '关于'];
  assert.deepEqual(findUntranslated(list, translations, 'zh'), [1]);
});

test('estimateMaxTokens 在合理区间内', () => {
  assert.equal(estimateMaxTokens(['short']), 2048);
  assert.ok(estimateMaxTokens([ 'x'.repeat(5000) ]) <= 16000);
});

test('siteKeyOf 取站点标识：去 www、忽略端口与路径', () => {
  assert.equal(siteKeyOf('https://www.example.com/a/b?c=1'), 'example.com');
  assert.equal(siteKeyOf('http://127.0.0.1:8080/en'), '127.0.0.1');
  assert.equal(siteKeyOf('https://EXAMPLE.com/'), 'example.com');
  // 子域各自独立：user.github.io 这类不能被并成同一个站点，否则跨站串味
  assert.equal(siteKeyOf('https://user.github.io/a'), 'user.github.io');
  assert.equal(siteKeyOf('not a url'), '');
  assert.equal(siteKeyOf(''), '');
});

test('缓存键同时包含站点与目标语言', () => {
  const base = cacheKeyOf('example.com', 'zh', 'Hello');
  assert.notEqual(base, cacheKeyOf('other.com', 'zh', 'Hello'));
  assert.notEqual(base, cacheKeyOf('example.com', 'ja', 'Hello'));
  assert.equal(base, cacheKeyOf('example.com', 'zh', 'Hello'));
});

test('lookupTranslations 逐条命中并给出未命中下标', () => {
  const entries = putTranslations([], 'example.com', 'zh', ['Home', 'About'], ['首页', '关于']);
  const looked = lookupTranslations(entries, 'example.com', 'zh', ['About', 'New', 'Home']);
  assert.deepEqual(looked.values, ['关于', undefined, '首页']);
  assert.deepEqual(looked.missTexts, ['New']);
  assert.deepEqual(looked.missIndexes, [1]);
});

test('缓存按站点与目标语言隔离，不跨站复用', () => {
  const entries = putTranslations([], 'a.com', 'zh', ['Spring'], ['春天']);
  assert.equal(lookupTranslations(entries, 'a.com', 'zh', ['Spring']).values[0], '春天');
  // 换站点取不到：同一个词在别的站点可能完全是另一个意思
  assert.equal(lookupTranslations(entries, 'b.com', 'zh', ['Spring']).values[0], undefined);
  // 换目标语言也取不到
  assert.equal(lookupTranslations(entries, 'a.com', 'ja', ['Spring']).values[0], undefined);
});

test('putTranslations 实现 LRU：更新提到最前，超限丢最久未用', () => {
  let entries = putTranslations([], 'a.com', 'zh', ['one', 'two', 'three'], ['一', '二', '三']);
  assert.deepEqual(entries.map((e) => e.v), ['三', '二', '一'], '最近使用应排在最前');

  entries = putTranslations(entries, 'a.com', 'zh', ['one'], ['壹']);
  assert.equal(entries[0].v, '壹', '更新过的条目应移到最前');
  assert.equal(entries.length, 3, '更新不应新增条目');

  entries = putTranslations(entries, 'a.com', 'zh', ['four'], ['四'], { limit: 2 });
  assert.equal(entries.length, 2, '超过上限应被裁剪');
  assert.deepEqual(entries.map((e) => e.v), ['四', '壹']);
});

test('isCacheable 跳过无价值条目', () => {
  assert.equal(isCacheable('Hello', '你好'), true);
  assert.equal(isCacheable('Hello', ''), false);
  assert.equal(isCacheable('Hello', 'Hello'), false, '译文与原文相同不必缓存');
  assert.equal(isCacheable('', '你好'), false);
  assert.equal(isCacheable('x'.repeat(MAX_CACHED_SOURCE_CHARS + 1), '译文'), false, '超长原文不缓存');
});

test('putTranslations 不会写入无价值条目', () => {
  const entries = putTranslations([], 'a.com', 'zh', ['A', 'B'], ['A', '']);
  assert.equal(entries.length, 0);
});

test('pruneCache 与 cacheSizeBytes', () => {
  const list = [{ k: 'a', v: '1' }, { k: 'b', v: '2' }, { k: 'c', v: '3' }];
  assert.equal(pruneCache(list, 2).length, 2);
  assert.equal(pruneCache(list, 0).length, 3, '非法上限退回默认值而不是清空');
  assert.ok(cacheSizeBytes(list) > 0);
  assert.equal(cacheSizeBytes([]), 0);
});

test('condensePageText 去掉重复行与导航噪声', () => {
  const raw = ['首页', '正文第一段内容', '正文第一段内容', 'Sign in', '正文第二段内容'].join('\n');
  const out = condensePageText(raw, 1000);
  assert.equal(out, '正文第一段内容\n正文第二段内容');
});

test('buildBatchTranslateMessages 生成稳定的批次提示词', () => {
  const messages = buildBatchTranslateMessages(['Hello', 'World'], 'zh');
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /exactly 2 items/);
  assert.match(messages[1].content, /\[0\] Hello/);
  assert.match(messages[1].content, /\[1\] World/);
});

/* ------------------------------------------------------------------ */
/* 源语言 / 目标语言                                                    */
/* ------------------------------------------------------------------ */

test('resolveLanguagePair 处理自动识别与中英互译', () => {
  const auto = resolveLanguagePair({ sourceLang: 'auto', targetLang: 'auto' }, 'Hello world, this is English.');
  assert.equal(auto.sourceLang, 'auto');
  assert.equal(auto.resolvedSource, 'en');
  assert.equal(auto.resolvedTarget, 'zh');

  const autoZh = resolveLanguagePair({ sourceLang: 'auto', targetLang: 'auto' }, '这是一句中文。');
  assert.equal(autoZh.resolvedSource, 'zh');
  assert.equal(autoZh.resolvedTarget, 'en');
});

test('resolveLanguagePair 支持固定语言对并处理同语言冲突', () => {
  const fixed = resolveLanguagePair({ sourceLang: 'en', targetLang: 'ja' }, 'Hello');
  assert.equal(fixed.sourceLang, 'en');
  assert.equal(fixed.targetLang, 'ja');
  assert.equal(fixed.resolvedTarget, 'ja');
  assert.equal(fixed.swapped, false);

  // 源语言与目标语言相同时自动反向，避免出现「中文译中文」
  const conflict = resolveLanguagePair({ sourceLang: 'zh', targetLang: 'zh' }, '你好');
  assert.equal(conflict.swapped, true);
  assert.equal(conflict.resolvedTarget, 'en');

  const conflictEn = resolveLanguagePair({ sourceLang: 'en', targetLang: 'en' }, 'hi');
  assert.equal(conflictEn.resolvedTarget, 'zh');
});

test('languageHint 会把源语言写进提示词', () => {
  assert.match(languageHint('auto', 'zh'), /Detect the source language automatically/);
  assert.match(languageHint('en', 'zh'), /text is in English/);
  const messages = buildTranslateMessages('Hello', 'zh', { sourceLang: 'en' });
  assert.match(messages[0].content, /into Simplified Chinese/);
});

/* ------------------------------------------------------------------ */
/* 历史记录与 Token 统计                                                */
/* ------------------------------------------------------------------ */

const sampleEntries = [
  {
    id: 'a',
    ts: new Date('2026-10-11T10:00:00').getTime(),
    kind: 'page',
    model: 'deepseek-flash',
    inputChars: 1000,
    outputChars: 800,
    durationMs: 3000,
    tokens: { prompt: 500, completion: 600, total: 1100 },
  },
  {
    id: 'b',
    ts: new Date('2026-10-11T11:00:00').getTime(),
    kind: 'selection',
    model: 'deepseek-flash',
    inputChars: 50,
    outputChars: 60,
    durationMs: 800,
    tokens: { prompt: 20, completion: 30, total: 50 },
  },
  {
    id: 'c',
    ts: new Date('2026-10-09T09:00:00').getTime(),
    kind: 'summary',
    model: 'gpt-4o-mini',
    inputChars: 5000,
    outputChars: 400,
    durationMs: 5200,
    tokens: { prompt: 2000, completion: 300, total: 2300 },
  },
];

test('makeEntry 会清洗字段并截断预览', () => {
  const entry = makeEntry({
    kind: 'selection',
    sourcePreview: 'a'.repeat(900),
    resultPreview: 'b',
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    inputChars: -5,
  });
  assert.equal(entry.sourcePreview.length, PREVIEW_LIMIT + 1, '超长预览应被截断并加省略号');
  assert.equal(entry.truncated, true);
  assert.equal(entry.inputChars, 0);
  assert.deepEqual(entry.tokens, { prompt: 10, completion: 5, total: 15 });
  assert.ok(entry.id && entry.ts > 0);
});

test('pruneHistory 按上限截断', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ id: String(i), ts: 1000 - i }));
  assert.equal(pruneHistory(list, 20).length, 20);
  assert.equal(pruneHistory(list, 20)[0].id, '0', '应保留最新的记录');
  assert.equal(pruneHistory(list, 5).length, 5);
  assert.equal(pruneHistory(null, 20).length, 0);
});

test('sumEntries 汇总次数、Token 与耗时', () => {
  const total = sumEntries(sampleEntries);
  assert.equal(total.count, 3);
  assert.deepEqual(total.tokens, { prompt: 2520, completion: 930, total: 3450 });
  assert.equal(total.inputChars, 6050);
  assert.equal(total.outputChars, 1260);
  assert.equal(total.avgDurationMs, 3000);
  assert.deepEqual(sumEntries([]).tokens, { prompt: 0, completion: 0, total: 0 });
});

test('computeStats 生成总计、分类与每日趋势', () => {
  const now = new Date('2026-10-11T20:00:00').getTime();
  const stats = computeStats(sampleEntries, { days: 7, now });

  assert.equal(stats.total.count, 3);
  assert.equal(stats.today.count, 2, '今天应有 2 条');
  assert.equal(stats.today.tokens.total, 1150);
  assert.equal(stats.week.count, 3);

  const kinds = stats.byKind.map((item) => item.kind).sort();
  assert.deepEqual(kinds, ['page', 'selection', 'summary']);
  const page = stats.byKind.find((item) => item.kind === 'page');
  assert.equal(page.tokens.total, 1100);
  assert.equal(page.label, '整页翻译');

  assert.equal(stats.daily.length, 7, '应补齐 7 天');
  assert.equal(stats.daily.at(-1).date, '2026-10-11');
  assert.equal(stats.daily.at(-1).count, 2);
  assert.equal(stats.daily.at(-1).tokens, 1150);
  assert.equal(stats.daily.at(-3).date, '2026-10-09');
  assert.equal(stats.daily[0].count, 0, '没有记录的日期应补 0');

  // 按 Token 从高到低排序：gpt-4o-mini(2300) > deepseek-flash(1150)
  assert.equal(stats.byModel[0].model, 'gpt-4o-mini');
  assert.equal(stats.byModel[0].tokens.total, 2300);
  assert.equal(stats.byModel[1].model, 'deepseek-flash');
  assert.equal(stats.byModel[1].count, 2);
});

test('数字与时间格式化', () => {
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(compactNumber(999), '999');
  assert.equal(compactNumber(1500), '1.5k');
  assert.equal(compactNumber(2300000), '2.30M');
  assert.equal(formatDuration(800), '800 ms');
  assert.equal(formatDuration(3400), '3.4 s');
  assert.equal(formatRelativeTime(Date.now() - 30000), '刚刚');
  assert.equal(formatTime(new Date('2026-10-11T08:05:00').getTime()), '2026-10-11 08:05');
  assert.equal(kindLabel('summary'), '网页总结');
});

test('normalizeSettings 处理源语言与历史上限', () => {
  assert.equal(normalizeSettings({ sourceLang: 'klingon' }).sourceLang, 'auto');
  assert.equal(normalizeSettings({ sourceLang: 'en' }).sourceLang, 'en');
  assert.equal(normalizeSettings({ historyLimit: 5 }).historyLimit, DEFAULT_SETTINGS.historyLimit);
  assert.equal(normalizeSettings({ historyLimit: 500 }).historyLimit, 500);
  assert.equal(normalizeSettings({ historyLimit: 99999 }).historyLimit, 2000);
  // 持续翻译与翻译缓存：缺省开启，显式关闭需被保留
  assert.equal(normalizeSettings({}).autoTranslateDynamic, true);
  assert.equal(normalizeSettings({ autoTranslateDynamic: false }).autoTranslateDynamic, false);
  assert.equal(normalizeSettings({ autoTranslateDynamic: 'off' }).autoTranslateDynamic, false);
  assert.equal(normalizeSettings({ autoTranslateDynamic: true }).autoTranslateDynamic, true);
  assert.equal(normalizeSettings({}).cacheEnabled, true);
  assert.equal(normalizeSettings({ cacheEnabled: false }).cacheEnabled, false);
  assert.equal(normalizeSettings({ cacheEnabled: 'off' }).cacheEnabled, false);
});

test('normalizeUsage / mergeUsage 归一化各家用量格式', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }), {
    prompt: 10,
    completion: 20,
    total: 30,
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 5, output_tokens: 7 }), { prompt: 5, completion: 7, total: 12 });
  assert.deepEqual(normalizeUsage(null), { prompt: 0, completion: 0, total: 0 });
  assert.deepEqual(
    mergeUsage({ prompt: 1, completion: 2, total: 3 }, { prompt: 10, completion: 20, total: 30 }),
    { prompt: 11, completion: 22, total: 33 },
  );
  // 归一化后的对象再次参与累加也不能出错
  assert.deepEqual(mergeUsage({ prompt: 1, completion: 2, total: 3 }, normalizeUsage({ prompt_tokens: 4 })), {
    prompt: 5,
    completion: 2,
    total: 7,
  });
});

/* ------------------------------------------------------------------ */
/* 用量统计账本                                                        */
/*                                                                     */
/* 背景：统计原本是每次从翻译记录现算的，于是「清空记录」这个隐私动作   */
/* 会顺手把 Token 消耗、调用次数一起清零。现在统计单独落盘，两者解耦。  */
/* ------------------------------------------------------------------ */

const statsNow = new Date('2026-10-11T20:00:00').getTime();
const foldEntries = (list) => list.reduce((acc, entry) => accumulateStats(acc, entry), createStats());

test('统计账本：累加后展开的结果与从记录现算完全一致', () => {
  assert.deepEqual(statsView(foldEntries(sampleEntries), { days: 7, now: statsNow }), computeStats(sampleEntries, { days: 7, now: statsNow }));
  assert.deepEqual(statsView(createStats(), { days: 7, now: statsNow }).total, computeStats([], { days: 7, now: statsNow }).total);
});

test('统计账本：JSON 往返（写入 chrome.storage 的形态）不丢数据', () => {
  const ledger = foldEntries(sampleEntries);
  const restored = normalizeStats(JSON.parse(JSON.stringify(ledger)));
  assert.deepEqual(restored, ledger);
  assert.deepEqual(statsView(restored, { days: 7, now: statsNow }), statsView(ledger, { days: 7, now: statsNow }));
});

test('统计账本：累加与裁剪都是纯函数，不修改入参', () => {
  const base = foldEntries(sampleEntries);
  const snapshot = JSON.parse(JSON.stringify(base));

  const grown = accumulateStats(base, makeEntry({ ts: statsNow, kind: 'page', tokens: { prompt: 1, completion: 1, total: 2 } }));
  pruneStats(base, new Date('2027-06-01T12:00:00').getTime());

  assert.deepEqual(base, snapshot, '入参不应被累加或裁剪改写');
  assert.notEqual(grown.total.count, base.total.count);
});

test('统计账本：pruneStats 只裁掉过期的每日数据，累计总计仍然完整', () => {
  const pruned = pruneStats(foldEntries(sampleEntries), statsNow);
  assert.deepEqual(Object.keys(pruned.daily).sort(), ['2026-10-09', '2026-10-11'], `${STATS_LIMIT_DAYS} 天内的数据应保留`);
  assert.equal(pruned.total.count, 3);
  assert.equal(pruned.total.tokens.total, 3450);

  // 远超出保留窗口后每日数据被清空，但总计与分布代表真实发生过的用量，必须留着
  const dropped = pruneStats(pruned, new Date('2027-06-01T12:00:00').getTime());
  assert.deepEqual(Object.keys(dropped.daily), []);
  assert.equal(dropped.total.count, 3);
  assert.equal(dropped.total.tokens.total, 3450);
  assert.deepEqual(dropped.byKind.summary.tokens, { prompt: 2000, completion: 300, total: 2300 });
  assert.equal(dropped.byModel['deepseek-flash'].count, 2);
});

test('统计账本：normalizeStats 能消化脏数据与旧结构', () => {
  const empty = normalizeStats(null);
  assert.deepEqual(empty.total, {
    count: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    inputChars: 0,
    outputChars: 0,
    durationMs: 0,
  });
  assert.deepEqual(empty.byKind, {});
  assert.deepEqual(empty.byModel, {});
  assert.deepEqual(empty.daily, {});

  const dirty = normalizeStats({
    total: { count: -3, tokens: { prompt: 'x' }, inputChars: 'y' },
    byKind: { page: { count: 1, tokens: { prompt_tokens: 4 } }, '': { count: 9 } },
    byModel: { 'm': null },
    daily: { '2026-10-11': { count: 2, tokens: { total_tokens: 10 } }, 'not-a-date': { count: 5 } },
  });
  assert.equal(dirty.total.count, 0);
  assert.deepEqual(dirty.total.tokens, { prompt: 0, completion: 0, total: 0 });
  assert.equal(dirty.byKind[''], undefined, '空键应被丢弃');
  assert.deepEqual(dirty.byKind.page.tokens, { prompt: 4, completion: 0, total: 4 });
  assert.equal(dirty.byModel.m.count, 0);
  assert.deepEqual(Object.keys(dirty.daily), ['2026-10-11']);
});

/* ------------------------------------------------------------------ */
/* 记录与统计的独立性（用内存版 chrome.storage 跑真实的写入路径）        */
/* ------------------------------------------------------------------ */

/** 内存版 chrome.storage，让 storage.js 能在 Node 里直接跑。 */
function installChromeStub(seed = {}) {
  const store = { local: { ...seed }, sync: {} };
  const listeners = new Set();
  const makeArea = (name) => ({
    async get(keys) {
      const source = store[name];
      if (keys == null) return { ...source };
      const out = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (key in source) out[key] = source[key];
      }
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: store[name][key], newValue: value };
        store[name][key] = value;
      }
      for (const listener of [...listeners]) listener(changes, name);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[name][key];
    },
  });
  globalThis.chrome = {
    storage: {
      local: makeArea('local'),
      sync: makeArea('sync'),
      onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    },
  };
  return store;
}

test('清空翻译记录不会连带清零用量统计', async () => {
  installChromeStub();
  const { appendHistory, loadHistory, clearHistory, loadStats, clearStats } = await import('../src/lib/storage.js');
  const stats = async () => statsView(await loadStats(), { days: 7 });

  await appendHistory(
    makeEntry({
      kind: 'page',
      model: 'deepseek-flash',
      inputChars: 100,
      outputChars: 80,
      durationMs: 1200,
      tokens: { prompt: 500, completion: 600, total: 1100 },
    }),
    300,
  );
  await appendHistory(
    makeEntry({
      kind: 'selection',
      model: 'deepseek-flash',
      inputChars: 5,
      outputChars: 6,
      durationMs: 300,
      tokens: { prompt: 20, completion: 30, total: 50 },
    }),
    300,
  );

  assert.equal((await stats()).total.count, 2);
  assert.equal((await stats()).total.tokens.total, 1150);
  assert.equal((await loadHistory()).length, 2);

  // 清空记录是隐私动作：记录清空，统计原地不动
  await clearHistory();
  assert.equal((await loadHistory()).length, 0);
  assert.equal((await stats()).total.count, 2, '统计不应被清空记录连带清零');
  assert.equal((await stats()).total.tokens.total, 1150);

  // 清空统计只清账本
  await clearStats();
  assert.equal((await stats()).total.count, 0);

  // 清空后继续翻译：账本从 0 重新累计，记录与账本互不覆盖
  await appendHistory(makeEntry({ kind: 'summary', model: 'gpt-4o-mini', tokens: { prompt: 1, completion: 2, total: 3 } }), 300);
  assert.equal((await stats()).total.count, 1);
  assert.equal((await stats()).total.tokens.total, 3);
  assert.equal((await loadHistory()).length, 1);
});

test('老版本升级：账本缺失时用现有记录回填一次，且显式清空后不再复活', async () => {
  const store = installChromeStub({ ait_history: sampleEntries });
  const { ensureStats, loadStats, clearStats } = await import('../src/lib/storage.js');

  assert.equal(store.local[STATS_KEY], undefined, '前置条件：只有记录，没有账本');

  const seeded = await ensureStats(store.local.ait_history);
  assert.equal(statsView(seeded, { days: 7, now: statsNow }).total.count, 3, '应回填历史记录的用量');
  assert.equal((await loadStats()).total.tokens.total, 3450);
  assert.equal((await loadStats()).total.count, 3, '回填后再次读取不应重复累加');

  // 显式清空统计写的是空账本而非删键：记录还在也不该被回填复活
  await clearStats();
  await ensureStats(store.local.ait_history);
  assert.equal((await loadStats()).total.count, 0);
});
