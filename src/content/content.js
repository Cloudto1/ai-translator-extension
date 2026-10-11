/**
 * 内容脚本：全页面翻译 / 划词翻译 / 网页总结。
 * 所有 AI 请求都通过端口转发给后台 Service Worker。
 * UI 全部渲染在 Shadow DOM 中，避免与宿主页面样式互相干扰。
 */

(async () => {
  'use strict';

  if (window.__AIT_LOADED__) {
    return;
  }
  window.__AIT_LOADED__ = true;

  const PORT_NAME = 'ait-port';
  const REQ = {
    TRANSLATE_TEXTS: 'TRANSLATE_TEXTS',
    TRANSLATE_ONE: 'TRANSLATE_ONE',
    SUMMARIZE: 'SUMMARIZE',
    ABORT: 'ABORT',
  };
  const EVT = { RESULT: 'RESULT', DELTA: 'DELTA', ERROR: 'ERROR' };
  const MSG = {
    GET_SETTINGS: 'GET_SETTINGS',
    CMD_TRANSLATE_PAGE: 'CMD_TRANSLATE_PAGE',
    CMD_SUMMARIZE_PAGE: 'CMD_SUMMARIZE_PAGE',
    CMD_TRANSLATE_SELECTION: 'CMD_TRANSLATE_SELECTION',
    RUN_TRANSLATE_PAGE: 'RUN_TRANSLATE_PAGE',
    RUN_SUMMARIZE_PAGE: 'RUN_SUMMARIZE_PAGE',
  };

  const MAX_TEXT_NODES = 1500;
  const REQUEST_TIMEOUT_MS = 180000;

  /* ---------------------------------------------------------------- */
  /* 与后台通信                                                        */
  /* ---------------------------------------------------------------- */

  let port = null;
  let seq = 0;
  const pending = new Map();

  function ensurePort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener((msg) => {
      const entry = pending.get(msg?.id);
      if (!entry) return;
      if (msg.type === 'PROGRESS') {
        entry.handlers?.onProgress?.(msg.data);
      } else if (msg.type === EVT.DELTA) {
        entry.handlers?.onDelta?.(msg.data);
      } else if (msg.type === EVT.RESULT) {
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg.data);
      } else if (msg.type === EVT.ERROR) {
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        const err = new Error(msg.data?.message || '请求失败');
        err.code = msg.data?.code;
        entry.reject(err);
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('与后台连接已断开，请刷新页面后重试。'));
      }
      pending.clear();
    });
    return port;
  }

  function startRequest(type, payload, handlers = {}) {
    const id = `r${Date.now().toString(36)}-${++seq}`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const err = new Error('请求超时，请检查网络或 API 配置。');
        err.code = 'TIMEOUT';
        reject(err);
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, handlers, timer });
      try {
        ensurePort().postMessage({ id, type, payload });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
    return {
      id,
      promise,
      abort() {
        try {
          ensurePort().postMessage({ id: `abort-${id}`, type: REQ.ABORT, payload: { targetId: id } });
        } catch {
          /* ignore */
        }
      },
    };
  }

  async function sendMessage(message) {
    try {
      const res = await chrome.runtime.sendMessage(message);
      return res;
    } catch (err) {
      return { ok: false, message: err?.message || '扩展后台不可用' };
    }
  }

  let settingsCache = null;
  async function getSettings(force = false) {
    if (settingsCache && !force) return settingsCache;
    const res = await sendMessage({ type: MSG.GET_SETTINGS });
    settingsCache = res?.ok ? res.settings : { targetLang: 'auto', pageMode: 'replace', disableThinking: true };
    return settingsCache;
  }

  chrome.storage?.onChanged?.addListener(() => {
    settingsCache = null;
  });

  /* ---------------------------------------------------------------- */
  /* Shadow DOM UI                                                     */
  /* ---------------------------------------------------------------- */

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    /* Shadow DOM 环境下 [hidden] 会被下方的 display 规则覆盖，必须显式声明 */
    [hidden] { display: none !important; }
    .ait-root {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
        "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.6;
      color: #1f2233;
      --ait-primary: #3b6ef5;
      --ait-primary-weak: rgba(59, 110, 245, 0.12);
      --ait-border: rgba(15, 23, 42, 0.12);
      --ait-surface: #ffffff;
      --ait-muted: #6b7280;
      --ait-shadow: 0 12px 32px rgba(15, 23, 42, 0.16), 0 2px 8px rgba(15, 23, 42, 0.08);
    }
    @media (prefers-color-scheme: dark) {
      .ait-root {
        color: #e5e7eb;
        --ait-border: rgba(148, 163, 184, 0.24);
        --ait-surface: #1b1e27;
        --ait-muted: #9aa3b2;
        --ait-shadow: 0 12px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.35);
      }
    }
    button { font: inherit; cursor: pointer; border: none; background: none; color: inherit; }
    .ait-float {
      position: fixed;
      z-index: 2147483646;
      background: var(--ait-surface);
      border: 1px solid var(--ait-border);
      border-radius: 14px;
      box-shadow: var(--ait-shadow);
    }
    .ait-toast-wrap {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: center;
      pointer-events: none;
    }
    .ait-toast {
      pointer-events: auto;
      background: var(--ait-surface);
      border: 1px solid var(--ait-border);
      box-shadow: var(--ait-shadow);
      border-radius: 10px;
      padding: 9px 14px;
      max-width: 460px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .ait-toast.err { border-color: #f87171; color: #b91c1c; }
    @media (prefers-color-scheme: dark) { .ait-toast.err { color: #fca5a5; } }

    .ait-progress {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 12px;
      min-width: 260px;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      border-radius: 999px;
    }
    .ait-bar { flex: 1; height: 5px; border-radius: 4px; background: var(--ait-primary-weak); overflow: hidden; }
    .ait-bar > i { display: block; height: 100%; width: 0%; border-radius: 4px; background: var(--ait-primary); transition: width .25s ease; }
    .ait-progress .ait-label { color: var(--ait-muted); white-space: nowrap; }
    .ait-textbtn { color: var(--ait-primary); padding: 2px 4px; border-radius: 6px; white-space: nowrap; }
    .ait-textbtn:hover { background: var(--ait-primary-weak); }

    .ait-selbtn {
      display: flex; align-items: center; gap: 6px;
      padding: 7px 12px; border-radius: 999px;
      font-weight: 600; color: #fff; background: var(--ait-primary);
      box-shadow: var(--ait-shadow); white-space: nowrap;
    }
    .ait-selbtn:hover { filter: brightness(1.07); }

    .ait-card { width: 380px; max-width: min(88vw, 380px); overflow: hidden; }
    .ait-head {
      display: flex; align-items: center; gap: 8px;
      padding: 9px 12px; border-bottom: 1px solid var(--ait-border);
    }
    .ait-title { font-weight: 600; flex: 1; display: flex; align-items: center; gap: 6px; }
    .ait-tag {
      font-weight: 500; font-size: 11px; padding: 1px 6px; border-radius: 999px;
      background: var(--ait-primary-weak); color: var(--ait-primary);
    }
    .ait-iconbtn { padding: 4px 8px; border-radius: 7px; color: var(--ait-muted); font-size: 12px; }
    .ait-iconbtn:hover { background: var(--ait-primary-weak); color: var(--ait-primary); }
    .ait-body { padding: 11px 13px; max-height: 46vh; overflow: auto; white-space: pre-wrap; word-break: break-word; }
    .ait-orig { padding: 9px 13px; color: var(--ait-muted); border-bottom: 1px dashed var(--ait-border); max-height: 22vh; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
    .ait-foot { padding: 7px 12px; border-top: 1px solid var(--ait-border); color: var(--ait-muted); font-size: 11px; display: flex; justify-content: space-between; gap: 8px; }
    .ait-dots::after { content: ''; animation: ait-dots 1.2s steps(4, end) infinite; }
    @keyframes ait-dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }

    .ait-panel {
      position: fixed; top: 0; right: 0; bottom: 0; width: 420px; max-width: 94vw;
      display: flex; flex-direction: column; border-radius: 0;
      border-left: 1px solid var(--ait-border);
      z-index: 2147483646;
    }
    .ait-panel .ait-body { max-height: none; flex: 1; font-size: 13.5px; }
    .ait-h { font-weight: 700; margin: 10px 0 6px; }
    .ait-h:first-child { margin-top: 0; }
    .ait-p { margin: 0 0 7px; }
    .ait-li { display: flex; gap: 8px; margin: 0 0 6px; }
    .ait-li .ait-dot { color: var(--ait-primary); flex: none; }
    .ait-li .ait-num { font-weight: 600; min-width: 14px; }
    .ait-gap { height: 6px; }
    code { background: var(--ait-primary-weak); padding: 1px 4px; border-radius: 4px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
    .ait-error { color: #dc2626; }
    @media (prefers-color-scheme: dark) { .ait-error { color: #fca5a5; } }
    strong { font-weight: 700; }
    .ait-spin { width: 12px; height: 12px; border: 2px solid var(--ait-primary-weak); border-top-color: var(--ait-primary); border-radius: 50%; display: inline-block; animation: ait-spin .8s linear infinite; }
    @keyframes ait-spin { to { transform: rotate(360deg); } }
    .ait-trans-node { border-bottom: 1px dotted rgba(59, 110, 245, .45); }
  `;

  let ui = null;

  function createUI() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.className = 'ait-host';
    host.setAttribute('data-ait-ui', '1');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    const root = document.createElement('div');
    root.className = 'ait-root';
    root.innerHTML = `
      <div class="ait-toast-wrap"></div>
      <div class="ait-float ait-progress" hidden>
        <span class="ait-spin"></span>
        <span class="ait-label"></span>
        <span class="ait-bar"><i></i></span>
        <button class="ait-textbtn" data-act="cancel">取消</button>
      </div>
      <div class="ait-float ait-selbtn" hidden></div>
      <div class="ait-float ait-card" hidden></div>
      <div class="ait-float ait-panel" hidden></div>
    `;
    shadow.append(style, root);
    (document.body || document.documentElement).appendChild(host);
    ui = {
      host,
      root,
      toasts: root.querySelector('.ait-toast-wrap'),
      progress: root.querySelector('.ait-progress'),
      progressLabel: root.querySelector('.ait-progress .ait-label'),
      progressBar: root.querySelector('.ait-progress .ait-bar > i'),
      progressCancel: root.querySelector('.ait-progress [data-act="cancel"]'),
      selbtn: root.querySelector('.ait-selbtn'),
      card: root.querySelector('.ait-card'),
      panel: root.querySelector('.ait-panel'),
    };
    return ui;
  }

  function toast(message, type = 'info', duration = 3200) {
    const el = createUI();
    const node = document.createElement('div');
    node.className = `ait-toast${type === 'error' ? ' err' : ''}`;
    node.textContent = message;
    el.toasts.appendChild(node);
    setTimeout(() => node.remove(), duration);
  }

  function showProgress(label) {
    const el = createUI();
    el.progressLabel.textContent = label;
    el.progressBar.style.width = '0%';
    el.progress.hidden = false;
    return (done, total, text) => {
      el.progressBar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
      el.progressLabel.textContent = text || `翻译中 ${done}/${total}`;
    };
  }

  function hideProgress() {
    if (ui) ui.progress.hidden = true;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function inlineMd(str) {
    return str.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function renderMarkdown(target, text) {
    const lines = escapeHtml(text).split(/\r?\n/);
    const html = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        html.push('<div class="ait-gap"></div>');
        continue;
      }
      const heading = line.match(/^#{1,4}\s+(.*)$/) || line.match(/^\*\*([^*]+)\*\*[:：]?$/);
      if (heading) {
        html.push(`<div class="ait-h">${inlineMd(heading[1])}</div>`);
        continue;
      }
      const bullet = line.match(/^[-*•]\s+(.*)$/);
      if (bullet) {
        html.push(`<div class="ait-li"><span class="ait-dot">•</span><span>${inlineMd(bullet[1])}</span></div>`);
        continue;
      }
      const numbered = line.match(/^(\d{1,2})[.)、]\s+(.*)$/);
      if (numbered) {
        html.push(`<div class="ait-li"><span class="ait-dot ait-num">${numbered[1]}.</span><span>${inlineMd(numbered[2])}</span></div>`);
        continue;
      }
      html.push(`<div class="ait-p">${inlineMd(line)}</div>`);
    }
    target.innerHTML = html.join('');
  }

  async function copyText(text) {
    const value = String(text ?? '');
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* 全页面翻译                                                        */
  /* ---------------------------------------------------------------- */

  const SKIP_SELECTOR =
    'script,style,noscript,textarea,input,select,option,code,pre,kbd,samp,var,svg,canvas,math,iframe,object,embed,video,audio,template,[contenteditable="true"],[translate="no"],.ait-host,.notranslate,[data-ait-ui]';

  const pageState = {
    running: false,
    originals: new Map(),
    inserted: [],
    request: null,
    active: false,
  };

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (Number(style.opacity) === 0) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return el.getClientRects().length > 0;
  }

  function collectTextNodes() {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        const trimmed = (node.nodeValue || '').trim();
        if (!trimmed) return NodeFilter.FILTER_REJECT;
        if (trimmed.length < 2 && !/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(trimmed)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!/[\p{L}\p{Sc}\p{N}]/u.test(trimmed)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const map = new Map();
    let count = 0;
    let node = walker.nextNode();
    while (node && count < MAX_TEXT_NODES) {
      const text = (node.nodeValue || '').trim();
      if (!map.has(text)) map.set(text, []);
      map.get(text).push({ node, raw: node.nodeValue });
      count += 1;
      node = walker.nextNode();
    }
    return map;
  }

  function restorePage() {
    for (const [node, raw] of pageState.originals) {
      if (node && node.isConnected) node.nodeValue = raw;
    }
    for (const el of pageState.inserted) el.remove();
    pageState.originals.clear();
    pageState.inserted = [];
    pageState.active = false;
    document.documentElement.removeAttribute('data-ait-translated');
  }

  function applyTranslations(textMap, translations, mode) {
    let index = 0;
    let translated = 0;
    for (const [source, entries] of textMap) {
      const target = translations[index++] ?? '';
      if (!target || target.trim() === source) continue;
      for (const entry of entries) {
        const node = entry.node;
        if (!node.isConnected || !node.parentNode) continue;
        if (!pageState.originals.has(node)) pageState.originals.set(node, entry.raw);
        const leading = (entry.raw.match(/^\s*/) || [''])[0];
        const trailing = (entry.raw.match(/\s*$/) || [''])[0];
        node.nodeValue = `${leading}${target}${trailing}`;
        if (mode === 'bilingual') {
          const span = document.createElement('span');
          span.className = 'ait-trans-node notranslate';
          span.textContent = ` ${target}`;
          node.parentNode.insertBefore(span, node.nextSibling);
          pageState.inserted.push(span);
        }
        translated += 1;
      }
    }
    return translated;
  }

  async function translatePage() {
    if (pageState.running) {
      toast('正在翻译中，请稍候…');
      return;
    }
    if (pageState.active) {
      restorePage();
      toast('已恢复原文');
      return;
    }

    const settings = await getSettings(true);
    const textMap = collectTextNodes();
    const texts = [...textMap.keys()];
    if (texts.length === 0) {
      toast('当前页面没有找到可翻译的文本。');
      return;
    }

    pageState.running = true;
    const setProgress = showProgress(`准备翻译 ${texts.length} 段文本…`);

    const request = startRequest(
      REQ.TRANSLATE_TEXTS,
      { texts, targetLang: settings.targetLang },
      {
        onProgress: ({ done, total }) => setProgress(done, total, `正在翻译 ${done}/${total} 批…`),
      },
    );
    pageState.request = request;
    ui.progressCancel.hidden = false;

    try {
      const result = await request.promise;
      const translations = result?.translations || [];
      const count = applyTranslations(textMap, translations, settings.pageMode);
      pageState.active = true;
      document.documentElement.setAttribute('data-ait-translated', '1');
      if (count === 0) {
        toast('没有需要翻译的内容（可能已是目标语言）。');
      } else {
        toast(`已翻译 ${count} 处文本。再次点击“翻译整页”可恢复原文。`, 'info', 4000);
      }
    } catch (err) {
      if (err?.code === 'ABORTED') toast('已取消翻译');
      else toast(err?.message || '翻译失败', 'error', 6000);
    } finally {
      pageState.running = false;
      pageState.request = null;
      hideProgress();
    }
  }

  /* ---------------------------------------------------------------- */
  /* 划词翻译                                                          */
  /* ---------------------------------------------------------------- */

  let selectionRequest = null;
  let lastSelection = { text: '', rect: null };

  function hideSelectionButton() {
    if (ui) ui.selbtn.hidden = true;
  }

  function showSelectionButton(rect, text) {
    const el = createUI();
    const btn = el.selbtn;
    btn.textContent = '译 划词翻译';
    btn.hidden = false;
    const width = btn.offsetWidth || 110;
    const top = rect.bottom + 8 + 34 > window.innerHeight ? Math.max(8, rect.top - 42) : rect.bottom + 8;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
    btn.style.top = `${top}px`;
    btn.style.left = `${left}px`;
    btn.onclick = (event) => {
      event.stopPropagation();
      hideSelectionButton();
      openSelectionCard(rect, text);
    };
  }

  function closeSelectionCard() {
    if (!ui || ui.card.hidden) return;
    ui.card.hidden = true;
    selectionRequest?.abort();
    selectionRequest = null;
  }

  function openSelectionCard(rect, text, { autoStarted = false, settings: preset } = {}) {
    const el = createUI();
    const card = el.card;
    const settings = preset || settingsCache || { targetLang: 'auto' };
    settingsCache = settings;
    const langLabel = settings.targetLang === 'auto' ? '自动（中 ⇄ 英）' : settings.targetLang;
    card.innerHTML = '';
    card.hidden = false;

    const head = document.createElement('div');
    head.className = 'ait-head';
    head.innerHTML = `<div class="ait-title">划词翻译 <span class="ait-tag">${escapeHtml(langLabel)}</span></div>`;
    const actions = document.createElement('div');
    const copyBtn = document.createElement('button');
    copyBtn.className = 'ait-iconbtn';
    copyBtn.textContent = '复制';
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'ait-iconbtn';
    toggleBtn.textContent = '原文';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ait-iconbtn';
    closeBtn.textContent = '✕';
    actions.append(copyBtn, toggleBtn, closeBtn);
    head.appendChild(actions);

    const original = document.createElement('div');
    original.className = 'ait-orig';
    original.textContent = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    original.hidden = true;

    const body = document.createElement('div');
    body.className = 'ait-body';
    body.innerHTML = '<span class="ait-dots">翻译中</span>';

    const foot = document.createElement('div');
    foot.className = 'ait-foot';
    foot.innerHTML = '<span>由你的模型提供翻译</span><span></span>';

    card.append(head, original, body, foot);

    const width = card.offsetWidth || 380;
    const height = card.offsetHeight || 200;
    let top = rect.bottom + 10;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 10);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;

    closeBtn.onclick = closeSelectionCard;
    toggleBtn.onclick = () => {
      original.hidden = !original.hidden;
      toggleBtn.textContent = original.hidden ? '原文' : '隐藏原文';
    };
    copyBtn.onclick = async () => {
      const ok = await copyText(body.dataset.plain || body.textContent);
      toast(ok ? '已复制译文' : '复制失败', ok ? 'info' : 'error');
    };

    if (autoStarted) hideSelectionButton();

    let got = false;
    const request = startRequest(
      REQ.TRANSLATE_ONE,
      { text, targetLang: settings.targetLang },
      {
        onDelta: ({ full }) => {
          got = true;
          body.dataset.plain = full;
          body.textContent = full;
          foot.lastElementChild.textContent = `${full.length} 字`;
        },
      },
    );
    selectionRequest = request;

    request.promise
      .then((result) => {
        const value = result?.text || '';
        if (!value && !got) {
          body.textContent = '未获得翻译结果，请重试。';
          return;
        }
        body.dataset.plain = value || body.textContent;
        body.textContent = value || body.textContent;
        body.dataset.state = 'done';
        foot.lastElementChild.textContent = `${body.dataset.plain.length} 字`;
      })
      .catch((err) => {
        if (err?.code === 'ABORTED') return;
        body.textContent = err?.message || '翻译失败';
        body.dataset.state = 'error';
        body.classList.add('ait-error');
        toast(err?.message || '翻译失败', 'error', 6000);
      });
  }

  function onMouseUp(event) {
    if (event.target?.closest?.('[data-ait-ui]') || event.composedPath?.().some((n) => n?.dataset?.aitUi)) {
      return;
    }
    window.setTimeout(async () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || '';
      if (!text || !selection.rangeCount) {
        hideSelectionButton();
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        hideSelectionButton();
        return;
      }
      const clipped = text.slice(0, 6000);
      lastSelection = { text: clipped, rect };
      const settings = await getSettings();
      if (settings.autoTranslateSelection) {
        openSelectionCard(rect, clipped, { autoStarted: true, settings });
      } else {
        showSelectionButton(rect, clipped);
      }
    }, 10);
  }

  /* ---------------------------------------------------------------- */
  /* 网页总结                                                          */
  /* ---------------------------------------------------------------- */

  let summaryRequest = null;

  function extractPageText() {
    const candidates = ['article', 'main', '[role="main"]', '#content', '.content', '.post', '.article'];
    let best = null;
    let bestScore = 0;
    for (const selector of candidates) {
      for (const el of Array.from(document.querySelectorAll(selector)).slice(0, 4)) {
        const text = el.innerText || '';
        const score = text.length;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
    }
    const container = best && bestScore > 400 ? best : document.body;
    const text = container?.innerText || document.body?.innerText || '';
    return text.slice(0, 120000);
  }

  function closeSummaryPanel() {
    if (!ui || ui.panel.hidden) return;
    ui.panel.hidden = true;
    summaryRequest?.abort();
    summaryRequest = null;
  }

  function openSummaryPanel() {
    const el = createUI();
    const panel = el.panel;
    panel.innerHTML = '';
    panel.hidden = false;

    const head = document.createElement('div');
    head.className = 'ait-head';
    head.innerHTML = '<div class="ait-title">网页总结 <span class="ait-tag">AI</span></div>';
    const actions = document.createElement('div');
    const copyBtn = document.createElement('button');
    copyBtn.className = 'ait-iconbtn';
    copyBtn.textContent = '复制';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ait-iconbtn';
    closeBtn.textContent = '✕';
    actions.append(copyBtn, closeBtn);
    head.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'ait-body';
    body.innerHTML = '<span class="ait-dots">正在阅读并总结</span>';

    const foot = document.createElement('div');
    foot.className = 'ait-foot';
    foot.innerHTML = `<span>${escapeHtml(document.title || location.href)}</span><span></span>`;
    panel.append(head, body, foot);

    closeBtn.onclick = closeSummaryPanel;
    copyBtn.onclick = async () => {
      const ok = await copyText(body.dataset.plain || body.textContent);
      toast(ok ? '已复制总结' : '复制失败', ok ? 'info' : 'error');
    };

    const settings = settingsCache || { targetLang: 'auto' };
    const pageText = extractPageText();

    return startRequest(
      REQ.SUMMARIZE,
      {
        title: document.title,
        url: location.href,
        text: pageText,
        targetLang: settings.targetLang,
        length: settings.summaryLength,
      },
      {
        onDelta: ({ full }) => {
          body.dataset.plain = full;
          renderMarkdown(body, full);
          foot.lastElementChild.textContent = `${full.length} 字`;
        },
      },
    );
  }

  async function summarizePageWithUI() {
    const settings = await getSettings(true);
    if (summaryRequest) {
      closeSummaryPanel();
      toast('已关闭总结面板');
      return;
    }
    const el = createUI();
    if (!el.panel.hidden) {
      closeSummaryPanel();
      toast('已关闭总结面板');
      return;
    }
    const request = openSummaryPanel();
    summaryRequest = request;
    try {
      const result = await request.promise;
      const body = el.panel.querySelector('.ait-body');
      body.dataset.plain = result?.summary || '';
      renderMarkdown(body, result?.summary || '');
      body.dataset.state = 'done';
    } catch (err) {
      const body = el.panel.querySelector('.ait-body');
      if (body && err?.code !== 'ABORTED') {
        body.textContent = err?.message || '总结失败';
        body.dataset.state = 'error';
        body.classList.add('ait-error');
        toast(err?.message || '总结失败', 'error', 6000);
      }
      if (err?.code !== 'ABORTED' && settings) {
        // 保留面板，方便用户阅读错误信息
      }
    } finally {
      summaryRequest = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 事件绑定                                                          */
  /* ---------------------------------------------------------------- */

  document.addEventListener('mouseup', onMouseUp, true);

  document.addEventListener(
    'mousedown',
    (event) => {
      const path = event.composedPath?.() || [];
      const inUI = path.some((n) => n?.dataset?.aitUi || n?.classList?.contains?.('ait-host'));
      if (!inUI) hideSelectionButton();
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        hideSelectionButton();
        closeSelectionCard();
        closeSummaryPanel();
      }
    },
    true,
  );

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const type = msg?.type;
    if (type === 'PING') {
      sendResponse({ ok: true });
      return true;
    }
    if (type === MSG.CMD_TRANSLATE_PAGE || type === MSG.RUN_TRANSLATE_PAGE) {
      getSettings(true).then(() => translatePage());
      sendResponse({ ok: true });
      return true;
    }
    if (type === MSG.CMD_SUMMARIZE_PAGE || type === MSG.RUN_SUMMARIZE_PAGE) {
      summarizePageWithUI();
      sendResponse({ ok: true });
      return true;
    }
    if (type === MSG.CMD_TRANSLATE_SELECTION) {
      const text = (msg.text || window.getSelection()?.toString() || '').trim();
      if (!text) {
        toast('请先选中要翻译的文本。');
        sendResponse({ ok: false });
        return true;
      }
      getSettings(true).then(() => {
        const selection = window.getSelection();
        let rect = null;
        try {
          rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
        } catch {
          rect = null;
        }
        if (!rect || (rect.width === 0 && rect.height === 0)) {
          rect = { top: 80, bottom: 100, left: window.innerWidth / 2 - 190, width: 0, height: 0 };
        }
        openSelectionCard(rect, text.slice(0, 6000), { autoStarted: true });
      });
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  });

  await getSettings();
})();
