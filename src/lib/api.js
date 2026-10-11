/**
 * OpenAI 协议兼容的 Chat Completions 客户端（fetch 实现，无第三方依赖）。
 * 同时可用于浏览器（Service Worker / 页面）与 Node 环境（测试）。
 */

import { normalizeBaseUrl } from './config.js';

export class ApiError extends Error {
  constructor(message, code = 'API_ERROR', details = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

/** 从 HTTP 错误响应中提取人类可读的错误信息。 */
export function describeHttpError(status, bodyText) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || parsed?.message || '';
  } catch {
    detail = String(bodyText || '').slice(0, 400);
  }
  const hint =
    status === 401
      ? 'API Key 无效或已过期，请在插件设置中检查。'
      : status === 402
        ? '账户余额不足。'
        : status === 403
          ? '无访问权限，请确认该 Key 是否可用。'
          : status === 404
            ? '接口地址不存在，请检查 Base URL 是否正确。'
            : status === 429
              ? '请求过于频繁，请稍后重试。'
              : status >= 500
                ? '服务端错误，请稍后重试。'
                : '';
  return [`请求失败（HTTP ${status}）`, hint, detail].filter(Boolean).join(' ');
}

/** 把各家格式各异的 usage 归一化成 { prompt, completion, total }。 */
export function normalizeUsage(usage) {
  if (!usage) return { prompt: 0, completion: 0, total: 0 };
  const prompt = Number(usage.prompt_tokens ?? usage.prompt ?? usage.input_tokens ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? usage.completion ?? usage.output_tokens ?? 0) || 0;
  const total = Number(usage.total_tokens ?? usage.total ?? 0) || prompt + completion;
  return { prompt, completion, total: total || prompt + completion };
}

/** 累加两次调用的用量。 */
export function mergeUsage(a, b) {
  const x = normalizeUsage(a);
  const y = normalizeUsage(b);
  return {
    prompt: x.prompt + y.prompt,
    completion: x.completion + y.completion,
    total: x.total + y.total,
  };
}

function mergeSignals(signals) {
  const valid = signals.filter(Boolean);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of valid) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

function buildBody({ model, messages, temperature, maxTokens, stream, disableThinking, includeUsage }) {
  const body = {
    model,
    messages,
    stream: !!stream,
    max_tokens: maxTokens,
  };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (disableThinking) body.thinking = { type: 'disabled' };
  // 流式响应默认不带用量，显式要求服务端在最后一个分片里返回
  if (stream && includeUsage) body.stream_options = { include_usage: true };
  return body;
}

/** 是否属于「不认识的参数」类错误（用于自动降级重试）。 */
function isUnsupportedParamError(status, text) {
  if (status !== 400 && status !== 422) return null;
  const lower = String(text || '').toLowerCase();
  if (lower.includes('thinking')) return 'thinking';
  if (lower.includes('stream_options')) return 'stream_options';
  if (lower.includes('temperature')) return 'temperature';
  if (lower.includes('max_tokens') || lower.includes('max tokens')) return 'max_tokens';
  return null;
}

/**
 * 发起一次 Chat Completion 请求。
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.baseUrl
 * @param {string} opts.model
 * @param {Array}  opts.messages
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {boolean}[opts.stream]
 * @param {boolean}[opts.disableThinking]
 * @param {(delta:string, full:string)=>void} [opts.onDelta]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content:string, reasoning:string, finishReason:string|null, usage:object|null, model:string}>}
 */
