/** 离线单元测试：不发起网络请求。 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBaseUrl,
  normalizeSettings,
  validateSettings,
  DEFAULT_SETTINGS,
} from '../src/lib/config.js';
import { detectLanguage, resolveTargetLang, buildBatchTranslateMessages } from '../src/lib/prompts.js';
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
