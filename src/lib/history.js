/**
 * 翻译历史与用量统计的纯逻辑（不依赖 chrome.* API，可直接单元测试）。
 */

import { normalizeUsage, mergeUsage } from './api.js';

export const HISTORY_KEY = 'ait_history';
export const STATS_KEY = 'ait_stats';
export const PREVIEW_LIMIT = 500;
/** 每日趋势保留的天数上限：更早的每日数据会被裁掉，累计总计不受影响。 */
export const STATS_LIMIT_DAYS = 90;

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

/* ------------------------------------------------------------------ */
/* 用量统计账本                                                        */
/*                                                                     */
/* 统计之所以要独立存储，是因为「翻译记录」里有 URL、页面标题、原文与   */
/* 译文预览这些敏感内容——用户清空它多半是为了隐私；而统计只是一组累计  */
/* 计数，不该被这个动作连带清零。两者存在不同的键里，互不影响。        */
/* ------------------------------------------------------------------ */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 一个可累加的计数桶。 */
function bucketOf(source) {
  return {
    count: Math.max(0, Number(source?.count) || 0),
    tokens: normalizeUsage(source?.tokens),
    inputChars: Math.max(0, Number(source?.inputChars) || 0),
    outputChars: Math.max(0, Number(source?.outputChars) || 0),
    durationMs: Math.max(0, Number(source?.durationMs) || 0),
  };
}

/** 补上平均耗时，作为对外统一的输出形状。 */
function sealed(bucket) {
  return { ...bucket, avgDurationMs: bucket.count ? Math.round(bucket.durationMs / bucket.count) : 0 };
}

/** 就地累加一条记录（调用方需保证 bucket 是新对象）。 */
function addToBucket(bucket, entry) {
  bucket.count += 1;
  bucket.tokens = mergeUsage(bucket.tokens, entry?.tokens);
  bucket.inputChars += Math.max(0, Number(entry?.inputChars) || 0);
  bucket.outputChars += Math.max(0, Number(entry?.outputChars) || 0);
  bucket.durationMs += Math.max(0, Number(entry?.durationMs) || 0);
  return bucket;
}

function sumBuckets(buckets) {
  const acc = bucketOf(null);
  for (const bucket of buckets) {
    acc.count += bucket.count;
    acc.tokens = mergeUsage(acc.tokens, bucket.tokens);
    acc.inputChars += bucket.inputChars;
    acc.outputChars += bucket.outputChars;
    acc.durationMs += bucket.durationMs;
  }
  return acc;
}

/** 空的统计账本。 */
export function createStats() {
  return { v: 1, total: bucketOf(null), byKind: {}, byModel: {}, daily: {} };
}

/** 把 storage 里读到的任意值纠正成合法账本（旧结构 / 脏数据都能安全通过）。 */
export function normalizeStats(raw) {
  const stats = createStats();
  if (!raw || typeof raw !== 'object') return stats;

  stats.total = bucketOf(raw.total);
  for (const [key, value] of Object.entries(raw.byKind || {})) {
    if (key) stats.byKind[key] = bucketOf(value);
  }
  for (const [key, value] of Object.entries(raw.byModel || {})) {
    if (key) stats.byModel[key] = bucketOf(value);
  }
  for (const [key, value] of Object.entries(raw.daily || {})) {
    if (DATE_KEY_RE.test(key)) stats.daily[key] = bucketOf(value);
  }
  return stats;
}

/**
 * 把一条记录累加进账本，返回新的账本（不修改入参）。
 * 纯函数：写入路径据此在 storage 里做读-改-写。
 */
export function accumulateStats(stats, entry) {
  const next = normalizeStats(stats);

  addToBucket(next.total, entry);

  const kind = entry?.kind || 'selection';
  next.byKind[kind] = addToBucket(next.byKind[kind] || bucketOf(null), entry);

  const model = entry?.model || '未知模型';
  next.byModel[model] = addToBucket(next.byModel[model] || bucketOf(null), entry);

  const date = dateKey(Number(entry?.ts) || Date.now());
  next.daily[date] = addToBucket(next.daily[date] || bucketOf(null), entry);

  return next;
}

/** 裁掉过期的每日数据；累计总计与按功能 / 按模型分布保留，它们代表真实发生过的用量。 */
export function pruneStats(stats, now = Date.now()) {
  const next = normalizeStats(stats);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const cutoff = dateKey(startOfToday.getTime() - (STATS_LIMIT_DAYS - 1) * 86400000);
  for (const key of Object.keys(next.daily)) {
    if (key < cutoff) delete next.daily[key];
  }
  return next;
}

/**
 * 把账本展开成管理面板要用的视图（结构与 computeStats 完全一致）。
 * @param {object} stats 账本
 * @param {{days?:number, now?:number}} options
 */
export function statsView(stats, options = {}) {
  const ledger = normalizeStats(stats);
  const days = Math.max(1, Math.min(Number(options.days) || 14, STATS_LIMIT_DAYS));
  const now = Number(options.now) || Date.now();

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const window = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dateKey(startOfToday.getTime() - i * 86400000);
    window.push([key, ledger.daily[key] || bucketOf(null)]);
  }

  return {
    total: sealed(ledger.total),
    today: sealed(window[window.length - 1][1]),
    week: sealed(sumBuckets(window.slice(-Math.min(7, days)).map(([, bucket]) => bucket))),
    byKind: Object.entries(ledger.byKind).map(([kind, bucket]) => ({
      kind,
      label: kindLabel(kind),
      ...sealed(bucket),
    })),
    byModel: Object.entries(ledger.byModel)
      .map(([model, bucket]) => ({ model, ...sealed(bucket) }))
      .sort((a, b) => b.tokens.total - a.tokens.total),
    daily: window.map(([date, bucket]) => ({
      date,
      count: bucket.count,
      tokens: bucket.tokens.total,
      prompt: bucket.tokens.prompt,
      completion: bucket.tokens.completion,
    })),
  };
}

/**
 * 从一组记录现算统计（等价于把每条记录累加进空账本后再展开）。
 * 用于升级回填与测试；管理面板走的是已落盘的账本。
 * @param {Array} entries
 * @param {{days?:number, now?:number}} options
 */
export function computeStats(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const ledger = list.reduce((acc, entry) => accumulateStats(acc, entry), createStats());
  return statsView(ledger, options);
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
