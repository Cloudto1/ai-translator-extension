/**
 * chrome.storage 读写封装（仅扩展环境可用）。
 */

import { STORAGE_KEY, DEFAULT_SETTINGS, normalizeSettings } from './config.js';

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
