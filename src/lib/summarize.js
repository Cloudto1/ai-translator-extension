/**
 * 网页总结：正文提取 + 调用模型生成结构化摘要。
 */

import { chatCompletion, ApiError } from './api.js';
import { buildSummaryMessages, detectLanguage, resolveTargetLang } from './prompts.js';
import { RUNTIME_LIMITS } from './config.js';

/**
 * 从原始页面文本中清理噪声（导航、重复行、空白），保留有效正文。
 * @param {string} rawText
 * @param {number} maxChars
 */
export function condensePageText(rawText, maxChars = RUNTIME_LIMITS.summaryMaxChars) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 1);

  const seen = new Set();
  const kept = [];
  let total = 0;
  for (const line of lines) {
    // 过滤明显的导航/页脚噪声
    if (/^(首页|登录|注册|更多|分享|评论|广告|Sign in|Log in|Sign up|Menu|Home|Share|Comments?|Advertisement)$/i.test(line)) {
      continue;
    }
    const key = line.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    if (total + line.length > maxChars) break;
    kept.push(line);
    total += line.length + 1;
  }
  return kept.join('\n');
}

/**
 * 生成网页总结。
 * @param {object} settings
 * @param {{title:string,url:string,text:string,targetLang?:string,length?:string,onDelta?:Function,signal?:AbortSignal}} input
 */
export async function summarizePage(settings, input) {
  const { title = '', url = '', text = '', onDelta, signal } = input;
  const body = condensePageText(text, RUNTIME_LIMITS.summaryMaxChars);
  if (body.length < 40) {
    throw new ApiError('页面正文太少，无法生成有意义的总结。', 'CONTENT_TOO_SHORT');
  }

  const requested = input.targetLang ?? settings.targetLang;
  // 总结的 auto 行为：中文页面用中文总结，其它语言页面也输出中文，方便中文用户阅读
  const targetLang = requested === 'auto' ? 'zh' : resolveTargetLang(requested, body);

  const messages = buildSummaryMessages({
    title,
    url,
    text: body,
    targetLang,
    length: input.length || settings.summaryLength,
  });

  const result = await chatCompletion({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    messages,
    temperature: 0.4,
    maxTokens: Math.min(8192, Math.max(2048, Math.ceil(body.length / 20) + 1200)),
    stream: typeof onDelta === 'function',
    onDelta,
    disableThinking: settings.disableThinking !== false,
    signal,
    timeoutMs: 120000,
  });

  const content = String(result.content || '').trim();
  if (!content) {
    throw new ApiError('模型没有返回总结内容，请重试。', 'EMPTY_RESULT');
  }
  return { summary: content, targetLang, detectedLang: detectLanguage(body), usage: result.usage };
}
