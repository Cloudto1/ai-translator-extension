/**
 * 提示词构造与目标语言推断。纯函数，便于单元测试。
 */

import { LANGUAGE_NAMES } from './config.js';

/** 统计文本语言倾向，用于 auto 模式判断。 */
export function detectLanguage(text) {
  const sample = String(text || '').slice(0, 4000);
  const cjk = (sample.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const kana = (sample.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (sample.match(/[\uac00-\ud7af]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  if (kana > 2) return 'ja';
  if (hangul > 2) return 'ko';
  if (cjk >= 2 && cjk * 2 >= latin) return 'zh';
  if (latin >= 2) return 'en';
  return 'unknown';
}

/**
 * 解析目标语言。auto 表示「中英互译」：中文内容翻成英文，非中文内容翻成中文。
 */
export function resolveTargetLang(targetLang, sampleText) {
  if (targetLang && targetLang !== 'auto' && LANGUAGE_NAMES[targetLang]) return targetLang;
  const detected = detectLanguage(sampleText);
  if (detected === 'zh') return 'en';
  // 页面是英文/日文/韩文/未知时，统一翻译为中文，符合中文用户习惯
  return 'zh';
}

export function langName(code) {
  return LANGUAGE_NAMES[code] || code || 'English';
}

/** 生成「源语言 -> 目标语言」的提示句。 */
export function languageHint(sourceLang, targetLang) {
  const target = langName(targetLang);
  if (!sourceLang || sourceLang === 'auto') {
    return `Detect the source language automatically, then translate into ${target}.`;
  }
  return `The text is in ${langName(sourceLang)}. Translate it into ${target}.`;
}

/**
 * 解析实际生效的语言对。
 * - 源语言为 auto 时交给模型识别；
 * - 目标语言为 auto 时按中 ⇄ 英 互译推断；
 * - 源语言与目标语言被设置成同一种语言时自动反向翻译，避免出现「中文译成中文」。
 */
export function resolveLanguagePair(settings, sampleText) {
  const configuredSource = settings?.sourceLang && settings.sourceLang !== 'auto' ? settings.sourceLang : 'auto';
  const configuredTarget = settings?.targetLang || 'auto';

  let target = configuredTarget;
  let swapped = false;
  if (configuredSource !== 'auto' && configuredSource === configuredTarget) {
    target = configuredSource === 'en' ? 'zh' : 'en';
    swapped = true;
  }

  return {
    sourceLang: configuredSource,
    targetLang: target,
    resolvedSource: configuredSource === 'auto' ? detectLanguage(sampleText) : configuredSource,
    resolvedTarget: resolveTargetLang(target, sampleText),
    swapped,
  };
}

/**
 * 划词/单条文本翻译。
 * @param {boolean} strong 用于「模型把整句当专有名词原样返回」时的重试，措辞更强硬
 */
export function buildTranslateMessages(text, targetLang, { strong = false, sourceLang = 'auto' } = {}) {
  const target = langName(targetLang);
  const rules = [
    `You are a professional translator. ${languageHint(sourceLang, targetLang)}`,
    'Rules:',
    '1. Output ONLY the translation, no explanations, notes, quotes or markdown fences.',
    '2. Keep the original meaning, tone and formatting (line breaks, list markers).',
    '3. Never translate code, URLs, emails, file paths, numbers, IDs, brand names, or placeholders such as {name} and %s.',
    `4. If the text is already in ${target}, return it unchanged.`,
    '5. Preserve the original punctuation style as much as possible.',
  ];
  if (strong) {
    rules.push(
      `6. A previous attempt returned the text unchanged, which is wrong. You MUST translate it into ${target} now.`,
      '7. Translate every translatable word, including labels, headings, legal notices such as copyright lines, and generic nouns.',
      '8. Only keep personal names, company names and product names in their original form.',
    );
  }
  return [
    { role: 'system', content: rules.join('\n') },
    { role: 'user', content: String(text) },
  ];
}

/** 批量翻译（全页面），要求返回 JSON 数组，保证顺序与数量一致。 */
export function buildBatchTranslateMessages(texts, targetLang, { sourceLang = 'auto' } = {}) {
  const target = langName(targetLang);
  const n = texts.length;
  const items = texts.map((t, i) => `[${i}] ${t}`).join('\n');
  return [
    {
      role: 'system',
      content: [
        `You are a professional translation engine. ${languageHint(sourceLang, targetLang)}`,
        'Rules:',
        `1. Output ONLY a JSON array of ${n} strings, for example ["translation of item 0","translation of item 1"].`,
        `2. The array MUST contain exactly ${n} items, in the same order as the input.`,
        '3. Do not merge or split items. Do not add explanations, notes or markdown fences.',
        '4. Keep code, URLs, emails, numbers, IDs and brand names unchanged.',
        `5. If an item is already in ${target}, output it unchanged.`,
        '6. Escape newlines inside a string as \\n, and escape double quotes as \\".',
      ].join('\n'),
    },
    { role: 'user', content: `Items:\n${items}\n\nReturn the JSON array now.` },
  ];
}

/** 网页总结 */
export function buildSummaryMessages({ title, url, text, targetLang, length = 'medium' }) {
  const target = langName(targetLang);
  const detail = {
    short: '3-4 bullet points in about 120 words',
    medium: 'a one-sentence summary, then 4-6 bullet points, in about 300 words',
    detailed: 'a one-sentence summary, then 6-10 bullet points grouped under 2-3 sub-headings, in about 600 words',
  }[length] || 'a one-sentence summary, then 4-6 bullet points, in about 300 words';

  return [
    {
      role: 'system',
      content: [
        `You are an expert reader that writes accurate, well-structured summaries of web pages in ${target}.`,
        'Rules:',
        '1. Base your summary ONLY on the provided content. Never invent facts, numbers or names.',
        '2. If the content is too short or meaningless, say so honestly in one sentence.',
        '3. Use plain text with a short heading line and "- " bullet points. Do not use markdown tables or code fences.',
        '4. Do not repeat the page title as a heading; write a real summary.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Page title: ${title || '(unknown)'}`,
        `Page URL: ${url || '(unknown)'}`,
        '',
        'Page content:',
        '-----',
        String(text || '').slice(0, 60000),
        '-----',
        '',
        `Write the summary in ${target}: ${detail}.`,
      ].join('\n'),
    },
  ];
}
