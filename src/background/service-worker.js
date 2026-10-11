/**
 * 后台 Service Worker：
 * - 集中承担所有 AI 请求（避免页面 CORS 限制）
 * - 右键菜单 / 快捷键 / 扩展图标消息路由
 * - 通过长连接端口提供流式输出
 */

import { MSG, PORT_NAME, REQ, EVT } from '../lib/protocol.js';
import { getSettings, saveSettings, resetSettings, appendHistory } from '../lib/storage.js';
import { makeEntry } from '../lib/history.js';
import { translateTexts, translateOne } from '../lib/translate.js';
import { summarizePage } from '../lib/summarize.js';
import { testConnection } from '../lib/api.js';
import { RUNTIME_LIMITS, validateSettings } from '../lib/config.js';

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

/** 向标签页下发指令；message 必须是形如 { type: '...' } 的完整消息对象。 */
async function notifyTab(tabId, message) {
  const injected = await ensureContent(tabId);
  if (!injected) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    console.warn('[AI翻译] 消息投递失败：', err);
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

chrome.commands?.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === 'translate-page') notifyTab(tab.id, { type: MSG.CMD_TRANSLATE_PAGE });
  if (command === 'summarize-page') notifyTab(tab.id, { type: MSG.CMD_SUMMARIZE_PAGE });
  if (command === 'translate-selection') notifyTab(tab.id, { type: MSG.CMD_TRANSLATE_SELECTION });
});

/* ------------------------------------------------------------------ */
/* 一次性消息（popup / content）                                       */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;
  if (!type) return undefined;

  if (type === MSG.GET_SETTINGS) {
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
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
    notifyTab(tabId, { type: msg.command, text: msg.text })
      .then(() => sendResponse({ ok: true }))
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
        const texts = payload?.texts || [];
        const result = await translateTexts(settings, texts, {
          sourceLang: payload?.sourceLang,
          targetLang: payload?.targetLang,
          signal: controller.signal,
          limits: RUNTIME_LIMITS,
          onProgress: (progress) => post({ id, type: 'PROGRESS', data: progress }),
        });
        post({
          id,
          type: EVT.RESULT,
          data: {
            translations: result.translations,
            sourceLang: result.sourceLang,
            targetLang: result.targetLang,
            usage: result.usage,
          },
        });
        await recordHistory({
          kind: 'page',
          ts: startedAt,
          durationMs: Date.now() - startedAt,
          model: settings.model,
          sourceLang: result.sourceLang,
          targetLang: result.targetLang,
          itemCount: texts.length,
          inputChars: texts.reduce((sum, t) => sum + String(t || '').length, 0),
          outputChars: result.translations.reduce((sum, t) => sum + String(t || '').length, 0),
          tokens: result.usage,
          url: meta.url || '',
          title: meta.title || '',
          sourcePreview: texts.join(' '),
          resultPreview: result.translations.join(' '),
        });
        return;
      }

      if (type === REQ.TRANSLATE_ONE) {
        const sourceText = payload?.text || '';
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
        const pageText = payload?.text || '';
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
