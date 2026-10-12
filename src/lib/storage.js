/**
 * chrome.storage 读写封装（仅扩展环境可用）。
 */

import { STORAGE_KEY, DEFAULT_SETTINGS, normalizeSettings } from './config.js';
import {
  HISTORY_KEY,
  STATS_KEY,
  pruneHistory,
  createStats,
  normalizeStats,
  accumulateStats,
  pruneStats,
} from './history.js';
import { CACHE_KEY } from './cache.js';

function area() {
  return chrome.storage?.sync || chrome.storage?.local;
}

export async function getSettings() {
  try {
    const data = await area().get(STORAGE_KEY);
    return normalizeSettings(data?.[STORAGE_KEY]);
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...(patch || {}) });
  await area().set({ [STORAGE_KEY]: next });
  return next;
}

export async function resetSettings() {
  const next = normalizeSettings(DEFAULT_SETTINGS);
  await area().set({ [STORAGE_KEY]: next });
  return next;
}

export function onSettingsChanged(callback) {
  const handler = (changes, namespace) => {
    if (namespace !== 'sync' && namespace !== 'local') return;
    if (!changes[STORAGE_KEY]) return;
    callback(normalizeSettings(changes[STORAGE_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/* ------------------------------------------------------------------ */
/* 翻译历史（存放在 local，避免占用 sync 配额）                        */
/* ------------------------------------------------------------------ */

export async function loadHistory() {
  try {
    const data = await chrome.storage.local.get(HISTORY_KEY);
    return Array.isArray(data?.[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  } catch {
    return [];
  }
}

// 串行化写入，避免多批并发翻译 / 首次回填时互相覆盖
let writeQueue = Promise.resolve();

export function appendHistory(entry, limit) {
  writeQueue = writeQueue
    .then(async () => {
      const raw = await chrome.storage.local.get([HISTORY_KEY, STATS_KEY]);
      const list = Array.isArray(raw[HISTORY_KEY]) ? raw[HISTORY_KEY] : [];

      // 老版本只存了记录、没有账本：先用现有记录回填，再累加本次
      const ledger =
        raw[STATS_KEY] !== undefined
          ? normalizeStats(raw[STATS_KEY])
          : list.reduce((acc, item) => accumulateStats(acc, item), createStats());

      // 记录与账本一次写入，只触发一次 onChanged
      await chrome.storage.local.set({
        [HISTORY_KEY]: pruneHistory([entry, ...list], limit),
        [STATS_KEY]: pruneStats(accumulateStats(ledger, entry)),
      });
      return entry;
    })
    .catch((err) => {
      console.warn('[AI翻译] 写入历史记录失败：', err);
      return entry;
    });
  return writeQueue;
}

export async function deleteHistoryEntry(id) {
  const list = await loadHistory();
  const next = list.filter((item) => item?.id !== id);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  return next;
}

export async function clearHistory() {
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  return [];
}

/** 按新的上限裁剪历史（用户调小 historyLimit 时调用）。 */
export async function trimHistory(limit) {
  const list = await loadHistory();
  const next = pruneHistory(list, limit);
  if (next.length !== list.length) await chrome.storage.local.set({ [HISTORY_KEY]: next });
  return next;
}

export function onHistoryChanged(callback) {
  const handler = (changes, namespace) => {
    if (namespace !== 'local') return;
    if (!changes[HISTORY_KEY]) return;
    callback(Array.isArray(changes[HISTORY_KEY].newValue) ? changes[HISTORY_KEY].newValue : []);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/* ------------------------------------------------------------------ */
/* 用量统计账本（与翻译记录分开存储，清空记录不会影响它）               */
/* ------------------------------------------------------------------ */

export async function loadStats() {
  try {
    const data = await chrome.storage.local.get(STATS_KEY);
    return normalizeStats(data?.[STATS_KEY]);
  } catch {
    return createStats();
  }
}

/**
 * 首次读取时回填：老版本只存了历史记录，没有账本，用现有记录现算一次并落盘。
 * 键已存在就原样返回——显式「清空统计」写的是空账本而非删键，所以不会被回填复活。
 */
export function ensureStats(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let result = createStats();

  // 与 appendHistory 共用一条写入队列，避免并发下读-改-写互相覆盖
  writeQueue = writeQueue
    .then(async () => {
      const raw = await chrome.storage.local.get(STATS_KEY);
      if (raw?.[STATS_KEY] !== undefined) {
        result = normalizeStats(raw[STATS_KEY]);
        return result;
      }
      result = pruneStats(list.reduce((acc, entry) => accumulateStats(acc, entry), createStats()));
      await chrome.storage.local.set({ [STATS_KEY]: result });
      return result;
    })
    .catch((err) => {
      console.warn('[AI翻译] 初始化用量统计失败：', err);
      return result;
    });
  return writeQueue;
}

/** 清空账本：写入空账本而不是删键——键存在代表「已经初始化过」，不会被历史回填。 */
export function clearStats() {
  const empty = createStats();
  writeQueue = writeQueue
    .then(async () => {
      await chrome.storage.local.set({ [STATS_KEY]: empty });
      return empty;
    })
    .catch((err) => {
      console.warn('[AI翻译] 清空用量统计失败：', err);
      return empty;
    });
  return writeQueue;
}

export function onStatsChanged(callback) {
  const handler = (changes, namespace) => {
    if (namespace !== 'local') return;
    if (!changes[STATS_KEY]) return;
    callback(normalizeStats(changes[STATS_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/* ------------------------------------------------------------------ */
/* 翻译缓存（存放在 local，跨页面 / 刷新后依然可用）                    */
/* ------------------------------------------------------------------ */

export async function loadCache() {
  try {
    const data = await chrome.storage.local.get(CACHE_KEY);
    return Array.isArray(data?.[CACHE_KEY]) ? data[CACHE_KEY] : [];
  } catch {
    return [];
  }
}

export async function saveCache(entries) {
  const list = Array.isArray(entries) ? entries : [];
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: list });
  } catch (err) {
    console.warn('[AI翻译] 写入翻译缓存失败：', err);
  }
  return list;
}

export async function clearCache() {
  try {
    await chrome.storage.local.remove(CACHE_KEY);
  } catch (err) {
    console.warn('[AI翻译] 清空翻译缓存失败：', err);
  }
  return [];
}
