/**
 * 翻译流水线：分批、调用模型、解析结果、容错重试。
 * 只依赖 api.js / prompts.js，可在 Node 中直接测试。
 */

import { chatCompletion, ApiError } from './api.js';
import {
  buildTranslateMessages,
  buildBatchTranslateMessages,
  resolveTargetLang,
  detectLanguage,
} from './prompts.js';

/** 一次批量翻译中，最多对多少个「疑似漏译」条目做针对性重试。 */
export const MAX_UNTRANSLATED_RETRY = 8;

/** 粗略估算输出所需 token，避免被截断。 */
export function estimateMaxTokens(texts) {
  const chars = texts.reduce((sum, t) => sum + String(t || '').length, 0);
  return Math.min(16000, Math.max(2048, Math.ceil(chars * 2)));
}

/** 把待翻译文本切成批（按条目数和字符数双限制）。 */
export function chunkTexts(texts, { maxChars = 1400, maxItems = 20 } = {}) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  texts.forEach((text, index) => {
    const len = String(text || '').length;
    if (current.length > 0 && (currentChars + len > maxChars || current.length >= maxItems)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(index);
    currentChars += len;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

export function cleanRaw(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('“') && s.endsWith('”'))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

/**
 * 解析模型返回的 JSON 数组 / 编号列表。
 * @returns {string[]|null} 长度与 expectedCount 一致时返回数组，否则返回 null。
 */
export function parseTranslationArray(raw, expectedCount) {
  if (!raw || expectedCount <= 0) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const arr = JSON.parse(s.slice(start, end + 1));
      if (Array.isArray(arr) && arr.length === expectedCount) {
        return arr.map((v) => (v == null ? '' : String(v)));
      }
    } catch {
      /* 继续使用编号行解析 */
    }
  }

  // 兜底：解析 "[0] xxx" / "0. xxx" 形式的编号列表
  const lines = s.split(/\r?\n/);
  const map = new Map();
  let lastIndex = -1;
  for (const line of lines) {
    const m = line.match(/^\s*\[?(\d{1,3})\]?\s*[.、:：)]?\s*(.*)$/);
    const idx = m ? Number(m[1]) : NaN;
    if (m && Number.isInteger(idx) && idx >= 0 && idx < expectedCount && !map.has(idx)) {
      map.set(idx, m[2].trim());
      lastIndex = idx;
      continue;
    }
    if (lastIndex >= 0 && line.trim()) {
      map.set(lastIndex, `${map.get(lastIndex)}\n${line.trim()}`.trim());
    }
  }
  if (map.size === expectedCount) {
    return Array.from({ length: expectedCount }, (_, i) => cleanRaw(map.get(i)));
  }
  return null;
}

function commonOptions(settings, messages, texts, signal) {
  return {
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    messages,
    temperature: 0.3,
    maxTokens: estimateMaxTokens(texts),
    stream: false,
    disableThinking: settings.disableThinking !== false,
    signal,
  };
}

function assertNotTruncated(result) {
  if (!result.content && result.finishReason === 'length') {
    throw new ApiError('模型输出被截断，请减小批量或更换模型。', 'TRUNCATED');
  }
}

/**
 * 判断一条结果是否「疑似漏译」：输出与原文完全一致，
 * 且原文明显不是目标语言，并且原文是一句有实质内容的文本。
 */
export function looksUntranslated(source, output, targetLang) {
  const src = String(source ?? '').trim();
  const out = String(output ?? '').trim();
  if (!src || !out || out !== src) return false;
  if (detectLanguage(src) === targetLang) return false;
  if (src.length < 10) return false;
  const latin = (src.match(/[A-Za-z]/g) || []).length;
  const cjk = (src.match(/[\u4e00-\u9fff]/g) || []).length;
  return latin >= 3 || cjk >= 4;
}

/** 找出批量结果中疑似漏译的条目下标。 */
export function findUntranslated(list, translations, targetLang) {
  const indices = [];
  list.forEach((src, i) => {
    if (looksUntranslated(src, translations[i], targetLang)) indices.push(i);
  });
  return indices;
}

