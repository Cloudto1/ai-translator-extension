import { DEFAULT_SETTINGS, LANGUAGES, validateSettings } from '../lib/config.js';
import { MSG } from '../lib/protocol.js';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  statusText: $('statusText'),
  tabs: $('tabs'),
  sourceLang: $('sourceLang'),
  targetLang: $('targetLang'),
  swapLang: $('swapLang'),
  langHint: $('langHint'),
  openOptions: $('openOptions'),
  autoTranslateSelection: $('autoTranslateSelection'),
  apiKey: $('apiKey'),
  baseUrl: $('baseUrl'),
  model: $('model'),
  pageMode: $('pageMode'),
  summaryLength: $('summaryLength'),
  disableThinking: $('disableThinking'),
  toggleKey: $('toggleKey'),
  testBtn: $('testBtn'),
  resetBtn: $('resetBtn'),
  testResult: $('testResult'),
  savedHint: $('savedHint'),
};

let settings = { ...DEFAULT_SETTINGS };
let saveTimer = null;

function renderStatus() {
  const errors = validateSettings(settings);
  if (errors.length === 0) {
    els.status.className = 'status is-ok';
    els.statusText.textContent = '已配置，可以开始使用';
  } else {
    els.status.className = 'status is-err';
    els.statusText.textContent = errors[0];
  }
  return errors;
}

const LANG_LABELS = new Map(LANGUAGES.map((item) => [item.value, item.label]));

function langLabel(code) {
  if (!code || code === 'auto') return '自动';
  return LANG_LABELS.get(code) || code;
}

function renderLangHint() {
  const { sourceLang, targetLang } = settings;
  if (sourceLang === 'auto' && targetLang === 'auto') {
    els.langHint.textContent = '自动 = 中 ⇄ 英 互译：中文内容译成英文，其它语言译成中文。';
    els.langHint.style.color = '';
  } else if (sourceLang === targetLang) {
    els.langHint.textContent = '源语言与目标语言相同，翻译时会自动反向处理。';
    els.langHint.style.color = 'var(--err)';
  } else {
    els.langHint.textContent = `当前语言对：${langLabel(sourceLang)} → ${langLabel(targetLang)}`;
    els.langHint.style.color = '';
  }
}

function fillForm() {
  els.sourceLang.value = settings.sourceLang;
  els.targetLang.value = settings.targetLang;
  els.autoTranslateSelection.checked = settings.autoTranslateSelection;
  els.apiKey.value = settings.apiKey;
  els.baseUrl.value = settings.baseUrl;
  els.model.value = settings.model;
  els.pageMode.value = settings.pageMode;
  els.summaryLength.value = settings.summaryLength;
  els.disableThinking.checked = settings.disableThinking;
  renderLangHint();
}

function flashSaved(text = '已保存') {
  els.savedHint.textContent = text;
  els.savedHint.style.color = 'var(--primary)';
  window.clearTimeout(flashSaved.timer);
  flashSaved.timer = window.setTimeout(() => {
    els.savedHint.textContent = '设置会自动保存';
    els.savedHint.style.color = '';
  }, 1600);
}

async function persist(patch, { immediate = true } = {}) {
  settings = { ...settings, ...patch };
  renderStatus();
  renderLangHint();
  const run = async () => {
    const res = await chrome.runtime.sendMessage({ type: MSG.SAVE_SETTINGS, settings });
    if (res?.ok) {
      settings = res.settings;
      flashSaved();
    } else {
      flashSaved('保存失败');
    }
  };
  window.clearTimeout(saveTimer);
  if (immediate) await run();
  else saveTimer = window.setTimeout(run, 400);
}

function switchTab(name) {
  for (const tab of els.tabs.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('is-active', panel.dataset.panel === name);
  }
}

async function runOnActiveTab(command, text) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showTestResult('未找到活动标签页', 'err');
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: MSG.RUN_ON_TAB, tabId: tab.id, command, text });
  if (res?.ok) {
    window.close();
  } else {
    showTestResult(res?.message || '无法在当前页面执行', 'err');
  }
}

function showTestResult(message, kind = '') {
  els.testResult.textContent = message;
  els.testResult.className = `result${kind ? ` is-${kind}` : ''}`;
}

