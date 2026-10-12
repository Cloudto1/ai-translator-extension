/**
 * 集成测试：使用真实 API 验证翻译、总结、流式输出与错误处理。
 * 运行：npm run test:integration
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { chatCompletion, testConnection, ApiError } from '../src/lib/api.js';
import { translateOne, translateTexts, chunkTexts } from '../src/lib/translate.js';
import { summarizePage } from '../src/lib/summarize.js';
import { buildTranslateMessages } from '../src/lib/prompts.js';
import { RUNTIME_LIMITS } from '../src/lib/config.js';
import { API_CONFIG, EN_ARTICLE, EN_SEGMENTS, ZH_ARTICLE } from './fixtures.mjs';

const settings = API_CONFIG;
const HAS_KEY = Boolean(settings.apiKey);
const skip = HAS_KEY ? false : '未配置 API Key';

function countCJK(text) {
  return (String(text).match(/[\u4e00-\u9fff]/g) || []).length;
}

test('连接测试：/chat/completions 可达且鉴权有效', { skip }, async () => {
  const result = await testConnection(settings);
  assert.equal(result.ok, true);
  assert.ok(result.latencyMs > 0);
  assert.ok(result.reply.length > 0, '应返回模型输出');
  console.log(`  ↳ 连通 ${result.latencyMs}ms，模型 ${result.model}`);
});

test('错误处理：无效 API Key 返回可读错误', { skip }, async () => {
  await assert.rejects(
    () => chatCompletion({ ...settings, apiKey: 'sk-invalid-key', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, /API Key|HTTP/);
      console.log(`  ↳ ${err.message.slice(0, 90)}`);
      return true;
    },
  );
});

test('错误处理：Base URL 不可达时给出网络错误', { skip }, async () => {
  await assert.rejects(
    () =>
      chatCompletion({
        ...settings,
        baseUrl: 'https://this-host-does-not-exist-12345.test',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 8000,
      }),
    (err) => {
      assert.ok(['NETWORK_ERROR', 'TIMEOUT'].includes(err.code), `实际 code=${err.code}`);
      return true;
    },
  );
});

test('划词翻译：英文 -> 中文（auto 自动判定）', { skip }, async () => {
  const result = await translateOne(settings, 'Artificial intelligence is transforming the way we work.', {
    targetLang: 'auto',
  });
  assert.equal(result.targetLang, 'zh');
  assert.ok(countCJK(result.text) >= 5, `译文应含中文：${result.text}`);
  console.log(`  ↳ ${result.text}`);
});

test('划词翻译：中文 -> 英文（auto 自动判定）', { skip }, async () => {
  const result = await translateOne(settings, '人工智能正在改变我们的工作方式。', { targetLang: 'auto' });
  assert.equal(result.targetLang, 'en');
  assert.ok(/[A-Za-z]{4,}/.test(result.text), `译文应为英文：${result.text}`);
  console.log(`  ↳ ${result.text}`);
});

test('划词翻译：流式输出逐段返回且最终结果完整', { skip }, async () => {
  let deltas = 0;
  let received = '';
  const result = await translateOne(settings, EN_ARTICLE, {
    targetLang: 'zh',
    onDelta: (delta, full) => {
      deltas += 1;
      received = full;
    },
  });
  assert.ok(deltas > 1, `应收到多次增量，实际 ${deltas}`);
  assert.equal(received, result.text, '流式拼接结果应与最终结果一致');
  assert.ok(countCJK(result.text) > 30);
});

test('全页面翻译：批量 15 段，数量与顺序一致', { skip }, async () => {
  let progressCalls = 0;
  const { translations, targetLang } = await translateTexts(settings, EN_SEGMENTS, {
    targetLang: 'zh',
    onProgress: () => {
      progressCalls += 1;
    },
  });
  assert.equal(targetLang, 'zh');
  assert.equal(translations.length, EN_SEGMENTS.length);
  const bad = translations.filter((t) => !t || countCJK(t) < 2);
  assert.equal(bad.length, 0, `存在未翻译条目：${JSON.stringify(bad)}`);
  assert.ok(progressCalls >= 1, '应上报进度');
  assert.ok(translations[2].includes('support@example.com'), '邮箱不应被翻译');
  console.log(`  ↳ 示例：${translations[0]}`);
});

test('全页面翻译：超过单批上限时自动分多批', { skip }, async () => {
  // 输入规模由实际分批上限推导，别把上限写死在断言里——调整批次参数不该弄坏这个用例
  const itemCount = RUNTIME_LIMITS.maxItemsPerBatch + 5;
  const many = Array.from({ length: itemCount }, (_, i) => `${EN_SEGMENTS[i % EN_SEGMENTS.length]} (${i + 1})`);
  const expectedBatches = chunkTexts(many, RUNTIME_LIMITS).length;

  const batches = [];
  const { translations } = await translateTexts(settings, many, {
    targetLang: 'zh',
    onProgress: (p) => batches.push(p),
  });

  assert.equal(translations.length, itemCount, '译文数量应与输入条目一致');
  assert.ok(expectedBatches >= 2, `用例应构造出多批输入，实际 ${expectedBatches}`);
  assert.equal(batches.length, expectedBatches, '进度回调次数应与批次数一致');
  assert.ok(translations.every((t) => countCJK(t) >= 2), '每一条都应被翻译');
});

test('全页面翻译：模型把整句当专有名词时自动重试补译', { skip }, async () => {
  const texts = [
    'Home',
    'Copyright 2026 Example Inc. All rights reserved.',
    'Artificial intelligence is transforming the way we work and live.',
  ];
  const { translations } = await translateTexts(settings, texts, { targetLang: 'zh' });
  assert.notEqual(
    translations[1].trim(),
    texts[1].trim(),
    '版权声明不应原样返回',
  );
  assert.ok(countCJK(translations[1]) >= 2, `版权声明应被翻译：${translations[1]}`);
  console.log(`  ↳ ${translations[1]}`);
});

test('全页面翻译：中文页面译成英文', { skip }, async () => {
  const segments = ZH_ARTICLE.split('\n').map((s) => s.trim()).filter(Boolean);
  const { translations, targetLang } = await translateTexts(settings, segments, { targetLang: 'auto' });
  assert.equal(targetLang, 'en');
  assert.ok(translations.every((t) => /[A-Za-z]{3,}/.test(t)), JSON.stringify(translations));
});

test('网页总结：生成结构化中文摘要', { skip }, async () => {
  const result = await summarizePage(settings, {
    title: 'The Future of Artificial Intelligence',
    url: 'https://example.com/ai-future',
    text: EN_ARTICLE,
    targetLang: 'auto',
    length: 'medium',
  });
  assert.equal(result.targetLang, 'zh');
  assert.ok(countCJK(result.summary) > 60, `摘要过短：${result.summary}`);
  assert.match(result.summary, /[-•]/, '应包含要点列表');
  console.log(`  ↳ ${result.summary.replace(/\n/g, ' | ').slice(0, 160)}…`);
});

test('网页总结：内容过少时抛出明确错误', { skip }, async () => {
  await assert.rejects(
    () => summarizePage(settings, { title: 't', url: 'u', text: 'hi' }),
    (err) => err.code === 'CONTENT_TOO_SHORT',
  );
});

test('用量统计：批量翻译聚合 Token 消耗', { skip }, async () => {
  const { translations, usage, requestCount } = await translateTexts(settings, EN_SEGMENTS, { targetLang: 'zh' });
  assert.equal(translations.length, EN_SEGMENTS.length);
  assert.ok(usage.total > 0, `应返回 Token 用量：${JSON.stringify(usage)}`);
  assert.equal(usage.total, usage.prompt + usage.completion, '总 Token 应等于输入 + 输出');
  assert.ok(usage.completion > 0);
  assert.ok(requestCount >= 1, `应记录请求次数，实际 ${requestCount}`);
  console.log(`  ↳ ${requestCount} 次请求，共 ${usage.total} Token（输入 ${usage.prompt} / 输出 ${usage.completion}）`);
});

test('用量统计：流式翻译也能拿到 Token 用量', { skip }, async () => {
  const result = await translateOne(settings, 'Artificial intelligence is transforming the way we work.', {
    targetLang: 'zh',
    onDelta: () => {},
  });
  assert.ok(result.usage.total > 0, `流式响应应带上用量：${JSON.stringify(result.usage)}`);
  console.log(`  ↳ ${result.usage.total} Token`);
});

test('用量统计：网页总结返回 Token 用量', { skip }, async () => {
  const result = await summarizePage(settings, {
    title: 'AI future',
    url: 'https://example.com',
    text: EN_ARTICLE,
    targetLang: 'zh',
  });
  assert.ok(result.usage.total > 0);
  console.log(`  ↳ ${result.usage.total} Token`);
});

test('语言设置：固定源语言与目标语言', { skip }, async () => {
  const result = await translateOne(settings, 'Good morning, everyone.', {
    sourceLang: 'en',
    targetLang: 'ja',
  });
  assert.equal(result.sourceLang, 'en');
  assert.equal(result.targetLang, 'ja');
  assert.ok(/[\u3040-\u30ff]/.test(result.text), `应输出日文：${result.text}`);
  console.log(`  ↳ ${result.text}`);
});

test('语言设置：源语言与目标语言相同时自动反向翻译', { skip }, async () => {
  const result = await translateOne(settings, '人工智能正在改变世界。', {
    sourceLang: 'zh',
    targetLang: 'zh',
  });
  assert.equal(result.targetLang, 'en', '同语言应自动反向');
  assert.ok(/[A-Za-z]{4,}/.test(result.text), `应输出英文：${result.text}`);
});

test('兼容性：任意 OpenAI 协议端点都能拿到结果', { skip }, async () => {
  // 直接验证请求体符合 OpenAI 规范（messages/model/max_tokens）
  const result = await chatCompletion({
    ...settings,
    messages: buildTranslateMessages('Good morning', 'zh'),
    maxTokens: 2048,
    temperature: 0,
  });
  assert.ok(result.content.length > 0);
});
