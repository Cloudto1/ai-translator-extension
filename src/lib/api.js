/**
 * OpenAI 协议兼容的 Chat Completions 客户端（fetch 实现，无第三方依赖）。
 * 同时可用于浏览器（Service Worker / 页面）与 Node 环境（测试）。
 */

import { normalizeBaseUrl, checkBaseUrl } from './config.js';

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

/**
 * 把多个 AbortSignal 合并成一个。
 * 返回 dispose：请求结束后必须调用，否则监听器会一直挂在长寿命的外部 signal 上。
 */
function linkSignals(signals) {
  const controller = new AbortController();
  const cleanups = [];
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort();
      break;
    }
    const onAbort = () => controller.abort();
    s.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => s.removeEventListener('abort', onAbort));
  }
  return { signal: controller.signal, dispose: () => cleanups.forEach((fn) => fn()) };
}

function buildBody({ model, messages, temperature, maxTokens, tokenParam, stream, disableThinking, includeUsage }) {
  const body = {
    model,
    messages,
    stream: !!stream,
  };
  if (typeof maxTokens === 'number') body[tokenParam] = maxTokens;
  if (typeof temperature === 'number') body.temperature = temperature;
  if (disableThinking) body.thinking = { type: 'disabled' };
  // 流式响应默认不带用量，显式要求服务端在最后一个分片里返回
  if (stream && includeUsage) body.stream_options = { include_usage: true };
  return body;
}

/**
 * 是否属于「不认识的参数」类错误（用于自动降级重试）。
 * 只有请求体里真的带了该参数才算数：否则一个无关的 400 里碰巧出现 "thinking"
 * 字样，就会被误判成参数问题，白白重发一次相同的请求。
 */
export function isUnsupportedParamError(status, text, body = {}) {
  if (status !== 400 && status !== 422) return null;
  const lower = String(text || '').toLowerCase();
  if (body.thinking !== undefined && lower.includes('thinking')) return 'thinking';
  if (body.stream_options !== undefined && lower.includes('stream_options')) return 'stream_options';
  if (body.temperature !== undefined && lower.includes('temperature')) return 'temperature';
  if (body.max_tokens !== undefined) {
    // o 系列等模型只认 max_completion_tokens：换名字，而不是删掉上限
    if (lower.includes('max_completion_tokens')) return 'max_completion_tokens';
    if (lower.includes('max_tokens') || lower.includes('max tokens')) return 'max_tokens';
  }
  return null;
}

/** 可重试的瞬时错误：限流与网关类 5xx。 */
const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);
const MAX_TRANSIENT_RETRIES = 2;
const MAX_PARAM_DOWNGRADES = 4;

