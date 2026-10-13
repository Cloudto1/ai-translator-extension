/**
 * 离线回归测试：安全加固、API 客户端容错、批量翻译的失败处理、缓存体积上限。
 * 全部用桩 fetch，不发起任何真实网络请求。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';

import {
  chatCompletion,
  isUnsupportedParamError,
  retryDelayMs,
  ApiError,
} from '../src/lib/api.js';
import {
  checkBaseUrl,
  isPrivateHost,
  normalizeSettings,
  validateSettings,
  DEFAULT_SETTINGS,
} from '../src/lib/config.js';
import { translateTexts } from '../src/lib/translate.js';
import { pruneCache, putTranslations, cacheSizeBytes, DEFAULT_CACHE_MAX_BYTES } from '../src/lib/cache.js';
import {
  isExtensionSender,
  isPrivilegedMessage,
  isAllowedTabCommand,
  settingsForContent,
} from '../src/lib/access.js';
import { MSG } from '../src/lib/protocol.js';

/* ------------------------------------------------------------------ */
/* 测试工具                                                            */
/* ------------------------------------------------------------------ */

const BASE = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com',
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
};

const okBody = (content = 'OK') => ({
  model: 'm',
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

const jsonRes = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** 替换全局 fetch；handler(次序, 请求体, init) 返回 Response 或 Promise<Response>。 */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    return handler(calls.length, body, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** 构造一个 SSE 响应：先吐出 chunks，然后保持打开（hang=true）或直接结束；signal 中止时让流报错，和真实 fetch 一致。 */
function sseResponse(chunks, { hang = false, signal } = {}) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (!hang) controller.close();
      signal?.addEventListener(
        'abort',
        () => controller.error(new DOMException('The operation was aborted.', 'AbortError')),
        { once: true },
      );
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/* ------------------------------------------------------------------ */
/* Base URL：明文 http 会泄露 API Key                                  */
/* ------------------------------------------------------------------ */

test('checkBaseUrl：公网明文 http 被拒绝，https 与本机 / 局域网 http 放行', () => {
  assert.equal(checkBaseUrl('https://api.openai.com/v1'), '');
  for (const ok of [
    'http://localhost:11434',
    'http://127.0.0.1:8080/v1',
    'http://192.168.1.5:8000',
    'http://10.0.0.8',
    'http://172.20.0.2',
    'http://[::1]:3000',
    'http://my-nas.local:9000',
  ]) {
    assert.equal(checkBaseUrl(ok), '', ok);
  }
  for (const bad of ['http://api.openai.com', 'http://1.2.3.4', 'http://172.32.0.1', 'http://example.com:8080/v1']) {
    assert.match(checkBaseUrl(bad), /https/, bad);
  }
  assert.match(checkBaseUrl('ftp://x'), /以 http:\/\/ 或 https:\/\/ 开头/);
  assert.match(checkBaseUrl('https://'), /格式不正确/);
  assert.match(checkBaseUrl('javascript:alert(1)'), /以 http/);
});

test('isPrivateHost 只认真正的私网地址', () => {
  assert.equal(isPrivateHost('172.16.0.1'), true);
  assert.equal(isPrivateHost('172.31.255.255'), true);
  assert.equal(isPrivateHost('172.15.0.1'), false);
  assert.equal(isPrivateHost('192.169.1.1'), false);
  assert.equal(isPrivateHost('localhost.evil.com'), false);
  assert.equal(isPrivateHost('127.0.0.1.evil.com'), false);
  assert.equal(isPrivateHost(''), false);
});

test('validateSettings 会提示明文 http 风险；chatCompletion 在库层也拒绝发送', async () => {
  const errors = validateSettings({ apiKey: 'k', baseUrl: 'http://example.com', model: 'm' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /泄露 API Key/);

  const stub = stubFetch(() => jsonRes(okBody()));
  try {
    await assert.rejects(
      () => chatCompletion({ ...BASE, baseUrl: 'http://example.com' }),
      (err) => err instanceof ApiError && err.code === 'BAD_BASE_URL',
    );
    assert.equal(stub.calls.length, 0, '被拒绝的请求不能真的发出去');

    await chatCompletion({ ...BASE, baseUrl: 'http://127.0.0.1:9999' });
    assert.equal(stub.calls.length, 1, '本机地址允许明文 http');
  } finally {
    stub.restore();
  }
});

/* ------------------------------------------------------------------ */
/* 设置归一化                                                          */
/* ------------------------------------------------------------------ */

test('normalizeSettings 丢弃未知字段，显式 undefined 不会覆盖默认值', () => {
  const s = normalizeSettings({ evil: 'x', __proto__: { polluted: 1 }, apiKey: 'k', disableThinking: undefined });
  assert.equal('evil' in s, false);
  assert.equal(s.polluted, undefined);
  assert.equal(s.disableThinking, DEFAULT_SETTINGS.disableThinking);
  assert.deepEqual(Object.keys(normalizeSettings({ x: 1 })).sort(), Object.keys(DEFAULT_SETTINGS).sort());
  // 非对象入参不应抛错
  assert.equal(normalizeSettings('oops').baseUrl, DEFAULT_SETTINGS.baseUrl);
  assert.equal(normalizeSettings(null).model, DEFAULT_SETTINGS.model);
});

/* ------------------------------------------------------------------ */
/* 后台调用方鉴权                                                      */
/* ------------------------------------------------------------------ */

test('后台鉴权：只有扩展自己的页面才算「扩展页面」', () => {
  const self = { id: 'abc', origin: 'chrome-extension://abc/' };
  // popup / 管理面板
  assert.equal(isExtensionSender({ id: 'abc', url: 'chrome-extension://abc/src/popup/popup.html' }, self), true);
  assert.equal(isExtensionSender({ id: 'abc', url: 'chrome-extension://abc/src/options/options.html', tab: { id: 1 } }, self), true);
  // 内容脚本：id 相同，但 url 是网页地址
  assert.equal(isExtensionSender({ id: 'abc', url: 'https://evil.example/page', tab: { id: 2 } }, self), false);
  // 页面地址刻意伪装成扩展源前缀（子域名拼接）也不行
  assert.equal(isExtensionSender({ id: 'abc', url: 'https://chrome-extension://abc/' }, self), false);
  // 其它扩展
  assert.equal(isExtensionSender({ id: 'zzz', url: 'chrome-extension://abc/x.html' }, self), false);
  // 缺字段一律拒绝
  assert.equal(isExtensionSender(undefined, self), false);
  assert.equal(isExtensionSender({ id: 'abc' }, self), false);
  assert.equal(isExtensionSender({ id: 'abc', url: 'chrome-extension://abc/' }, { id: '', origin: '' }), false);
});

test('后台鉴权：敏感操作必须是特权消息，内容脚本自己用的消息不在其中', () => {
  for (const type of [
    MSG.SAVE_SETTINGS,
    MSG.RESET_SETTINGS,
    MSG.TEST_CONNECTION,
    MSG.RUN_ON_TAB,
    MSG.GET_CACHE_STATS,
    MSG.CLEAR_CACHE,
  ]) {
    assert.equal(isPrivilegedMessage(type), true, type);
  }
  // 内容脚本需要的：读设置（脱敏后）、上报状态、打开设置页
  for (const type of [MSG.GET_SETTINGS, MSG.STATE_CHANGED, MSG.OPEN_OPTIONS, 'PING', undefined]) {
    assert.equal(isPrivilegedMessage(type), false, String(type));
  }
});

test('后台鉴权：RUN_ON_TAB 只透传白名单命令', () => {
  assert.equal(isAllowedTabCommand(MSG.RUN_TRANSLATE_PAGE), true);
  assert.equal(isAllowedTabCommand(MSG.RUN_TRANSLATE_SELECTION), true);
  assert.equal(isAllowedTabCommand(MSG.CMD_SUMMARIZE_PAGE), true);
  assert.equal(isAllowedTabCommand('GET_SETTINGS'), false);
  assert.equal(isAllowedTabCommand('CACHE_CLEARED'), false);
  assert.equal(isAllowedTabCommand(undefined), false);
});

test('settingsForContent 抹掉 API Key 且不改动原对象', () => {
  const original = normalizeSettings({ apiKey: 'sk-secret', targetLang: 'ja' });
  const safe = settingsForContent(original);
  assert.equal(safe.apiKey, '');
  assert.equal(safe.targetLang, 'ja');
  assert.equal(original.apiKey, 'sk-secret');
  assert.equal(JSON.stringify(safe).includes('sk-secret'), false);
});

/* ------------------------------------------------------------------ */
/* API 客户端：参数降级                                                */
/* ------------------------------------------------------------------ */

test('isUnsupportedParamError：只有请求里真的带了该参数才算参数问题', () => {
  const body = { model: 'm', max_tokens: 100, temperature: 0.3 };
  assert.equal(isUnsupportedParamError(400, 'unknown field: thinking', body), null, '没发 thinking，不该降级');
  assert.equal(isUnsupportedParamError(400, 'temperature unsupported', body), 'temperature');
  assert.equal(isUnsupportedParamError(400, 'max_tokens too large', body), 'max_tokens');
  assert.equal(
    isUnsupportedParamError(400, "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.", body),
    'max_completion_tokens',
  );
  assert.equal(isUnsupportedParamError(500, 'temperature', body), null, '只有 400/422 才可能是参数问题');
  assert.equal(isUnsupportedParamError(422, 'thinking', { thinking: {} }), 'thinking');
});

test('max_tokens 被拒时真的会去掉该参数后重试（旧实现会原样重发）', async () => {
  const stub = stubFetch((n) =>
    n === 1 ? jsonRes({ error: { message: 'max_tokens is too large: 9000' } }, 400) : jsonRes(okBody('done')),
  );
  try {
    const res = await chatCompletion({ ...BASE, maxTokens: 9000 });
    assert.equal(res.content, 'done');
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].body.max_tokens, 9000);
    assert.equal('max_tokens' in stub.calls[1].body, false, '第二次请求必须不再带 max_tokens');
  } finally {
    stub.restore();
  }
});

test('只认 max_completion_tokens 的模型：改参数名而不是丢掉上限', async () => {
  const stub = stubFetch((n) =>
    n === 1
      ? jsonRes({ error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } }, 400)
      : jsonRes(okBody('ok')),
  );
  try {
    await chatCompletion({ ...BASE, maxTokens: 777 });
    assert.equal(stub.calls.length, 2);
    assert.equal('max_tokens' in stub.calls[1].body, false);
    assert.equal(stub.calls[1].body.max_completion_tokens, 777);
  } finally {
    stub.restore();
  }
});

test('thinking / temperature / stream_options 不被支持时逐个降级，直到成功', async () => {
  const stub = stubFetch((n, body) => {
    if (body.thinking) return jsonRes({ error: { message: 'unknown parameter: thinking' } }, 400);
    if (body.stream_options) return jsonRes({ error: { message: 'stream_options not allowed' } }, 400);
    if (body.temperature !== undefined) return jsonRes({ error: { message: 'temperature is not supported' } }, 400);
    return jsonRes(okBody('fine'));
  });
  try {
    const res = await chatCompletion({ ...BASE, temperature: 0.3, disableThinking: true });
    assert.equal(res.content, 'fine');
    assert.equal(stub.calls.length, 3);
    const last = stub.calls.at(-1).body;
    assert.equal('thinking' in last, false);
    assert.equal('temperature' in last, false);
  } finally {
    stub.restore();
  }
});

test('无关的 400 不会被误判成参数问题而白白重发', async () => {
  const stub = stubFetch(() => jsonRes({ error: { message: 'the thinking process of the account is blocked' } }, 400));
  try {
    await assert.rejects(
      () => chatCompletion({ ...BASE, disableThinking: false }),
      (err) => err.code === 'HTTP_400',
    );
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

/* ------------------------------------------------------------------ */
/* API 客户端：瞬时错误重试                                            */
/* ------------------------------------------------------------------ */

test('retryDelayMs：听 Retry-After，设上限；否则指数退避', () => {
  assert.equal(retryDelayMs('2', 0), 2000);
  assert.equal(retryDelayMs('999', 0), 8000);
  assert.equal(retryDelayMs(null, 0), 800);
  assert.equal(retryDelayMs(null, 1), 1600);
  assert.equal(retryDelayMs('abc', 1), 1600);
  assert.equal(retryDelayMs('-3', 0), 800);
});

test('429 限流会按 Retry-After 退避后重试并最终成功', async () => {
  const stub = stubFetch((n) =>
    n === 1 ? jsonRes({ error: { message: 'slow down' } }, 429, { 'retry-after': '0.01' }) : jsonRes(okBody('after retry')),
  );
  try {
    const res = await chatCompletion(BASE);
    assert.equal(res.content, 'after retry');
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test('持续 503 最多重试 2 次后报错，不会无限重试', async () => {
  const stub = stubFetch(() => jsonRes({ error: { message: 'bad gateway' } }, 503, { 'retry-after': '0.01' }));
  try {
    await assert.rejects(
      () => chatCompletion(BASE),
      (err) => err.code === 'HTTP_503',
    );
    assert.equal(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test('401 / 404 这类确定性错误不重试', async () => {
  for (const status of [401, 403, 404]) {
    const stub = stubFetch(() => jsonRes({ error: { message: 'nope' } }, status));
    try {
      await assert.rejects(() => chatCompletion(BASE), (err) => err.code === `HTTP_${status}`);
      assert.equal(stub.calls.length, 1, `HTTP ${status}`);
    } finally {
      stub.restore();
    }
  }
});

test('退避等待期间取消，立即以 ABORTED 结束', async () => {
  const stub = stubFetch(() => jsonRes({ error: { message: 'busy' } }, 429, { 'retry-after': '5' }));
  const controller = new AbortController();
  try {
    const pending = chatCompletion({ ...BASE, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    await assert.rejects(pending, (err) => err.code === 'ABORTED');
    assert.ok(Date.now() - started < 1500, '不该傻等完整的 5 秒退避');
  } finally {
    stub.restore();
  }
});

/* ------------------------------------------------------------------ */
/* API 客户端：异常响应                                                */
/* ------------------------------------------------------------------ */

test('HTTP 200 却返回 HTML：给出可操作的提示，而不是 "Unexpected token <"', async () => {
  const stub = stubFetch(
    () => new Response('<html><body>login</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  );
  try {
    await assert.rejects(
      () => chatCompletion(BASE),
      (err) => err.code === 'BAD_RESPONSE' && /Base URL/.test(err.message) && !/Unexpected token/.test(err.message),
    );
  } finally {
    stub.restore();
  }
});

test('HTTP 200 里包着 error 对象：当作错误上报', async () => {
  const stub = stubFetch(() => jsonRes({ error: { message: 'quota exceeded' } }));
  try {
    await assert.rejects(
      () => chatCompletion(BASE),
      (err) => err.code === 'API_ERROR' && /quota exceeded/.test(err.message),
    );
  } finally {
    stub.restore();
  }
});

/* ------------------------------------------------------------------ */
/* API 客户端：流式                                                    */
/* ------------------------------------------------------------------ */

test('流式：最后一个分片没有换行结尾时，内容与用量也不丢', async () => {
  const stub = stubFetch(() =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
    ]),
  );
  const seen = [];
  try {
    const res = await chatCompletion({ ...BASE, stream: true, onDelta: (d) => seen.push(d) });
    assert.equal(res.content, 'Hello');
    assert.deepEqual(seen, ['He', 'llo']);
    assert.equal(res.usage?.total_tokens, 5, '写在最后一行的用量不能被吞掉');
    assert.equal(res.finishReason, 'stop');
  } finally {
    stub.restore();
  }
});

test('流式：数据流里夹带 error 对象时抛出 STREAM_ERROR', async () => {
  const stub = stubFetch(() =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
      'data: {"error":{"message":"upstream exploded"}}\n\n',
    ]),
  );
  try {
    await assert.rejects(
      () => chatCompletion({ ...BASE, stream: true }),
      (err) => err.code === 'STREAM_ERROR' && /upstream exploded/.test(err.message),
    );
  } finally {
    stub.restore();
  }
});

test('流式读取中途取消：以 ABORTED 结束，而不是抛出裸 AbortError', async () => {
  const controller = new AbortController();
  const stub = stubFetch((n, body, init) => sseResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n'], { hang: true, signal: init.signal }));
  try {
    await assert.rejects(
      () => chatCompletion({ ...BASE, stream: true, signal: controller.signal, onDelta: () => controller.abort() }),
      (err) => err instanceof ApiError && err.code === 'ABORTED',
    );
  } finally {
    stub.restore();
  }
});

test('流式读取中途超时：以 TIMEOUT 结束，而不是抛出裸 AbortError', async () => {
  const stub = stubFetch((n, body, init) => sseResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n'], { hang: true, signal: init.signal }));
  try {
    await assert.rejects(
      () => chatCompletion({ ...BASE, stream: true, timeoutMs: 60 }),
      (err) => err instanceof ApiError && err.code === 'TIMEOUT',
    );
  } finally {
    stub.restore();
  }
});

test('请求结束后不在外部 signal 上遗留监听器（长寿命 signal 不会越积越多）', async () => {
  const controller = new AbortController();
  const stub = stubFetch(() => jsonRes(okBody()));
  try {
    for (let i = 0; i < 25; i += 1) await chatCompletion({ ...BASE, signal: controller.signal });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    stub.restore();
  }
});

/* ------------------------------------------------------------------ */
/* 批量翻译：失败处理                                                  */
/* ------------------------------------------------------------------ */

const TRANSLATE_SETTINGS = {
  apiKey: 'k',
  baseUrl: 'https://api.example.com',
  model: 'm',
  sourceLang: 'auto',
  targetLang: 'zh',
  disableThinking: true,
};

test('批量翻译：一批失败后立即中止其余在途批次，并报出真正的根因', async () => {
  let aborted = 0;
  const stub = stubFetch((n, body, init) => {
    if (n === 1) return jsonRes({ error: { message: 'bad key' } }, 401);
    return new Promise((_, reject) => {
      init.signal.addEventListener(
        'abort',
        () => {
          aborted += 1;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        },
        { once: true },
      );
    });
  });
  try {
    await assert.rejects(
      () =>
        translateTexts(TRANSLATE_SETTINGS, ['alpha one', 'bravo two', 'charlie three', 'delta four'], {
          limits: { maxChars: 5, maxItems: 1, concurrency: 3 },
        }),
      (err) => err.code === 'HTTP_401', // 不能被后到的 ABORTED 盖掉
    );
    assert.equal(aborted, 2, '另外两个在途请求应被中止');
    assert.equal(stub.calls.length, 3, '失败后不应再发起第四批');
  } finally {
    stub.restore();
  }
});

test('批量翻译：外部取消仍然生效，并以 ABORTED 结束', async () => {
  const controller = new AbortController();
  const stub = stubFetch(
    (n, body, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
  );
  try {
    const pending = translateTexts(TRANSLATE_SETTINGS, ['alpha one', 'bravo two', 'charlie three'], {
      signal: controller.signal,
      limits: { maxChars: 5, maxItems: 1, concurrency: 3 },
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (err) => err.code === 'ABORTED');
  } finally {
    stub.restore();
  }
});

test('批量翻译：成功路径不受影响，数量与顺序一致', async () => {
  const stub = stubFetch((n, body) => {
    const user = body.messages.find((m) => m.role === 'user').content;
    const items = [...user.matchAll(/^\[(\d+)\] (.*)$/gm)].map((m) => `译:${m[2]}`);
    return jsonRes(okBody(JSON.stringify(items)));
  });
  try {
    const texts = ['one apple', 'two pears', 'three plums', 'four limes'];
    const result = await translateTexts(TRANSLATE_SETTINGS, texts, { limits: { maxChars: 30, maxItems: 2, concurrency: 2 } });
    assert.deepEqual(result.translations, texts.map((t) => `译:${t}`));
    assert.equal(result.requestCount, 2);
  } finally {
    stub.restore();
  }
});

/* ------------------------------------------------------------------ */
/* 缓存：体积上限                                                      */
/* ------------------------------------------------------------------ */

test('pruneCache：除条数外还按体积裁剪，保留最近使用的', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ k: `site\u0000zh\u0000s${i}`, v: 'x'.repeat(1000), t: i }));
  const kept = pruneCache(entries, 5000, 5000);
  assert.ok(kept.length >= 1 && kept.length < 10);
  assert.ok(cacheSizeBytes(kept) <= 5000);
  assert.deepEqual(kept, entries.slice(0, kept.length), '被丢弃的必须是尾部（最久未用）');
  // 条数上限依旧生效
  assert.equal(pruneCache(entries, 3, 10 * 1024 * 1024).length, 3);
  // 非法体积上限回退到默认值，不会清空缓存
  assert.equal(pruneCache(entries, 5000, NaN).length, 10);
  assert.equal(pruneCache(entries, 5000, -1).length, 10);
});

test('putTranslations 默认带体积上限：塞入海量长文本后总量仍受控', () => {
  const sources = Array.from({ length: 4000 }, (_, i) => `${i}-${'a'.repeat(900)}`);
  const translations = sources.map((s) => `译-${s}`);
  const result = putTranslations([], 'example.com', 'zh', sources, translations, { limit: 5000 });
  assert.ok(cacheSizeBytes(result) <= DEFAULT_CACHE_MAX_BYTES);
  assert.ok(result.length > 0 && result.length < sources.length);
  // 最近写入的在最前
  assert.ok(result[0].k.endsWith(sources.at(-1)));
});
