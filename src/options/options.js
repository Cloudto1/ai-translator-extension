/**
 * 管理面板：API 配置 / 语言切换 / 翻译历史 / Token 统计。
 */

import { LANGUAGES, DEFAULT_SETTINGS, validateSettings } from '../lib/config.js';
import {
  getSettings,
  saveSettings,
  resetSettings,
  loadHistory,
  deleteHistoryEntry,
  clearHistory,
  trimHistory,
  onHistoryChanged,
  ensureStats,
  clearStats,
  onStatsChanged,
} from '../lib/storage.js';
import {
  statsView,
  createStats,
  formatNumber,
  compactNumber,
  formatDuration,
  formatRelativeTime,
  formatTime,
  kindLabel,
} from '../lib/history.js';
import { MSG } from '../lib/protocol.js';

const $ = (id) => document.getElementById(id);

const els = {
  nav: document.querySelector('.nav'),
  views: [...document.querySelectorAll('.view')],
  historyBadge: $('historyBadge'),
  connStatus: $('connStatus'),
  // 概览
  statsRange: $('statsRange'),
  statGrid: $('statGrid'),
  tokenChart: $('tokenChart'),
  chartHint: $('chartHint'),
  kindDist: $('kindDist'),
  modelDist: $('modelDist'),
  clearStatsBtn: $('clearStats'),
  // 历史
  historyList: $('historyList'),
  historySummary: $('historySummary'),
  historySearch: $('historySearch'),
  historyKind: $('historyKind'),
  clearHistoryBtn: $('clearHistory'),
  // 语言
  sourceLang: $('sourceLang'),
  targetLang: $('targetLang'),
  swapLang: $('swapLang'),
  langHint: $('langHint'),
  quickPairs: $('quickPairs'),
  pageMode: $('pageMode'),
  summaryLength: $('summaryLength'),
  historyLimit: $('historyLimit'),
  autoTranslateSelection: $('autoTranslateSelection'),
  autoTranslateDynamic: $('autoTranslateDynamic'),
  disableThinking: $('disableThinking'),
  // API
  apiKey: $('apiKey'),
  baseUrl: $('baseUrl'),
  model: $('model'),
  toggleKey: $('toggleKey'),
  testBtn: $('testBtn'),
  resetBtn: $('resetBtn'),
  testResult: $('testResult'),
  toast: $('toast'),
  appVersion: $('appVersion'),
};

let settings = { ...DEFAULT_SETTINGS };
let entries = [];
// 用量账本与翻译记录是两份独立的数据，清空记录不会动到它
let statsData = createStats();
let activeView = 'dashboard';
let saveTimer = null;

const LANG_LABELS = new Map(LANGUAGES.map((item) => [item.value, item.label]));

function langLabel(code) {
  if (!code || code === 'auto') return '自动';
  return LANG_LABELS.get(code) || code;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(message, type = 'info') {
  els.toast.textContent = message;
  els.toast.className = `toast${type === 'error' ? ' is-err' : ''}`;
  els.toast.hidden = false;
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 2600);
}

/* ------------------------------------------------------------------ */
/* 视图切换                                                            */
/* ------------------------------------------------------------------ */