/** 退避时长：优先听服务端的 Retry-After（秒），上限 8 秒；否则 0.8s、1.6s 指数退避。 */
export function retryDelayMs(retryAfterHeader, attempt) {
  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 8000);
  return 800 * 2 ** attempt;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError('已取消。', 'ABORTED'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ApiError('已取消。', 'ABORTED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
  // 库层也要把关：不依赖调用方是否先跑过 validateSettings，避免把 Key 发往明文公网地址
  const urlError = checkBaseUrl(baseUrl || 'https://api.deepseek.com');
  if (urlError) throw new ApiError(urlError, 'BAD_BASE_URL');

  const endpoint = normalizeBaseUrl(baseUrl);
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const linked = linkSignals([signal, timeoutController.signal]);
  const mergedSignal = linked.signal;

  /** 把读取响应过程中抛出的任意错误归类成 ApiError。 */
  const timedOut = () => !signal?.aborted && timeoutController.signal.aborted;
  const classify = (err) => {
    if (signal?.aborted) return new ApiError('已取消。', 'ABORTED');
    if (timedOut()) return new ApiError('请求超时，请检查网络或 Base URL 是否可达。', 'TIMEOUT');
    if (err instanceof ApiError) return err;
    return new ApiError(`网络请求失败：${err?.message || err}`, 'NETWORK_ERROR');
  };

  // 随降级过程逐步收窄的请求参数
  const state = {
    model,
    messages,
    temperature,
    maxTokens,
    tokenParam: 'max_tokens',
    disableThinking,
    includeUsage,
  };
  let downgrades = 0;
  let transientRetries = 0;

  try {
    for (;;) {
      const body = buildBody({ ...state, stream });

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
        throw classify(err);
      }

      if (!res.ok) {
        let text = '';
        try {
          text = await res.text();
        } catch (err) {
          // 读错误响应体失败不影响错误上报，除非是被取消 / 超时打断
          if (signal?.aborted || timedOut()) throw classify(err);
        }

        const unsupported = isUnsupportedParamError(res.status, text, body);
        if (unsupported && downgrades < MAX_PARAM_DOWNGRADES) {
          // 部分第三方网关不支持这些参数，去掉（或换名）后重试
          downgrades += 1;
          if (unsupported === 'thinking') state.disableThinking = false;
          else if (unsupported === 'stream_options') state.includeUsage = false;
          else if (unsupported === 'temperature') state.temperature = undefined;
          else if (unsupported === 'max_completion_tokens') state.tokenParam = 'max_completion_tokens';
          else if (unsupported === 'max_tokens') state.maxTokens = undefined;
          continue;
        }

        if (TRANSIENT_STATUS.has(res.status) && transientRetries < MAX_TRANSIENT_RETRIES) {
          const wait = retryDelayMs(res.headers.get('retry-after'), transientRetries);
          transientRetries += 1;
          await sleep(wait, mergedSignal).catch((err) => {
            throw classify(err);
          });
          continue;
        }

        throw new ApiError(describeHttpError(res.status, text), `HTTP_${res.status}`, text);
      }

      try {
        const contentType = res.headers.get('content-type') || '';

        // 网关忽略了 stream，直接返回了 JSON
        if (stream && contentType.includes('application/json')) {
          const data = await readJson(res);
          const message = data?.choices?.[0]?.message || {};
          const content = message.content || '';
          if (content && onDelta) onDelta(content, content);
          return finalize(content, message.reasoning_content || '', data);
        }

        if (!stream) {
          const data = await readJson(res);
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
      } catch (err) {
        throw classify(err);
      }
    }
  } finally {
    clearTimeout(timeout);
    linked.dispose();
  }
}

/**
 * 读取并解析 JSON 响应体。
 * 有些网关（或填错的 Base URL）会在 HTTP 200 下返回 HTML 页面，
 * 直接 res.json() 会冒出一句看不懂的 "Unexpected token <"，这里换成可操作的提示。
 */
async function readJson(res) {
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(
      '接口返回的不是有效的 JSON，请检查 Base URL 是否指向 OpenAI 兼容接口。',
      'BAD_RESPONSE',
      String(text).slice(0, 200),
    );
  }
  // 部分网关会用 HTTP 200 包一个 error 对象
  if (data?.error && !data.choices) {
    const detail = typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error);
    throw new ApiError(`接口返回错误：${String(detail).slice(0, 400)}`, 'API_ERROR', text);
  }
  return data;
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
  let model = '';

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith(':') || !line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    // 流中途出错：有些网关会在数据流里塞一个 error 对象，而不是改 HTTP 状态码
    if (json.error && !json.choices) {
      throw new ApiError(json.error.message || '流式响应中断', 'STREAM_ERROR');
    }
    if (json.usage) usage = json.usage;
    if (json.model) model = json.model;
    const choice = json.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (!delta) return;
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    if (delta.content) {
      content += delta.content;
      if (onDelta) onDelta(delta.content, content);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
      if (signal?.aborted) break;
    }
    // 收尾：最后一行没有换行结尾时也要处理（用量往往就在最后一个分片里）
    buffer += decoder.decode();
    if (buffer && !signal?.aborted) handleLine(buffer);
  } finally {
    // 提前退出（取消 / 出错）时释放底层连接，别让它悬着继续收数据
    reader.cancel().catch(() => {});
  }

  if (signal?.aborted) throw new ApiError('已取消。', 'ABORTED');
  return { content, reasoning, finishReason, usage, model };
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
