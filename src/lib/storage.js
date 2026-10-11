/**
 * chrome.storage 读写封装（仅扩展环境可用）。
 */

import { STORAGE_KEY, DEFAULT_SETTINGS, normalizeSettings } from './config.js';
import { HISTORY_KEY, pruneHistory } from './history.js';

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

// 串行化写入，避免多批并发翻译时互相覆盖
let appendQueue = Promise.resolve();

export function appendHistory(entry, limit) {
  appendQueue = appendQueue
    .then(async () => {
      const list = await loadHistory();
      list.unshift(entry);
      await chrome.storage.local.set({ [HISTORY_KEY]: pruneHistory(list, limit) });
      return entry;
    })
    .catch((err) => {
      console.warn('[AI翻译] 写入历史记录失败：', err);
      return entry;
    });
  return appendQueue;
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
