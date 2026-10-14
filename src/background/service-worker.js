/**
 * 后台 Service Worker：
 * - 集中承担所有 AI 请求（避免页面 CORS 限制）
 * - 右键菜单 / 快捷键 / 扩展图标消息路由
 * - 通过长连接端口提供流式输出
 */

import { MSG, PORT_NAME, REQ, EVT } from '../lib/protocol.js';
import {
  getSettings,
  saveSettings,
  resetSettings,
  appendHistory,
  loadCache,
  updateCache,
  clearCache,
} from '../lib/storage.js';
import {
  isExtensionSender,
  isPrivilegedMessage,
  isAllowedTabCommand,
  settingsForContent,
} from '../lib/access.js';
import { makeEntry } from '../lib/history.js';
import { translateTexts, translateOne, resolveRequestLanguagePair } from '../lib/translate.js';
import { summarizePage } from '../lib/summarize.js';
import { testConnection, normalizeUsage } from '../lib/api.js';
import { RUNTIME_LIMITS, validateSettings } from '../lib/config.js';
import {
  siteKeyOf,
  lookupTranslations,
  putTranslations,
  isCacheable,
  cacheSizeBytes,
  DEFAULT_CACHE_LIMIT,
} from '../lib/cache.js';

/** 单次批量翻译请求的条目数上限：内容脚本单轮最多收集 1500 处，留足余量即可。 */
const MAX_TEXTS_PER_REQUEST = 5000;

const MENUS = [
  { id: 'ait-translate-selection', title: 'AI 翻译：翻译选中文本', contexts: ['selection'] },
  { id: 'ait-translate-page', title: 'AI 翻译：翻译整个页面', contexts: ['page'] },
  { id: 'ait-summarize-page', title: 'AI 翻译：总结此页面', contexts: ['page'] },
];

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const item of MENUS) {
      chrome.contextMenus.create(item, () => void chrome.runtime.lastError);
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  getSettings().catch(() => {});
});

chrome.runtime.onStartup.addListener(createMenus);

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function errorPayload(err) {
  if (!err) return { message: '未知错误', code: 'UNKNOWN' };
  return {
    message: err.message || String(err),
    code: err.code || 'ERROR',
  };
}

function assertConfigured(settings) {
  const errors = validateSettings(settings);
  if (errors.length > 0) {
    const err = new Error(`${errors.join('；')}。请点击扩展图标进入设置。`);
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
}

/** 消息是否来自扩展自己的页面（popup / 管理面板），而不是注入网页的内容脚本。 */
const isExtensionPage = (sender) =>
  isExtensionSender(sender, { id: chrome.runtime.id, origin: chrome.runtime.getURL('') });

/** 确保目标标签页已注入内容脚本。 */
async function ensureContent(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (res?.ok) return true;
  } catch {
    /* 未注入，继续注入 */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] });
    return true;
  } catch (err) {
    console.warn('[AI翻译] 注入内容脚本失败：', err);
    return false;
  }
}

/**
 * 记录一次翻译/总结到历史，用于管理面板的历史列表与 Token 统计。
 * 历史写入失败不影响主流程。
 */
async function recordHistory(fields) {
  try {
    const settings = await getSettings();
    await appendHistory(makeEntry(fields), settings.historyLimit);
  } catch (err) {
    console.warn('[AI翻译] 记录历史失败：', err);
  }
}

/**
 * 向标签页下发指令；message 必须是形如 { type: '...' } 的完整消息对象。
 * @returns {Promise<boolean>} 是否成功投递（浏览器内置页、扩展商店等受限页面会失败）
 */
async function notifyTab(tabId, message) {
  const injected = await ensureContent(tabId);
  if (!injected) return false;
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch (err) {
    console.warn('[AI翻译] 消息投递失败：', err);
    return false;
  }
}

/**
 * 广播「缓存已清空」。
 * 页面里还有一份进程内翻译记忆，不同步清掉的话用户会以为缓存没生效。
 * 这里直接 sendMessage，不用 notifyTab —— 不该为了广播去往无关标签页注入脚本。
 */
async function broadcastCacheCleared() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .filter((tab) => tab.id)
        .map((tab) => chrome.tabs.sendMessage(tab.id, { type: MSG.CACHE_CLEARED }).catch(() => {})),
    );
  } catch (err) {
    console.warn('[AI翻译] 广播缓存清空失败：', err);
  }
}

/* ------------------------------------------------------------------ */
/* 右键菜单与快捷键                                                    */
/* ------------------------------------------------------------------ */

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'ait-translate-selection') {
    const text = (info.selectionText || '').trim();
    notifyTab(tab.id, { type: MSG.CMD_TRANSLATE_SELECTION, text });
    return;
  }
  if (info.menuItemId === 'ait-translate-page') {
    notifyTab(tab.id, { type: MSG.CMD_TRANSLATE_PAGE });
    return;
  }
  if (info.menuItemId === 'ait-summarize-page') {
    notifyTab(tab.id, { type: MSG.CMD_SUMMARIZE_PAGE });
  }
});