function switchView(name) {
  activeView = name;
  for (const view of els.views) view.classList.toggle('is-active', view.dataset.view === name);
  for (const item of els.nav.querySelectorAll('.nav-item')) {
    const active = item.dataset.view === name;
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  if (location.hash.slice(1) !== name) window.history.replaceState(null, '', `#${name}`);
  if (name === 'dashboard') renderDashboard();
  if (name === 'history') renderHistory();
}

/* ------------------------------------------------------------------ */
/* 设置读写                                                            */
/* ------------------------------------------------------------------ */

function renderConnStatus() {
  const errors = validateSettings(settings);
  if (errors.length === 0) {
    els.connStatus.className = 'conn is-ok';
    els.connStatus.innerHTML = '<i class="dot"></i><span>已配置，可以使用</span>';
  } else {
    els.connStatus.className = 'conn is-err';
    els.connStatus.innerHTML = `<i class="dot"></i><span>${escapeHtml(errors[0])}</span>`;
  }
  return errors;
}

function fillForm() {
  els.sourceLang.value = settings.sourceLang;
  els.targetLang.value = settings.targetLang;
  els.pageMode.value = settings.pageMode;
  els.summaryLength.value = settings.summaryLength;
  els.historyLimit.value = String(settings.historyLimit);
  els.autoTranslateSelection.checked = settings.autoTranslateSelection;
  els.autoTranslateDynamic.checked = settings.autoTranslateDynamic;
  els.disableThinking.checked = settings.disableThinking;

  els.apiKey.value = settings.apiKey;
  els.baseUrl.value = settings.baseUrl;
  els.model.value = settings.model;

  renderLangHint();
}

function persist(patch, { immediate = true } = {}) {
  settings = { ...settings, ...patch };
  renderConnStatus();
  renderLangHint();

  const run = async () => {
    const next = await saveSettings(settings);
    settings = next;
    if (patch.historyLimit) await trimHistory(next.historyLimit);
    els.historyLimit.value = String(next.historyLimit);
    renderHistorySummary();
  };

  window.clearTimeout(saveTimer);
  if (immediate) return run();
  saveTimer = window.setTimeout(run, 350);
  return Promise.resolve();
}

function renderLangHint() {
  const { sourceLang, targetLang } = settings;
  if (sourceLang === 'auto' && targetLang === 'auto') {
    els.langHint.className = 'hint';
    els.langHint.textContent = '源语言「自动」由模型识别；目标语言「自动」为 中 ⇄ 英 互译：中文内容译成英文，其它语言译成中文。';
    return;
  }
  if (sourceLang === 'auto') {
    els.langHint.className = 'hint';
    els.langHint.textContent = `自动识别源语言，统一翻译为「${langLabel(targetLang)}」。`;
    return;
  }
  if (targetLang === 'auto') {
    els.langHint.className = 'hint';
    els.langHint.textContent = `源语言固定为「${langLabel(sourceLang)}」，目标语言自动进行中 ⇄ 英 互译。`;
    return;
  }
  if (sourceLang === targetLang) {
    els.langHint.className = 'hint is-warn';
    els.langHint.textContent = `源语言与目标语言相同（都是「${langLabel(sourceLang)}」），翻译时会自动反向处理，避免出现「同语言互译」。`;
    return;
  }
  els.langHint.className = 'hint';
  els.langHint.textContent = `固定语言对：「${langLabel(sourceLang)}」 → 「${langLabel(targetLang)}」。`;
}

/* ------------------------------------------------------------------ */
/* 概览与统计                                                          */
/* ------------------------------------------------------------------ */

function statCard(label, value, sub) {
  return `<div class="stat">
      <span class="stat-label">${escapeHtml(label)}</span>
      <span class="stat-value">${escapeHtml(value)}</span>
      <span class="stat-sub">${sub}</span>
    </div>`;
}

function renderDashboard() {
  const days = Number(els.statsRange.value) || 14;
  const stats = statsView(statsData, { days });
  const { total, today, week, daily } = stats;

  els.statGrid.innerHTML = [
    statCard('调用次数', formatNumber(total.count), `今日 <b>${formatNumber(today.count)}</b> 次 · 近 7 天 <b>${formatNumber(week.count)}</b> 次`),
    statCard('总 Token', compactNumber(total.tokens.total), `输入 ${compactNumber(total.tokens.prompt)} · 输出 ${compactNumber(total.tokens.completion)}`),
    statCard('翻译字符', compactNumber(total.inputChars), `产出译文 <b>${compactNumber(total.outputChars)}</b> 字符`),
    statCard('平均耗时', formatDuration(total.avgDurationMs), `今日平均 <b>${formatDuration(today.avgDurationMs)}</b>`),
  ].join('');

  // 趋势图
  const max = Math.max(1, ...daily.map((d) => d.tokens));
  els.chartHint.textContent = max > 1 ? `峰值 ${formatNumber(max)} Token/天` : '暂无数据';
  els.tokenChart.innerHTML = daily
    .map((day) => {
      const height = day.tokens > 0 ? Math.max(6, Math.round((day.tokens / max) * 100)) : 2;
      const label = day.date.slice(5);
      return `<div class="chart-col${day.tokens === 0 ? ' is-empty' : ''}" title="${escapeHtml(`${day.date}：${formatNumber(day.tokens)} Token，${day.count} 次`)}">
          <div class="chart-bar-wrap"><div class="chart-bar" style="height:${height}%"></div></div>
          <span class="chart-label">${escapeHtml(label)}</span>
        </div>`;
    })
    .join('');

  // 按功能
  const kinds = ['page', 'selection', 'summary'];
  const kindMap = new Map(stats.byKind.map((item) => [item.kind, item]));
  els.kindDist.innerHTML = kinds
    .map((kind) => {
      const item = kindMap.get(kind) || { count: 0, tokens: { total: 0 } };
      const pct = total.tokens.total ? Math.round((item.tokens.total / total.tokens.total) * 100) : 0;
      return `<div class="dist-row">
          <div class="dist-top">
            <b>${escapeHtml(kindLabel(kind))}</b>
            <span>${formatNumber(item.count)} 次 · ${formatNumber(item.tokens.total)} Token · ${pct}%</span>
          </div>
          <div class="dist-bar"><i style="width:${pct}%"></i></div>
        </div>`;
    })
    .join('');

  // 按模型
  els.modelDist.innerHTML = stats.byModel.length
    ? stats.byModel
        .map((item) => {
          const pct = total.tokens.total ? Math.round((item.tokens.total / total.tokens.total) * 100) : 0;
          return `<div class="dist-row">
              <div class="dist-top">
                <b>${escapeHtml(item.model)}</b>
                <span>${formatNumber(item.count)} 次 · ${formatNumber(item.tokens.total)} Token</span>
              </div>
              <div class="dist-bar"><i style="width:${pct}%"></i></div>
            </div>`;
        })
        .join('')
    : '<p class="muted">暂无数据</p>';
}

/* ------------------------------------------------------------------ */
/* 翻译记录                                                            */
/* ------------------------------------------------------------------ */

function renderHistorySummary() {
  els.historySummary.textContent = entries.length
    ? `共 ${formatNumber(entries.length)} 条记录，最多保留 ${formatNumber(settings.historyLimit)} 条`
    : `还没有记录，最多保留 ${formatNumber(settings.historyLimit)} 条`;
  els.historyBadge.textContent = entries.length > 999 ? '999+' : String(entries.length);
  els.historyBadge.dataset.empty = entries.length ? '0' : '1';
}

function filterHistory() {
  const kind = els.historyKind.value;
  const keyword = els.historySearch.value.trim().toLowerCase();
  return entries.filter((entry) => {
    if (kind !== 'all' && entry.kind !== kind) return false;
    if (!keyword) return true;
    return `${entry.sourcePreview} ${entry.resultPreview} ${entry.title} ${entry.url}`.toLowerCase().includes(keyword);
  });
}

function renderHistory() {
  const list = filterHistory();
  renderHistorySummary();

  if (list.length === 0) {
    els.historyList.innerHTML = `<div class="empty">${
      entries.length ? '没有符合条件的记录' : '暂无翻译记录，去网页上翻译一段试试吧'
    }</div>`;
    return;
  }

  els.historyList.innerHTML = list
    .map((entry) => {
      const langPair = `${langLabel(entry.sourceLang)} → ${langLabel(entry.targetLang)}`;
      return `<article class="history-item" data-id="${escapeHtml(entry.id)}">
        <div class="history-top">
          <span class="tag kind-${escapeHtml(entry.kind)}">${escapeHtml(kindLabel(entry.kind))}</span>
          <span class="muted">${escapeHtml(langPair)}</span>
          <span class="history-meta">
            <span title="${escapeHtml(formatTime(entry.ts))}">${escapeHtml(formatRelativeTime(entry.ts))}</span>
            <span>${formatNumber(entry.tokens.total)} Token</span>
            <span>${formatDuration(entry.durationMs)}</span>
            ${entry.itemCount > 1 ? `<span>${formatNumber(entry.itemCount)} 段</span>` : ''}
            <span>${escapeHtml(entry.model)}</span>
          </span>
        </div>
        <div class="history-text">
          <div class="history-side in">
            <span>原文</span>
            <p>${escapeHtml(entry.sourcePreview) || '<i>（无）</i>'}</p>
          </div>
          <div class="history-side out">
            <span>结果</span>
            <p>${escapeHtml(entry.resultPreview) || '<i>（无）</i>'}</p>
          </div>
        </div>
        <div class="history-actions">
          <button class="link" data-action="copy" data-id="${escapeHtml(entry.id)}" type="button">复制结果</button>
          ${
            entry.url
              ? `<a class="link" href="${escapeHtml(entry.url)}" target="_blank" rel="noreferrer" title="${escapeHtml(entry.title || entry.url)}">打开来源页面</a>`
              : ''
          }
          <button class="link danger" data-action="delete" data-id="${escapeHtml(entry.id)}" type="button">删除</button>
        </div>
      </article>`;
    })
    .join('');
}

async function handleHistoryAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  const entry = entries.find((item) => item.id === id);

  if (button.dataset.action === 'copy' && entry) {
    try {
      await navigator.clipboard.writeText(entry.resultPreview || '');
      toast('已复制结果');
    } catch {
      toast('复制失败，请手动选择文本', 'error');
    }
    return;
  }

  if (button.dataset.action === 'delete' && id) {
    // 只删记录：账本记的是真实发生过的模型调用，删一条留存内容不该改写用量
    entries = await deleteHistoryEntry(id);
    renderHistory();
    toast('已删除该条记录');
  }
}

