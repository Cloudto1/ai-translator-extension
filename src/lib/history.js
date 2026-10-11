/**
 * 翻译历史与用量统计的纯逻辑（不依赖 chrome.* API，可直接单元测试）。
 */

import { normalizeUsage, mergeUsage } from './api.js';

export const HISTORY_KEY = 'ait_history';
export const PREVIEW_LIMIT = 500;

export const KIND_LABELS = Object.freeze({
  page: '整页翻译',
  selection: '划词翻译',
  summary: '网页总结',
});

export function kindLabel(kind) {
  return KIND_LABELS[kind] || '翻译';
}

export function clip(text, limit = PREVIEW_LIMIT) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** 把一次操作的原始信息整理成一条历史记录。 */
export function makeEntry(input = {}) {
  const source = String(input.sourcePreview ?? '');
  const tokens = normalizeUsage(input.tokens);
  return {
    id: input.id || `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    ts: input.ts || Date.now(),
    kind: input.kind === 'page' || input.kind === 'summary' ? input.kind : 'selection',
    model: String(input.model || ''),
    sourceLang: input.sourceLang || 'auto',
    targetLang: input.targetLang || 'auto',
    itemCount: Math.max(1, Number(input.itemCount) || 1),
    inputChars: Math.max(0, Number(input.inputChars) || 0),
    outputChars: Math.max(0, Number(input.outputChars) || 0),
    durationMs: Math.max(0, Number(input.durationMs) || 0),
    tokens,
    url: String(input.url || ''),
    title: String(input.title || ''),
    sourcePreview: clip(source),
    resultPreview: clip(input.resultPreview),
    truncated: source.replace(/\s+/g, ' ').trim().length > PREVIEW_LIMIT,
  };
}

/**
 * 历史按时间倒序保存，这里只做截断（保留最新的 limit 条）。
 * 传入非法上限时退回默认值；用户输入的上下限约束由 normalizeSettings 负责。
 */
export function pruneHistory(entries, limit = 300) {
  const max = Number.isFinite(limit) && limit >= 1 ? Math.round(limit) : 300;
  return (Array.isArray(entries) ? entries : []).slice(0, max);
}

/** 合计一组记录。 */
export function sumEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let tokens = normalizeUsage(null);
  let inputChars = 0;
  let outputChars = 0;
  let durationMs = 0;
  for (const entry of list) {
    tokens = mergeUsage(tokens, entry?.tokens);
    inputChars += Number(entry?.inputChars) || 0;
    outputChars += Number(entry?.outputChars) || 0;
    durationMs += Number(entry?.durationMs) || 0;
  }
  return {
    count: list.length,
    tokens,
    inputChars,
    outputChars,
    durationMs,
    avgDurationMs: list.length ? Math.round(durationMs / list.length) : 0,
  };
}

export function dateKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 生成统计信息：总计、按类型、按模型、最近 N 天趋势。
 * @param {Array} entries
 * @param {{days?:number, now?:number}} options
 */
export function computeStats(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const days = Math.max(1, Math.min(Number(options.days) || 14, 90));
  const now = Number(options.now) || Date.now();

  const kindBuckets = new Map();
  const byModel = new Map();
  for (const entry of list) {
    const kind = entry?.kind || 'selection';
    if (!kindBuckets.has(kind)) kindBuckets.set(kind, []);
    kindBuckets.get(kind).push(entry);

    const model = entry?.model || '未知模型';
    const current = byModel.get(model) || { model, count: 0, tokens: normalizeUsage(null) };
    current.count += 1;
    current.tokens = mergeUsage(current.tokens, entry?.tokens);
    byModel.set(model, current);
  }

  const dayBuckets = new Map();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dateKey(startOfToday.getTime() - i * 86400000);
    dayBuckets.set(key, { date: key, count: 0, tokens: normalizeUsage(null), entries: [] });
  }

  const weekAgo = startOfToday.getTime() - 6 * 86400000;
  let todayEntries = [];
  let weekEntries = [];
  for (const entry of list) {
    const ts = Number(entry?.ts) || 0;
    if (ts >= startOfToday.getTime()) todayEntries.push(entry);
    if (ts >= weekAgo) weekEntries.push(entry);
    const bucket = dayBuckets.get(dateKey(ts));
    if (!bucket) continue;
    bucket.count += 1;
    bucket.tokens = mergeUsage(bucket.tokens, entry?.tokens);
    bucket.entries.push(entry);
  }

  return {
    total: sumEntries(list),
    today: sumEntries(todayEntries),
    week: sumEntries(weekEntries),
    byKind: [...kindBuckets.entries()].map(([kind, items]) => ({
      kind,
      label: kindLabel(kind),
      ...sumEntries(items),
    })),
    byModel: [...byModel.values()].sort((a, b) => b.tokens.total - a.tokens.total),
    daily: [...dayBuckets.values()].map(({ date, count, tokens }) => ({
      date,
      count,
      tokens: tokens.total,
      prompt: tokens.prompt,
      completion: tokens.completion,
    })),
  };
}

/** 千分位格式化。 */
export function formatNumber(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('en-US');
}

/** 大数字紧凑显示。 */
export function compactNumber(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

export function formatDuration(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n} ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)} s`;
  return `${Math.floor(n / 60000)} 分 ${Math.round((n % 60000) / 1000)} 秒`;
}

export function formatTime(ts) {
  const d = new Date(Number(ts) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatRelativeTime(ts, now = Date.now()) {
  const diff = now - (Number(ts) || 0);
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
  return formatTime(ts).slice(0, 10);
}