/* ------------------------------------------------------------------ */
/* 一次性消息（popup / content）                                       */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;
  if (!type) return undefined;

  if (isPrivilegedMessage(type) && !isExtensionPage(sender)) {
    sendResponse({ ok: false, message: '无权限执行该操作', code: 'FORBIDDEN' });
    return false;
  }

  if (type === MSG.GET_SETTINGS) {
    const fromPage = isExtensionPage(sender);
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings: fromPage ? settings : settingsForContent(settings) }))
      .catch((err) => sendResponse({ ok: false, ...errorPayload(err) }));
    return true;
  }

  if (type === MSG.SAVE_SETTINGS) {
    saveSettings(msg.settings)
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((err) => sendResponse({ ok: false, ...errorPayload(err) }));
    return true;
  }

  if (type === MSG.RUN_ON_TAB) {
    const tabId = msg.tabId;
    if (!tabId) {
      sendResponse({ ok: false, message: '未找到活动标签页' });
      return true;
    }
    if (!isAllowedTabCommand(msg.command)) {
      sendResponse({ ok: false, message: '不支持的操作', code: 'BAD_REQUEST' });
      return true;
    }
    notifyTab(tabId, { type: msg.command, text: msg.text })
      .then((delivered) =>
        sendResponse(
          delivered
            ? { ok: true }
            : { ok: false, message: '当前页面不支持翻译（如浏览器内置页、扩展商店等受限页面），请切换到普通网页后再试。' },
        ),
      )
      .catch((err) => sendResponse({ ok: false, ...errorPayload(err) }));
    return true;
  }

  if (type === MSG.GET_CACHE_STATS) {
    loadCache()
      .then((entries) => sendResponse({ ok: true, count: entries.length, bytes: cacheSizeBytes(entries) }))
      .catch((err) => sendResponse({ ok: false, ...errorPayload(err) }));
    return true;
  }

  if (type === MSG.CLEAR_CACHE) {
    clearCache()
      .then(() => broadcastCacheCleared())
      .then(() => sendResponse({ ok: true, count: 0, bytes: 0 }))
      .catch((err) => sendResponse({ ok: false, ...errorPayload(err) }));
    return true;
  }

  if (type === MSG.RESET_SETTINGS) {
    resetSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((err) => sendResponse({ ok: false, ...errorPayload(err) }));
    return true;
  }

  if (type === MSG.TEST_CONNECTION) {
    (async () => {
      const settings = await getSettings();
      const merged = { ...settings, ...(msg.settings || {}) };
      assertConfigured(merged);
      return testConnection(merged);
    })()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, ...errorPayload(err) }));
    return true;
  }

  if (type === MSG.STATE_CHANGED) {
    // content 上报状态，转发给 popup（若有）
    chrome.runtime.sendMessage({ type: MSG.STATE_CHANGED, state: msg.state, tabId: sender?.tab?.id }).catch(() => {});
    return undefined;
  }

  if (type === MSG.OPEN_OPTIONS) {
    chrome.runtime.openOptionsPage?.();
    return undefined;
  }

  return undefined;
});

