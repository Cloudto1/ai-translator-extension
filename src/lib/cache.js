/**
 * 翻译缓存（纯逻辑，不依赖 chrome.*，可在 Node 中直接测试）。
 *
 * 作用域：**按站点隔离**。同一站点内跨页面复用译文，避免站内导航时把导航栏、
 * 页脚、按钮这类重复文案重新翻一遍、重复付费。
 *
 * 为什么不做全局共享：同一个词在不同站点语义可能不同（如 Spring 在园艺站是
 * "春天"、在开发站是框架名），跨站复用会把译文串味。
 */

export const CACHE_KEY = 'ait_translation_cache';
export const DEFAULT_CACHE_LIMIT = 5000;

/** 超过这个长度的原文不缓存：长文几乎不会重复出现，存着只占地方。 */
export const MAX_CACHED_SOURCE_CHARS = 1000;

/**
 * 站点标识：取 hostname 并去掉前导 www.。
 *
 * 刻意不用 eTLD+1：没有公共后缀表时 `user.github.io` 会被错并成一个站点，
 * 所有 GitHub Pages 会共享缓存 —— 那正是要避免的跨站串味。用 hostname 最稳。
 * @returns {string} 无法解析时返回空串（调用方据此跳过缓存）
 */
export function siteKeyOf(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 缓存键：站点 + 目标语言 + 原文。目标语言必须参与，否则切换语言后会复用错译文。 */
export function cacheKeyOf(site, targetLang, source) {
  return `${site}\u0000${targetLang}\u0000${source}`;
}

/**
 * 逐条查缓存。
 * @param {Array<{k:string,v:string,t:number}>} entries 最近使用在前
 * @returns {{values:(string|undefined)[], missTexts:string[], missIndexes:number[]}}
 *   values 与入参 texts 等长，命中的位置为译文、未命中的位置为 undefined。
 */
export function lookupTranslations(entries, site, targetLang, texts) {
  const map = new Map();
  for (const entry of entries) {
    if (entry && entry.k) map.set(entry.k, entry.v);
  }
  // 显式填 undefined，避免留下稀疏数组（sparse array）让下游比较与遍历踩坑
  const values = new Array(texts.length).fill(undefined);
  const missTexts = [];
  const missIndexes = [];
  texts.forEach((text, i) => {
    const hit = map.get(cacheKeyOf(site, targetLang, text));
    if (typeof hit === 'string') {
      values[i] = hit;
    } else {
      missIndexes.push(i);
      missTexts.push(text);
    }
  });
  return { values, missTexts, missIndexes };
}

/** 这条结果值不值得缓存：空译文、原文与译文相同、超长原文都跳过。 */
export function isCacheable(source, translation) {
  const src = String(source ?? '');
  const dst = String(translation ?? '');
  if (!src.trim() || !dst.trim()) return false;
  if (dst.trim() === src.trim()) return false;
  if (src.length > MAX_CACHED_SOURCE_CHARS) return false;
  return true;
}

/**
 * 写入若干条译文并按上限裁剪，返回新数组（最近使用在前）。
 * 已存在的键会被更新并移到最前，实现 LRU。
 */
export function putTranslations(
  entries,
  site,
  targetLang,
  sources,
  translations,
  { now = Date.now(), limit = DEFAULT_CACHE_LIMIT } = {},
) {
  const store = new Map();
  // 入参是「最近使用在前」，倒着放进去，让 Map 的插入顺序变成从旧到新
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry && entry.k) store.set(entry.k, entry);
  }
  sources.forEach((src, i) => {
    const dst = translations[i];
    if (!isCacheable(src, dst)) return;
    const key = cacheKeyOf(site, targetLang, src);
    store.delete(key); // 先删再写，保证重新落到末尾（Map 保序）
    store.set(key, { k: key, v: String(dst), t: now });
  });
  // 倒序后即为「最近使用在前」
  return pruneCache([...store.values()].reverse(), limit);
}

/** 超出上限时丢掉最久未用的（数组尾部）。 */
export function pruneCache(entries, limit = DEFAULT_CACHE_LIMIT) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.round(limit) : DEFAULT_CACHE_LIMIT;
  return entries.slice(0, max);
}

/** 粗略估算占用字节数，用于设置页展示。 */
export function cacheSizeBytes(entries) {
  let bytes = 0;
  for (const entry of entries) {
    if (!entry) continue;
    // 键与值按 UTF-16 计，再算上少量结构开销
    bytes += (String(entry.k || '').length + String(entry.v || '').length) * 2 + 40;
  }
  return bytes;
}
