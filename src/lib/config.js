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
  // 语言配置
  sourceLang: 'auto', // auto 表示由模型自动识别
  targetLang: 'auto', // auto 表示中 ⇄ 英 互译
  // 行为配置
  disableThinking: true, // 关闭推理模型的思考过程，显著提升翻译速度
  autoTranslateSelection: false, // 划词后自动翻译（无需点击按钮）
  autoTranslateDynamic: true, // 持续翻译：整页翻译激活期间，新加载 / 新展开的内容自动补译
  cacheEnabled: true, // 按站点缓存译文：同站跨页面复用，避免站内导航重复翻译与重复付费
  pageMode: 'replace', // replace（替换原文） | bilingual（双语对照）
  summaryLength: 'medium', // short | medium | detailed
  historyLimit: 300, // 本地翻译历史最多保留条数
});

export const RUNTIME_LIMITS = Object.freeze({
  // 分批上限受「模型输出 token」约束，而非输入长度。
  // estimateMaxTokens 按 chars × 2 申请输出额度：3000 字 → 6000 token，
  // 对 DeepSeek（输出上限 8192）等主流模型留有安全余量；再往上（4000 字 → 8000）
  // 会贴近上限，部分服务商会直接返回 400。
  // 批次过大导致 JSON 解析失败时会自动拆半重试（见 translateBatch），因此放宽是安全的。
  maxCharsPerBatch: 3000,
  maxItemsPerBatch: 40,
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
  if (!LANGUAGE_NAMES[s.sourceLang]) s.sourceLang = DEFAULT_SETTINGS.sourceLang;
  if (s.pageMode !== 'bilingual') s.pageMode = 'replace';
  if (!['short', 'medium', 'detailed'].includes(s.summaryLength)) s.summaryLength = 'medium';
  const limit = Number(s.historyLimit);
  s.historyLimit = Number.isFinite(limit) && limit >= 20 ? Math.min(Math.round(limit), 2000) : DEFAULT_SETTINGS.historyLimit;
  s.disableThinking = !isFalsy(s.disableThinking);
  s.autoTranslateSelection = isTruthy(s.autoTranslateSelection);
  s.autoTranslateDynamic = !isFalsy(s.autoTranslateDynamic);
  s.cacheEnabled = !isFalsy(s.cacheEnabled);
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
