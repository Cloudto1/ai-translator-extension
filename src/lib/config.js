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
  pageTranslateLimit: 3000, // 单次「翻译整页」最多翻译多少处文本，达到后提示再点一次继续
  pageTranslateUnlimited: false, // 打开后忽略上面的上限，一轮接一轮翻到页面末尾
  pageMode: 'replace', // replace（替换原文） | bilingual（双语对照）
  summaryLength: 'medium', // short | medium | detailed
  historyLimit: 300, // 本地翻译历史最多保留条数
  // 页面内快捷键。浏览器不允许扩展改写系统快捷键，所以由内容脚本自己监听。
  // 空字符串表示关闭这一项。
  shortcutPage: 'Alt+Y',
  shortcutSummarize: 'Alt+Shift+S',
  shortcutSelection: 'Alt+Shift+E',
});

const SHORTCUT_FIELDS = ['shortcutPage', 'shortcutSummarize', 'shortcutSelection'];

/**
 * 把快捷键收成稳定写法：Ctrl、Alt、Shift、Command 在前，主键在最后。
 * 必须带 Ctrl、Alt 或 Command，避免单键抢走正常输入。
 * 空字符串表示关闭；格式不对返回 null。
 */
export function canonicalShortcut(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const mods = new Set();
  let key = '';
  for (const part of text.split('+')) {
    const token = part.trim();
    if (!token) continue;
    const lower = token.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') mods.add('Ctrl');
    else if (lower === 'alt' || lower === 'option') mods.add('Alt');
    else if (lower === 'shift') mods.add('Shift');
    else if (lower === 'command' || lower === 'meta' || lower === 'cmd') mods.add('Command');
    else if (!key) key = token.length === 1 ? token.toUpperCase() : token;
    else return null;
  }
  if (!key || ['Control', 'Ctrl', 'Alt', 'Shift', 'Meta', 'Command'].includes(key)) return null;
  if (!mods.has('Ctrl') && !mods.has('Alt') && !mods.has('Command')) return null;
  const ordered = [];
  for (const name of ['Ctrl', 'Alt', 'Shift', 'Command']) {
    if (mods.has(name)) ordered.push(name);
  }
  ordered.push(key === ' ' ? 'Space' : key);
  return ordered.join('+');
}

/** 与 canonicalShortcut 使用同一套按键名，供页面监听时比对。 */
export function shortcutFromEvent(event) {
  const raw = event?.key;
  if (!raw || raw === 'Dead' || raw === 'Unidentified' || raw === 'Process') return '';
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(raw)) return '';
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return '';
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Command');
  parts.push(raw === ' ' ? 'Space' : raw.length === 1 ? raw.toUpperCase() : raw);
  return parts.join('+');
}

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
  // 只认已知字段：消息和存储里的数据不可信，未知键一律丢弃，
  // 否则任何人塞进来的键都会被原样写进 storage.sync（有配额，也会跟着账号同步）
  const s = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (raw[key] !== undefined) s[key] = raw[key];
    }
  }
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
  const pageLimit = Number(s.pageTranslateLimit);
  s.pageTranslateLimit =
    Number.isFinite(pageLimit) && pageLimit > 0
      ? Math.min(Math.round(pageLimit), 50000)
      : DEFAULT_SETTINGS.pageTranslateLimit;
  s.pageTranslateUnlimited = isTruthy(s.pageTranslateUnlimited);
  const usedShortcuts = new Set();
  for (const field of SHORTCUT_FIELDS) {
    const chord = canonicalShortcut(s[field]);
    let next = chord === null ? DEFAULT_SETTINGS[field] : chord;
    if (next && usedShortcuts.has(next)) next = '';
    s[field] = next;
    if (next) usedShortcuts.add(next);
  }
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

/**
 * 主机名是否属于「本机 / 局域网」：这类地址走明文 http 不会经过公网，允许使用。
 * 覆盖 localhost、回环、RFC1918 私网、链路本地与 .local 域名。
 */
export function isPrivateHost(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1') return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some((p) => Number(p) > 255)) return false;
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * 校验 Base URL，返回错误信息（合法时返回空串）。
 * 除了协议必须是 http(s) 之外，还拒绝「公网地址 + 明文 http」：
 * API Key 会放在 Authorization 头里，明文传输等于把密钥广播给沿途所有网络设备。
 */
export function checkBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!/^https?:\/\//i.test(raw)) return 'Base URL 需要以 http:// 或 https:// 开头';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'Base URL 格式不正确';
  }
  if (!url.hostname) return 'Base URL 格式不正确';
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    return 'Base URL 使用明文 http:// 会泄露 API Key，请改用 https://（仅本机或局域网地址允许 http）';
  }
  return '';
}

/** 校验设置完整度，返回错误信息数组。 */
export function validateSettings(raw) {
  const s = normalizeSettings(raw);
  const errors = [];
  if (!s.apiKey) errors.push('请填写 API Key');
  if (!s.model) errors.push('请填写模型名称');
  const urlError = checkBaseUrl(s.baseUrl);
  if (urlError) errors.push(urlError);
  return errors;
}