/* ------------------------------------------------------------------ */
/* 长连接端口：批量翻译 + 流式翻译/总结                                 */
/* ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const controllers = new Map();

  const post = (payload) => {
    try {
      port.postMessage(payload);
    } catch {
      /* 端口已断开 */
    }
  };

  port.onMessage.addListener(async (msg) => {
    const { id, type, payload } = msg || {};
    if (!id) return;

    if (type === REQ.ABORT) {
      controllers.get(payload?.targetId)?.abort();
      return;
    }

    const controller = new AbortController();
    controllers.set(id, controller);
    const startedAt = Date.now();
    const meta = payload?.meta || {};

    try {
      const settings = await getSettings();
      assertConfigured(settings);

      if (type === REQ.TRANSLATE_TEXTS) {
        if (!Array.isArray(payload?.texts) || payload.texts.length > MAX_TEXTS_PER_REQUEST) {
          const err = new Error('翻译请求格式不正确或条目过多。');
          err.code = 'BAD_REQUEST';
          throw err;
        }
        const texts = payload.texts.map((t) => String(t ?? ''));

        // 按站点缓存：同站跨页面复用译文，避免站内导航或刷新时把导航栏、页脚、按钮重新翻一遍
        const site = settings.cacheEnabled === false ? '' : siteKeyOf(meta.url || '');
        const targetKey = site
          ? resolveRequestLanguagePair(settings, texts, {
              sourceLang: payload?.sourceLang,
              targetLang: payload?.targetLang,
            }).resolvedTarget
          : '';

        let cached = [];
        let values = new Array(texts.length);
        let missTexts = texts;
        let missIndexes = texts.map((_, i) => i);
        if (site) {
          cached = await loadCache();
          ({ values, missTexts, missIndexes } = lookupTranslations(cached, site, targetKey, texts));
        }

        let translations = values;
        let sourceLang = settings.sourceLang;
        let targetLang = targetKey;
        let usage = normalizeUsage(null);
        let requestCount = 0;

        // 只有未命中的部分才发给模型
        if (missTexts.length > 0) {
          const result = await translateTexts(settings, missTexts, {
            sourceLang: payload?.sourceLang,
            targetLang: payload?.targetLang,
            signal: controller.signal,
            limits: RUNTIME_LIMITS,
            onProgress: (progress) => post({ id, type: 'PROGRESS', data: progress }),
          });
          translations = values.slice();
          missIndexes.forEach((originalIndex, k) => {
            translations[originalIndex] = result.translations[k] ?? '';
          });
          sourceLang = result.sourceLang;
          targetLang = result.targetLang;
          usage = result.usage;
          requestCount = result.requestCount || 0;

          // 没有可入缓的内容就不写盘，避免每次整页翻译都重写整个缓存。
          // 用 updateCache 在写入时刻重新读取：多个标签页并发翻译时，拿开头读到的快照去写会互相覆盖。
          if (site && missTexts.some((src, i) => isCacheable(src, result.translations[i]))) {
            await updateCache((latest) =>
              putTranslations(latest, site, result.targetLang, missTexts, result.translations, {
                limit: DEFAULT_CACHE_LIMIT,
              }),
            );
          }
        }

        post({
          id,
          type: EVT.RESULT,
          data: {
            translations,
            sourceLang,
            targetLang,
            usage,
            cachedCount: texts.length - missTexts.length,
          },
        });

        // 全部命中缓存时不写历史：这次没有真的调用模型，记进去会污染调用次数与 Token 统计
        if (requestCount > 0) {
          await recordHistory({
            kind: 'page',
            ts: startedAt,
            durationMs: Date.now() - startedAt,
            model: settings.model,
            sourceLang,
            targetLang,
            itemCount: texts.length,
            inputChars: texts.reduce((sum, t) => sum + String(t || '').length, 0),
            outputChars: translations.reduce((sum, t) => sum + String(t || '').length, 0),
            tokens: usage,
            url: meta.url || '',
            title: meta.title || '',
            sourcePreview: texts.join(' '),
            resultPreview: translations.join(' '),
          });
        }
        return;
      }

      if (type === REQ.TRANSLATE_ONE) {
        const sourceText = String(payload?.text || '').slice(0, RUNTIME_LIMITS.selectionMaxChars);
        const result = await translateOne(settings, sourceText, {
          sourceLang: payload?.sourceLang,
          targetLang: payload?.targetLang,
          signal: controller.signal,
          onDelta: (delta, full) => post({ id, type: EVT.DELTA, data: { delta, full } }),
        });
        post({ id, type: EVT.RESULT, data: result });
        await recordHistory({
          kind: 'selection',
          ts: startedAt,
          durationMs: Date.now() - startedAt,
          model: settings.model,
          sourceLang: result.sourceLang,
          targetLang: result.targetLang,
          itemCount: 1,
          inputChars: sourceText.length,
          outputChars: result.text.length,
          tokens: result.usage,
          url: meta.url || '',
          title: meta.title || '',
          sourcePreview: sourceText,
          resultPreview: result.text,
        });
        return;
      }

      if (type === REQ.SUMMARIZE) {
        const pageText = String(payload?.text || '');
        const result = await summarizePage(settings, {
          title: payload?.title || '',
          url: payload?.url || '',
          text: pageText,
          targetLang: payload?.targetLang,
          length: payload?.length,
          signal: controller.signal,
          onDelta: (delta, full) => post({ id, type: EVT.DELTA, data: { delta, full } }),
        });
        post({ id, type: EVT.RESULT, data: result });
        await recordHistory({
          kind: 'summary',
          ts: startedAt,
          durationMs: Date.now() - startedAt,
          model: settings.model,
          sourceLang: result.sourceLang,
          targetLang: result.targetLang,
          itemCount: 1,
          inputChars: pageText.length,
          outputChars: result.summary.length,
          tokens: result.usage,
          url: payload?.url || '',
          title: payload?.title || '',
          sourcePreview: payload?.title || pageText,
          resultPreview: result.summary,
        });
        return;
      }

      post({ id, type: EVT.ERROR, data: { message: `未知请求类型：${type}`, code: 'BAD_REQUEST' } });
    } catch (err) {
      post({ id, type: EVT.ERROR, data: errorPayload(err) });
    } finally {
      controllers.delete(id);
    }
  });

  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    for (const controller of controllers.values()) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
    controllers.clear();
  });
});