async function testConnection() {
  els.testBtn.disabled = true;
  showTestResult('正在测试连接…');
  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.TEST_CONNECTION,
      settings: {
        apiKey: els.apiKey.value.trim(),
        baseUrl: els.baseUrl.value.trim(),
        model: els.model.value.trim(),
      },
    });
    if (res?.ok) {
      const { latencyMs, reply } = res.result;
      showTestResult(`连接成功 · ${latencyMs} ms · 模型返回「${reply || 'OK'}」`, 'ok');
    } else {
      showTestResult(res?.message || '连接失败', 'err');
    }
  } catch (err) {
    showTestResult(err?.message || '连接失败', 'err');
  } finally {
    els.testBtn.disabled = false;
  }
}

/* ---------------------------------------------------------------- */

/** 源语言与目标语言对「自动」的表述不同，分别生成选项。 */
function buildLangOptions(autoLabel) {
  return LANGUAGES.map(
    (lang) => `<option value="${lang.value}">${lang.value === 'auto' ? autoLabel : lang.label}</option>`,
  ).join('');
}

function initLanguageSelect() {
  els.sourceLang.innerHTML = buildLangOptions('自动识别');
  els.targetLang.innerHTML = buildLangOptions('自动（中 ⇄ 英）');
}

function bindEvents() {
  els.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab) switchTab(tab.dataset.tab);
  });

  for (const action of document.querySelectorAll('.action')) {
    action.addEventListener('click', () => {
      const type = action.dataset.action;
      if (type === 'translate-page') runOnActiveTab(MSG.RUN_TRANSLATE_PAGE);
      else if (type === 'summarize-page') runOnActiveTab(MSG.RUN_SUMMARIZE_PAGE);
      else if (type === 'translate-selection') runOnActiveTab(MSG.RUN_TRANSLATE_SELECTION);
    });
  }

  els.sourceLang.addEventListener('change', () => persist({ sourceLang: els.sourceLang.value }));
  els.targetLang.addEventListener('change', () => persist({ targetLang: els.targetLang.value }));
  els.swapLang.addEventListener('click', () => {
    const source = els.sourceLang.value === 'auto' ? 'en' : els.sourceLang.value;
    const target = els.targetLang.value === 'auto' ? 'zh' : els.targetLang.value;
    els.sourceLang.value = target;
    els.targetLang.value = source;
    persist({ sourceLang: target, targetLang: source });
  });
  els.openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
  els.autoTranslateSelection.addEventListener('change', () =>
    persist({ autoTranslateSelection: els.autoTranslateSelection.checked }),
  );
  els.pageMode.addEventListener('change', () => persist({ pageMode: els.pageMode.value }));
  els.summaryLength.addEventListener('change', () => persist({ summaryLength: els.summaryLength.value }));
  els.disableThinking.addEventListener('change', () => persist({ disableThinking: els.disableThinking.checked }));

  els.apiKey.addEventListener('input', () => persist({ apiKey: els.apiKey.value.trim() }, { immediate: false }));
  els.baseUrl.addEventListener('input', () => persist({ baseUrl: els.baseUrl.value.trim() }, { immediate: false }));
  els.model.addEventListener('input', () => persist({ model: els.model.value.trim() }, { immediate: false }));

  els.toggleKey.addEventListener('click', () => {
    const showing = els.apiKey.type === 'text';
    els.apiKey.type = showing ? 'password' : 'text';
    els.toggleKey.textContent = showing ? '显示' : '隐藏';
  });

  els.testBtn.addEventListener('click', testConnection);

  els.resetBtn.addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: MSG.RESET_SETTINGS });
    if (res?.ok) {
      settings = res.settings;
      fillForm();
      renderStatus();
      flashSaved('已恢复默认');
      showTestResult('');
    }
  });
}

async function init() {
  initLanguageSelect();
  const res = await chrome.runtime.sendMessage({ type: MSG.GET_SETTINGS });
  if (res?.ok) settings = res.settings;
  fillForm();
  bindEvents();
  const errors = renderStatus();
  if (errors.length > 0) switchTab('settings');
}

init();
