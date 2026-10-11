/**
 * 全局配置与常量。
 * 注意：本文件不依赖任何 chrome.* API，可在 Node 测试环境中直接导入。
 */

export const STORAGE_KEY = 'ait_settings';

export const DEFAULT_SETTINGS = Object.freeze({
  // AI 连接配置
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  // 行为配置
  targetLang: 'auto', // auto | zh | zh-TW | en | ja | ko | fr | de | es | ru
  disableThinking: true, // 关闭推理模型的思考过程，显著提升翻译速度
  autoTranslateSelection: false, // 划词后自动翻译（无需点击按钮）
  pageMode: 'replace', // replace（替换原文） | bilingual（双语对照）
  summaryLength: 'medium', // short | medium | detailed
});

export const RUNTIME_LIMITS = Object.freeze({
  maxCharsPerBatch: 1400,
  maxItemsPerBatch: 20,
  concurrency: 3,
  summaryMaxChars: 24000,
  selectionMaxChars: 6000,
  requestTimeoutMs: 90000,
});

export const LANGUAGES = Object.freeze([
  { value: 'auto', label: '自动（中 ⇄ 英）' },
  { value: 'zh', label: '中文（简体）' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'ru', label: 'Русский' },
]);

export const LANGUAGE_NAMES = Object.freeze({
  zh: 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
});

function isFalsy(value) {
  return value === false || value === 0 || value === '0' || value === 'false' || value === 'off' || value == null;
}

function isTruthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

/** 合并用户设置与默认值，并把类型纠正到安全范围。 */
export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.apiKey = String(s.apiKey || '').trim();
  s.baseUrl = String(s.baseUrl || '').trim() || DEFAULT_SETTINGS.baseUrl;
  s.model = String(s.model || '').trim() || DEFAULT_SETTINGS.model;
  if (!LANGUAGE_NAMES[s.targetLang]) s.targetLang = DEFAULT_SETTINGS.targetLang;
  if (s.pageMode !== 'bilingual') s.pageMode = 'replace';
  if (!['short', 'medium', 'detailed'].includes(s.summaryLength)) s.summaryLength = 'medium';
  s.disableThinking = !isFalsy(s.disableThinking);
  s.autoTranslateSelection = isTruthy(s.autoTranslateSelection);
  return s;
}

/** 把用户填写的 Base URL 规范化为 chat/completions 端点。 */
export function normalizeBaseUrl(baseUrl) {
  let url = String(baseUrl || '').trim();
  if (!url) url = DEFAULT_SETTINGS.baseUrl;
  url = url.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v\d+$/i.test(url)) return `${url}/chat/completions`;
  return `${url}/v1/chat/completions`;
}

/** 展示用的 Key 掩码。 */
export function maskKey(key) {
  const k = String(key || '');
  if (!k) return '(未设置)';
  if (k.length <= 10) return `${k.slice(0, 3)}****`;
  return `${k.slice(0, 6)}****${k.slice(-4)}`;
}

/** 校验设置完整度，返回错误信息数组。 */
export function validateSettings(raw) {
  const s = normalizeSettings(raw);
  const errors = [];
  if (!s.apiKey) errors.push('请填写 API Key');
  if (!s.model) errors.push('请填写模型名称');
  if (!/^https?:\/\//i.test(s.baseUrl)) errors.push('Base URL 需要以 http:// 或 https:// 开头');
  return errors;
}