/* ------------------------------------------------------------------ */
/* API 设置                                                            */
/* ------------------------------------------------------------------ */

async function testConnection() {
  els.testBtn.disabled = true;
  els.testResult.className = 'result';
  els.testResult.textContent = '正在测试连接…';
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
      els.testResult.className = 'result is-ok';
      els.testResult.textContent = `连接成功 · ${res.result.latencyMs} ms · 模型「${res.result.model}」返回：${res.result.reply || 'OK'}`;
    } else {
      els.testResult.className = 'result is-err';
      els.testResult.textContent = res?.message || '连接失败';
    }
  } catch (err) {
    els.testResult.className = 'result is-err';
    els.testResult.textContent = err?.message || '连接失败';
  } finally {
    els.testBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

/** 源语言与目标语言对「自动」的表述不同，分别生成选项。 */
function buildLangOptions(autoLabel) {
  return LANGUAGES.map(
    (lang) => `<option value="${lang.value}">${lang.value === 'auto' ? autoLabel : lang.label}</option>`,
  ).join('');
}

function initSelects() {
  els.sourceLang.innerHTML = buildLangOptions('自动识别（由模型判断）');
  els.targetLang.innerHTML = buildLangOptions('自动（中 ⇄ 英 互译）');
}

function bindEvents() {
  els.nav.addEventListener('click', (event) => {
    const item = event.target.closest('.nav-item');
    if (item) switchView(item.dataset.view);
  });

  els.statsRange.addEventListener('change', renderDashboard);
  els.historySearch.addEventListener('input', renderHistory);
  els.historyKind.addEventListener('change', renderHistory);

  els.historyList.addEventListener('click', handleHistoryAction);

  els.clearHistoryBtn.addEventListener('click', async () => {
    if (!window.confirm('确定要清空全部翻译记录吗？此操作不可撤销。\n\n「概览与统计」是独立的用量账本，不受影响。')) return;
    entries = await clearHistory();
    renderHistory();
    toast('已清空翻译记录，统计已保留');
  });

  els.clearStatsBtn.addEventListener('click', async () => {
    if (!window.confirm('确定清空用量统计吗？\n\nToken 消耗、调用次数与趋势图都会归零，翻译记录不受影响。此操作不可撤销。')) return;
    statsData = await clearStats();
    renderDashboard();
    toast('已清空用量统计，翻译记录已保留');
  });

  els.sourceLang.addEventListener('change', () => persist({ sourceLang: els.sourceLang.value }));
  els.targetLang.addEventListener('change', () => persist({ targetLang: els.targetLang.value }));
  els.swapLang.addEventListener('click', () => {
    const source = els.sourceLang.value === 'auto' ? 'en' : els.sourceLang.value;
    const target = els.targetLang.value === 'auto' ? 'zh' : els.targetLang.value;
    els.sourceLang.value = target;
    els.targetLang.value = source;
    persist({ sourceLang: target, targetLang: source });
    toast(`已交换：${langLabel(target)} → ${langLabel(source)}`);
  });
  els.quickPairs.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    const [source, target] = chip.dataset.pair.split('|');
    els.sourceLang.value = source;
    els.targetLang.value = target;
    persist({ sourceLang: source, targetLang: target });
    toast(`已切换为：${langLabel(source)} → ${langLabel(target)}`);
  });

  els.pageMode.addEventListener('change', () => persist({ pageMode: els.pageMode.value }));
  els.summaryLength.addEventListener('change', () => persist({ summaryLength: els.summaryLength.value }));
  els.historyLimit.addEventListener('change', () => persist({ historyLimit: Number(els.historyLimit.value) }));
  els.autoTranslateSelection.addEventListener('change', () =>
    persist({ autoTranslateSelection: els.autoTranslateSelection.checked }),
  );
  els.autoTranslateDynamic.addEventListener('change', () =>
    persist({ autoTranslateDynamic: els.autoTranslateDynamic.checked }),
  );
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
    if (!window.confirm('确定要恢复默认设置吗？API Key 也会被清空。')) return;
    settings = await resetSettings();
    fillForm();
    renderConnStatus();
    els.testResult.textContent = '';
    toast('已恢复默认设置');
  });

  onHistoryChanged((next) => {
    entries = next;
    if (activeView === 'history') renderHistory();
    renderHistorySummary();
  });

  onStatsChanged((next) => {
    statsData = next;
    if (activeView === 'dashboard') renderDashboard();
  });
}

async function init() {
  initSelects();
  settings = await getSettings();
  entries = await loadHistory();
  // 老版本只有记录、没有账本：这里回填一次，升级后统计不会从 0 开始
  statsData = await ensureStats(entries);
  fillForm();
  bindEvents();
  renderConnStatus();
  // 版本号只认 manifest.json，避免面板里的硬编码数字和发布版本对不上
  els.appVersion.textContent = chrome.runtime.getManifest().version;

  const initial = location.hash.slice(1);
  switchView(['dashboard', 'history', 'language', 'api'].includes(initial) ? initial : 'dashboard');
}

init();