export async function chatCompletion(opts) {
  const {
    apiKey,
    baseUrl,
    model,
    messages,
    temperature,
    maxTokens = 4096,
    stream = false,
    disableThinking = false,
    includeUsage = true,
    onDelta,
    signal,
    timeoutMs = 90000,
  } = opts || {};

  if (!apiKey) throw new ApiError('未配置 API Key，请先在插件设置中填写。', 'NO_API_KEY');
  if (!model) throw new ApiError('未配置模型名称。', 'NO_MODEL');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError('请求内容为空。', 'EMPTY_MESSAGES');
  }

  const endpoint = normalizeBaseUrl(baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const mergedSignal = mergeSignals([signal, controller.signal]);

  let retry = { ...opts, messages };
  let lastError = null;

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const body = buildBody({
        model: retry.model,
        messages: retry.messages,
        temperature: retry.temperature,
        maxTokens: retry.maxTokens ?? maxTokens,
        stream,
        disableThinking: retry.disableThinking,
        includeUsage: retry.includeUsage ?? includeUsage,
      });

      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: mergedSignal,
        });
      } catch (err) {
        if (signal?.aborted) throw new ApiError('已取消。', 'ABORTED');
        if (controller.signal.aborted) {
          throw new ApiError('请求超时，请检查网络或 Base URL 是否可达。', 'TIMEOUT');
        }
        throw new ApiError(`网络请求失败：${err?.message || err}`, 'NETWORK_ERROR');
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const unsupported = isUnsupportedParamError(res.status, text);
        if (unsupported && attempt < 2) {
          // 部分第三方网关不支持这些参数，去掉后重试
          if (unsupported === 'thinking') retry.disableThinking = false;
          else if (unsupported === 'stream_options') retry.includeUsage = false;
          else if (unsupported === 'temperature') retry.temperature = undefined;
          else if (unsupported === 'max_tokens') retry.maxTokens = undefined;
          lastError = new ApiError(describeHttpError(res.status, text), `HTTP_${res.status}`);
          continue;
        }
        throw new ApiError(describeHttpError(res.status, text), `HTTP_${res.status}`, text);
      }

      const contentType = res.headers.get('content-type') || '';
      // 网关忽略了 stream，直接返回了 JSON
      if (stream && contentType.includes('application/json')) {
        const data = await res.json();
        const message = data?.choices?.[0]?.message || {};
        const content = message.content || '';
        if (content && onDelta) onDelta(content, content);
        return finalize(content, message.reasoning_content || '', data);
      }

      if (!stream) {
        const data = await res.json();
        const choice = data?.choices?.[0];
        const message = choice?.message || {};
        return finalize(
          message.content || '',
          message.reasoning_content || '',
          data,
          choice?.finish_reason ?? null,
        );
      }

      return await readStream(res, onDelta, signal);
    }
  } finally {
    clearTimeout(timeout);
  }

  throw lastError || new ApiError('请求失败。', 'API_ERROR');
}

function finalize(content, reasoning, data, finishReason) {
  return {
    content: String(content || ''),
    reasoning,
    finishReason: finishReason ?? data?.choices?.[0]?.finish_reason ?? null,
    usage: data?.usage || null,
    model: data?.model || '',
  };
}

async function readStream(res, onDelta, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let finishReason = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (!delta) continue;
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      if (delta.content) {
        content += delta.content;
        if (onDelta) onDelta(delta.content, content);
      }
    }
    if (signal?.aborted) break;
  }

  if (signal?.aborted) throw new ApiError('已取消。', 'ABORTED');
  return { content, reasoning, finishReason, usage, model: '' };
}

/** 调用 /models 接口做连通性测试。 */
export async function testConnection(settings, { signal, timeoutMs = 20000 } = {}) {
  const started = Date.now();
  const result = await chatCompletion({
    ...settings,
    messages: [
      { role: 'system', content: 'You are a health check endpoint. Reply with exactly: OK' },
      { role: 'user', content: 'ping' },
    ],
    maxTokens: 2048,
    temperature: 0,
    stream: false,
    signal,
    timeoutMs,
  });
  const content = (result.content || result.reasoning || '').trim();
  return {
    ok: true,
    latencyMs: Date.now() - started,
    model: result.model || settings.model,
    reply: content.slice(0, 60),
  };
}
