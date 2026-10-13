/**
 * 翻译流水线：分批、调用模型、解析结果、容错重试。
 * 只依赖 api.js / prompts.js，可在 Node 中直接测试。
 */

import { chatCompletion, ApiError, mergeUsage, normalizeUsage } from './api.js';
import {
  buildTranslateMessages,
  buildBatchTranslateMessages,
  resolveLanguagePair,
  detectLanguage,
} from './prompts.js';

/** 一次批量翻译中，最多对多少个「疑似漏译」条目做针对性重试。 */
export const MAX_UNTRANSLATED_RETRY = 8;

/** 粗略估算输出所需 token，避免被截断。 */
export function estimateMaxTokens(texts) {
  const chars = texts.reduce((sum, t) => sum + String(t || '').length, 0);
  return Math.min(16000, Math.max(2048, Math.ceil(chars * 2)));
}

/** 把待翻译文本切成批（按条目数和字符数双限制）。默认值与 RUNTIME_LIMITS 保持一致。 */
export function chunkTexts(texts, { maxChars = 3000, maxItems = 40 } = {}) {
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
export async function translateOne(settings, text, options = {}) {
  const { onDelta, signal, strong = false } = options;
  const pair = resolveLanguagePair(
    {
      sourceLang: options.sourceLang ?? settings.sourceLang,
      targetLang: options.targetLang ?? settings.targetLang,
    },
    text,
  );

  const run = async (useStrong) => {
    const messages = buildTranslateMessages(text, pair.resolvedTarget, {
      strong: useStrong,
      sourceLang: pair.sourceLang,
    });
    const result = await chatCompletion({
      ...commonOptions(settings, messages, [text], signal),
      stream: typeof onDelta === 'function',
      onDelta,
    });
    assertNotTruncated(result);
    return { text: cleanRaw(result.content), usage: normalizeUsage(result.usage) };
  };

  let output = await run(strong);
  let usage = output.usage;
  if (!strong && !output.text) throw new ApiError('模型没有返回翻译结果，请重试。', 'EMPTY_RESULT');
  if (!strong && looksUntranslated(text, output.text, pair.resolvedTarget)) {
    const retry = await run(true);
    if (retry.text) output = retry;
    usage = mergeUsage(usage, retry.usage);
  }
  if (!output.text) throw new ApiError('模型没有返回翻译结果，请重试。', 'EMPTY_RESULT');
  return {
    text: output.text,
    sourceLang: pair.resolvedSource,
    targetLang: pair.resolvedTarget,
    usage,
  };
}

async function translateBatch(settings, texts, lang, signal, sourceLang = 'auto') {
  const messages = buildBatchTranslateMessages(texts, lang, { sourceLang });
  const result = await chatCompletion(commonOptions(settings, messages, texts, signal));
  assertNotTruncated(result);
  const usage = normalizeUsage(result.usage);
  const parsed = parseTranslationArray(result.content, texts.length);
  if (parsed) return { items: parsed, usage };

  // 解析失败：拆半重试；单条时退化为「直接使用返回文本」
  if (texts.length > 1) {
    const mid = Math.ceil(texts.length / 2);
    const left = await translateBatch(settings, texts.slice(0, mid), lang, signal, sourceLang);
    const right = await translateBatch(settings, texts.slice(mid), lang, signal, sourceLang);
    return { items: [...left.items, ...right.items], usage: mergeUsage(mergeUsage(usage, left.usage), right.usage) };
  }
  const fallback = cleanRaw(result.content);
  if (fallback) return { items: [fallback], usage };
  throw new ApiError('模型返回格式无法解析，请重试。', 'PARSE_ERROR', result.content);
}

/**
 * 解析本次批量请求最终生效的语言对。
 * 缓存键必须用同一个函数取目标语言，否则后台与 translateTexts 的口径会漂移，
 * 出现「按 A 语言查缓存、按 B 语言翻译」的错配。
 */
export function resolveRequestLanguagePair(settings, texts, overrides = {}) {
  const sample = (texts || []).join('\n').slice(0, 2000);
  return resolveLanguagePair(
    {
      sourceLang: overrides.sourceLang ?? settings?.sourceLang,
      targetLang: overrides.targetLang ?? settings?.targetLang,
    },
    sample,
  );
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
  const empty = {
    translations: [],
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    usage: normalizeUsage(null),
    requestCount: 0,
  };
  if (list.length === 0) return empty;

  const pair = resolveRequestLanguagePair(settings, list, {
    sourceLang: opts.sourceLang,
    targetLang: opts.targetLang,
  });
  const lang = pair.resolvedTarget;
  const translations = new Array(list.length).fill('');
  let requestCount = 0;

  if (list.length === 1) {
    const one = await translateOne(settings, list[0], {
      sourceLang: pair.sourceLang,
      targetLang: lang,
      signal,
    });
    translations[0] = one.text;
    onProgress?.({ done: 1, total: 1 });
    return {
      translations,
      sourceLang: pair.resolvedSource,
      targetLang: lang,
      usage: one.usage,
      requestCount: 1,
    };
  }

  const batches = chunkTexts(list, limits);
  let done = 0;
  let cursor = 0;
  let usage = normalizeUsage(null);
  const concurrency = Math.max(1, Math.min(limits.concurrency || 3, batches.length));
  let firstError = null;

  // 内部中止开关：任何一批失败后整次翻译注定作废，其余在途批次继续跑只会白烧 Token。
  // 外部 signal（用户取消）会联动到它，所以对外语义不变。
  const abortAll = new AbortController();
  const onExternalAbort = () => abortAll.abort();
  if (signal?.aborted) abortAll.abort();
  else signal?.addEventListener('abort', onExternalAbort, { once: true });

  const worker = async () => {
    for (;;) {
      const batchIndex = cursor;
      cursor += 1;
      if (batchIndex >= batches.length) return;
      if (firstError) return;
      const indices = batches[batchIndex];
      const payload = indices.map((i) => list[i]);
      try {
        const out = await translateBatch(settings, payload, lang, abortAll.signal, pair.sourceLang);
        requestCount += 1;
        usage = mergeUsage(usage, out.usage);
        indices.forEach((globalIndex, k) => {
          translations[globalIndex] = out.items[k] ?? '';
        });
        done += 1;
        onProgress?.({ done, total: batches.length });
      } catch (err) {
        // 只记第一个：后到的多半是被我们主动中止引发的 ABORTED，不能盖掉真正的根因
        if (!firstError) {
          firstError = err;
          abortAll.abort();
        }
        throw err;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } catch (err) {
    if (!firstError) firstError = err;
  } finally {
    signal?.removeEventListener('abort', onExternalAbort);
  }
  if (firstError) throw firstError;

  // 兜底：模型偶尔会把整句当成专有名词原样返回，这里逐条强引导重试
  const pending = findUntranslated(list, translations, lang).slice(0, MAX_UNTRANSLATED_RETRY);
  if (pending.length > 0) {
    const fixes = await Promise.all(
      pending.map(async (index) => {
        try {
          const fixed = await translateOne(settings, list[index], {
            sourceLang: pair.sourceLang,
            targetLang: lang,
            signal,
            strong: true,
          });
          requestCount += 1;
          usage = mergeUsage(usage, fixed.usage);
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

  return {
    translations,
    sourceLang: pair.resolvedSource,
    targetLang: lang,
    usage,
    requestCount,
  };
}