/** 翻译单条文本（onDelta 存在时走流式输出；漏译时自动强引导重试一次）。 */
export async function translateOne(settings, text, { targetLang, onDelta, signal, strong = false } = {}) {
  const lang = resolveTargetLang(targetLang ?? settings.targetLang, text);
  const run = async (useStrong) => {
    const messages = buildTranslateMessages(text, lang, { strong: useStrong });
    const result = await chatCompletion({
      ...commonOptions(settings, messages, [text], signal),
      stream: typeof onDelta === 'function',
      onDelta,
    });
    assertNotTruncated(result);
    return { text: cleanRaw(result.content), usage: result.usage };
  };

  let output = await run(strong);
  if (!strong && !output.text) throw new ApiError('模型没有返回翻译结果，请重试。', 'EMPTY_RESULT');
  if (!strong && looksUntranslated(text, output.text, lang)) {
    const retry = await run(true);
    if (retry.text) output = retry;
  }
  if (!output.text) throw new ApiError('模型没有返回翻译结果，请重试。', 'EMPTY_RESULT');
  return { text: output.text, targetLang: lang, usage: output.usage };
}

async function translateBatch(settings, texts, lang, signal) {
  const messages = buildBatchTranslateMessages(texts, lang);
  const result = await chatCompletion(commonOptions(settings, messages, texts, signal));
  assertNotTruncated(result);
  const parsed = parseTranslationArray(result.content, texts.length);
  if (parsed) return parsed;

  // 解析失败：拆半重试；单条时退化为「直接使用返回文本」
  if (texts.length > 1) {
    const mid = Math.ceil(texts.length / 2);
    const left = await translateBatch(settings, texts.slice(0, mid), lang, signal);
    const right = await translateBatch(settings, texts.slice(mid), lang, signal);
    return [...left, ...right];
  }
  const fallback = cleanRaw(result.content);
  if (fallback) return [fallback];
  throw new ApiError('模型返回格式无法解析，请重试。', 'PARSE_ERROR', result.content);
}

/**
 * 批量翻译（全页面用）。
 * @param {object} settings
 * @param {string[]} texts 已去重的待翻译文本
 * @param {{targetLang?:string, onProgress?:Function, signal?:AbortSignal, limits?:object}} opts
 * @returns {Promise<{translations:string[], targetLang:string}>}
 */
export async function translateTexts(settings, texts, opts = {}) {
  const { onProgress, signal, limits = {} } = opts;
  const list = (texts || []).map((t) => String(t ?? ''));
  if (list.length === 0) return { translations: [], targetLang: settings.targetLang };

  const sample = list.join('\n').slice(0, 2000);
  const lang = resolveTargetLang(opts.targetLang ?? settings.targetLang, sample);
  const translations = new Array(list.length).fill('');

  if (list.length === 1) {
    const one = await translateOne(settings, list[0], { targetLang: lang, signal });
    translations[0] = one.text;
    onProgress?.({ done: 1, total: 1 });
    return { translations, targetLang: lang };
  }

  const batches = chunkTexts(list, limits);
  let done = 0;
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(limits.concurrency || 3, batches.length));
  let firstError = null;

  const worker = async () => {
    for (;;) {
      const batchIndex = cursor;
      cursor += 1;
      if (batchIndex >= batches.length) return;
      if (firstError) return;
      const indices = batches[batchIndex];
      const payload = indices.map((i) => list[i]);
      try {
        const out = await translateBatch(settings, payload, lang, signal);
        indices.forEach((globalIndex, k) => {
          translations[globalIndex] = out[k] ?? '';
        });
        done += 1;
        onProgress?.({ done, total: batches.length });
      } catch (err) {
        firstError = err;
        throw err;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } catch (err) {
    if (!firstError) firstError = err;
  }
  if (firstError) throw firstError;

  // 兜底：模型偶尔会把整句当成专有名词原样返回，这里逐条强引导重试
  const pending = findUntranslated(list, translations, lang).slice(0, MAX_UNTRANSLATED_RETRY);
  if (pending.length > 0) {
    const fixes = await Promise.all(
      pending.map(async (index) => {
        try {
          const fixed = await translateOne(settings, list[index], { targetLang: lang, signal, strong: true });
          return [index, fixed.text];
        } catch {
          return [index, null];
        }
      }),
    );
    for (const [index, text] of fixes) {
      if (text && text.trim() !== list[index].trim()) translations[index] = text;
    }
  }

  return { translations, targetLang: lang };
}
