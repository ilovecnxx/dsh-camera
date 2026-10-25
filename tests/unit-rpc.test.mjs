// unit-rpc：mock ctx.webServer/ctx.connection + tokens/injector，用真实 http server 驱动
// lib/rpc.js 的 handler，验证 Connection envelope 语义、鉴权、错误码与 4 个 endpoint。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { installRpc, RPC_CHANNEL, ENDPOINTS } from '../lib/rpc.js';
import { renderQrPath } from '../lib/qr.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeLog() {
  const entries = [];
  return {
    entries,
    info: (...args) => entries.push(['info', ...args]),
    warn: (...args) => entries.push(['warn', ...args]),
    error: (...args) => entries.push(['error', ...args]),
  };
}

const LAN_IP = '10.0.0.5';
const PORT = 3579;

function makeServer(overrides = {}) {
  return {
    info: () => ({
      running: true,
      port: PORT,
      lanIp: LAN_IP,
      localOnly: false,
      startedAt: 1,
      version: '0.1.0',
      warning: null,
    }),
    buildUrl: (token) => `http://${LAN_IP}:${PORT}/c/${token}`,
    ...overrides,
  };
}

function makeTokens(overrides = {}) {
  const calls = { arm: [], armNew: [], disarm: [], recent: [], flush: 0 };
  return {
    calls,
    arm: (input) => {
      calls.arm.push(input);
      return { token: 'tok-arm', sessionId: input.sessionId, title: input.title, createdAt: 1, expiresAt: 999, uploads: 0 };
    },
    armNew: (input) => {
      calls.armNew.push(input);
      return { token: 'tok-new', sessionId: input.sessionId, title: input.title, createdAt: 2, expiresAt: 999, uploads: 0 };
    },
    disarm: (token) => {
      calls.disarm.push(token);
      return overrides.disarmed ?? true;
    },
    recent: (limit) => {
      calls.recent.push(limit);
      return overrides.recent ?? [{ sessionId: 'session-1', title: 't', at: 1, filename: 'a.png', ok: true }];
    },
    flush: async () => {
      calls.flush += 1;
    },
    ...overrides.methods,
  };
}

function makeInjector(overrides = {}) {
  const calls = { validateSession: [] };
  return {
    calls,
    validateSession: async (sessionId) => {
      calls.validateSession.push(sessionId);
      if (overrides.validate) return overrides.validate(sessionId);
      return { ok: true, sessionId };
    },
    deliver: async () => ({ ok: true, requestId: 'x', count: 1 }),
  };
}

const CONFIG = Object.freeze({
  enabled: true,
  port: PORT,
  lanIpOverride: '',
  tokenTtlMs: 2 * 60 * 60 * 1000,
  maxFilesPerUpload: 6,
});

/**
 * 启动真实 HTTP 服务承载 installRpc 注册的 handler。
 * @param {{rejection?: Function, serverRef?: Function, serverErrorRef?: Function,
 *          tokens?: object, injector?: object, registerReturn?: Function}} options
 */
async function withRpc(options = {}) {
  const registrations = [];
  const disposed = [];
  const rejectionCalls = [];
  const rejection = options.rejection ?? (() => undefined);
  const ctx = {
    webServer: {
      register: (registration) => {
        registrations.push(registration);
        if (options.registerReturn !== undefined) return options.registerReturn(disposed);
        return () => disposed.push(true);
      },
    },
    connection: {
      requestRejection: (req) => {
        rejectionCalls.push(req.url);
        return rejection(req);
      },
    },
  };
  const tokens = options.tokens ?? makeTokens(options.tokenOverrides);
  const injector = options.injector ?? makeInjector(options.injectorOverrides);
  const log = makeLog();
  const serverRef = options.serverRef ?? (() => makeServer(options.serverOverrides));
  const serverErrorRef = options.serverErrorRef ?? (() => null);
  const handle = installRpc({ ctx, tokens, injector, serverRef, serverErrorRef, config: CONFIG, version: '0.1.0-test', log });
  assert.equal(typeof registrations[0]?.handler, 'function', 'installRpc 必须通过 webServer.register 注册 handler');
  const handler = registrations[0].handler;
  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
  };
  return {
    port,
    handle,
    registrations,
    disposed,
    rejectionCalls,
    tokens,
    injector,
    log,
    close,
  };
}

async function request(port, { method = 'POST', path = '/', body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json };
}

function envelope(endpoint, payload, rpcId = 'rpc-1') {
  return { type: 'client-request', rpcId, method: endpoint, payload };
}

// ---------------------------------------------------------------------------
// 注册与降级
// ---------------------------------------------------------------------------

test('installRpc: 以 {kind:"prefix", path:"/dsh-camera"} 注册 handler；可用返回 available:true', async () => {
  const rpc = await withRpc();
  try {
    assert.equal(rpc.handle.available, true);
    assert.equal(rpc.registrations.length, 1);
    assert.equal(rpc.registrations[0].kind, 'prefix');
    assert.equal(rpc.registrations[0].path, RPC_CHANNEL);
    assert.equal(RPC_CHANNEL, '/dsh-camera');
  } finally {
    await rpc.close();
  }
});

test('installRpc: 缺少 webServer/connection 时 available:false，dispose 安全', async () => {
  for (const ctx of [
    { connection: { requestRejection: () => undefined } },
    { webServer: { register() {} } },
  ]) {
    const log = makeLog();
    const handle = installRpc({ ctx, tokens: makeTokens(), injector: makeInjector(), serverRef: () => null, serverErrorRef: () => null, config: CONFIG, version: 'x', log });
    assert.equal(handle.available, false);
    await handle.dispose();
    await handle.dispose();
    assert.ok(log.entries.some(([level, message]) => level === 'warn' && /unavailable/.test(message)));
  }
});

test('dispose: webServer.register 返回同步 disposer 时被调用（当前组合的真实形态）', async () => {
  const first = await withRpc();
  try {
    await first.handle.dispose();
    assert.equal(first.disposed.length, 1);
  } finally {
    await first.close();
  }
});

// 已知问题（已报 Lead）：rpc.js 对 `register()` 返回 Promise 的分支只创建了清理函数、
// 没有调用它，且 dispose() 不 await 异步清理。当前 dsh-host-webserver 的 register()
// 同步返回 disposer，所以生产组合走不到该分支；保留 TODO 防止未来组合变化时静默失效。
test(
  'dispose: register 返回 Promise<disposer> 时也应被调用（rpc.js 已知缺陷）',
  { todo: 'rpc.js promise-disposer 分支未调用 disposer（已报 Lead）' },
  async () => {
    const second = await withRpc({
      registerReturn: (disposed) => Promise.resolve(() => disposed.push('disposed')),
    });
    try {
      await second.handle.dispose();
      await second.handle.dispose();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(second.disposed, ['disposed'], 'promise disposer 只应执行一次');
    } finally {
      await second.close();
    }
  },
);

// ---------------------------------------------------------------------------
// envelope / 路由 / 鉴权
// ---------------------------------------------------------------------------

test('envelope 成功：POST /dsh-camera/camera.status → 200 server-response + result.ok:true', async () => {
  const rpc = await withRpc();
  try {
    const response = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.status}`,
      body: envelope(ENDPOINTS.status, {}, 'rpc-42'),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.json.type, 'server-response');
    assert.equal(response.json.rpcId, 'rpc-42');
    assert.deepEqual(response.json.result, {
      ok: true,
      value: {
        server: { running: true, port: PORT, lanIp: LAN_IP, localOnly: false, warning: null },
        config: {
          enabled: true,
          port: PORT,
          tokenTtlMs: CONFIG.tokenTtlMs,
          maxFilesPerUpload: CONFIG.maxFilesPerUpload,
        },
        version: '0.1.0-test',
      },
    });
    assert.equal(rpc.rejectionCalls.length, 1, '每个请求都必须经过 connection.requestRejection');
  } finally {
    await rpc.close();
  }
});

test('envelope 失败：result.ok:false + error{code,message,details}', async () => {
  const rpc = await withRpc();
  try {
    const response = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.arm}`,
      body: envelope(ENDPOINTS.arm, {}, 'rpc-7'),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.rpcId, 'rpc-7');
    assert.equal(response.json.result.ok, false);
    assert.equal(response.json.result.error.code, 'bad-request');
    assert.equal(typeof response.json.result.error.message, 'string');
    assert.deepEqual(response.json.result.error.details, {});
  } finally {
    await rpc.close();
  }
});

test('鉴权：requestRejection 返回 401/403 → 拒绝且不进入业务逻辑；抛错视为 403', async () => {
  for (const [rejection, expectedStatus, expectedText] of [
    [() => 401, 401, 'unauthorized'],
    [() => 403, 403, 'forbidden'],
    [() => { throw new Error('admission exploded'); }, 403, 'forbidden'],
  ]) {
    const rpc = await withRpc({ rejection });
    try {
      const response = await request(rpc.port, {
        path: `${RPC_CHANNEL}/${ENDPOINTS.status}`,
        body: envelope(ENDPOINTS.status, {}),
      });
      assert.equal(response.status, expectedStatus);
      assert.equal(response.text, expectedText);
      assert.equal(rpc.tokens.calls.arm.length, 0, '被拒请求不得执行业务 handler');
    } finally {
      await rpc.close();
    }
  }
});

test('路由：GET / 尾斜杠 / 非本通道路径 → 404', async () => {
  const rpc = await withRpc();
  try {
    for (const [method, path] of [
      ['GET', `${RPC_CHANNEL}/${ENDPOINTS.status}`],
      ['POST', `${RPC_CHANNEL}/`],
      ['POST', '/other/thing'],
    ]) {
      const response = await request(rpc.port, { method, path, body: method === 'POST' ? envelope(ENDPOINTS.status, {}) : undefined });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal(response.text, 'not found');
    }
  } finally {
    await rpc.close();
  }
});

test('content-type 非 application/json → 415；非法 JSON → 400', async () => {
  const rpc = await withRpc();
  try {
    const wrongType = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.status}`,
      body: JSON.stringify(envelope(ENDPOINTS.status, {})),
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(wrongType.status, 415);

    const badJson = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.status}`,
      body: '{not json',
    });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.text, 'body is not JSON');
  } finally {
    await rpc.close();
  }
});

test('envelope 格式错误：缺 rpcId / method 与 endpoint 不一致 → 200 gateway/bad-request', async () => {
  const rpc = await withRpc();
  try {
    // 空 body
    const empty = await request(rpc.port, { path: `${RPC_CHANNEL}/${ENDPOINTS.status}`, body: '' });
    assert.equal(empty.status, 200);
    assert.equal(empty.json.rpcId, 'invalid-request');
    assert.equal(empty.json.result.error.code, 'gateway/bad-request');

    // method 与 URL endpoint 不一致
    const mismatch = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.status}`,
      body: envelope(ENDPOINTS.disarm, { token: 'x' }, 'rpc-mismatch'),
    });
    assert.equal(mismatch.status, 200);
    assert.equal(mismatch.json.rpcId, 'rpc-mismatch');
    assert.equal(mismatch.json.result.error.code, 'gateway/bad-request');
  } finally {
    await rpc.close();
  }
});

test('未知 endpoint（合法段格式）→ 200 gateway/bad-request 且消息含 endpoint 名', async () => {
  const rpc = await withRpc();
  try {
    const response = await request(rpc.port, {
      path: `${RPC_CHANNEL}/camera.unknown`,
      body: envelope('camera.unknown', {}),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.result.error.code, 'gateway/bad-request');
    assert.match(response.json.result.error.message, /Unknown camera endpoint/);
  } finally {
    await rpc.close();
  }
});

test('请求体超过 1 MiB → 413，不解析 body', async () => {
  const rpc = await withRpc();
  try {
    const big = 'x'.repeat(1024 * 1024 + 10);
    const response = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.status}`,
      body: big,
    });
    assert.equal(response.status, 413);
    assert.match(response.text, /too large/);
  } finally {
    await rpc.close();
  }
});

// ---------------------------------------------------------------------------
// camera.status
// ---------------------------------------------------------------------------

test('camera.status: 服务器未启动时 running:false 且 warning 取 serverErrorRef', async () => {
  const rpc = await withRpc({
    serverRef: () => null,
    serverErrorRef: () => 'EADDRINUSE: port busy',
  });
  try {
    const response = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.status}`,
      body: envelope(ENDPOINTS.status, {}),
    });
    const value = response.json.result.value;
    assert.equal(value.server.running, false);
    assert.equal(value.server.port, null);
    assert.equal(value.server.lanIp, null);
    assert.equal(value.server.warning, 'EADDRINUSE: port busy');
    assert.equal(value.version, '0.1.0-test');
  } finally {
    await rpc.close();
  }
});

// ---------------------------------------------------------------------------
// camera.arm
// ---------------------------------------------------------------------------

test('camera.arm: 成功返回 token/url/qr/expiresAt/sessionId/title/lanIp/server.port 并 flush token 存储', async () => {
  const rpc = await withRpc();
  try {
    const response = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.arm}`,
      body: envelope(ENDPOINTS.arm, { sessionId: 'session-abc', title: '我的对话' }, 'rpc-arm'),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.result.ok, true, JSON.stringify(response.json.result));
    const value = response.json.result.value;
    assert.equal(value.token, 'tok-arm');
    assert.equal(value.url, `http://${LAN_IP}:${PORT}/c/tok-arm`);
    assert.equal(value.sessionId, 'session-abc');
    assert.equal(value.title, '我的对话');
    assert.equal(value.expiresAt, 999);
    assert.equal(value.lanIp, LAN_IP);
    assert.deepEqual(value.server, { port: PORT });
    assert.equal(typeof value.qr.path, 'string');
    assert.equal(value.qr.size, renderQrPath(value.url).size);
    assert.deepEqual(rpc.tokens.calls.arm, [{ sessionId: 'session-abc', title: '我的对话' }]);
    assert.equal(rpc.tokens.calls.armNew.length, 0);
    assert.equal(rpc.tokens.calls.flush, 1, 'arm 成功后必须 flush 持久化 token');
  } finally {
    await rpc.close();
  }
});

test('camera.arm: rotate:true 走 armNew（强制新 token）', async () => {
  const rpc = await withRpc();
  try {
    const response = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.arm}`,
      body: envelope(ENDPOINTS.arm, { sessionId: 'session-abc', rotate: true }),
    });
    assert.equal(response.json.result.ok, true);
    assert.equal(response.json.result.value.token, 'tok-new');
    assert.equal(rpc.tokens.calls.armNew.length, 1);
    assert.equal(rpc.tokens.calls.arm.length, 0);
  } finally {
    await rpc.close();
  }
});

test('camera.arm: title 清洗（控制字符/trim/截断 120）', async () => {
  const rpc = await withRpc();
  try {
    await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.arm}`,
      body: envelope(ENDPOINTS.arm, { sessionId: 's', title: '  a\u0000b\u001f  ' }),
    });
    assert.deepEqual(rpc.tokens.calls.arm[0], { sessionId: 's', title: 'ab' });
    await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.arm}`,
      body: envelope(ENDPOINTS.arm, { sessionId: 's', title: 'x'.repeat(300) }),
    });
    assert.equal(rpc.tokens.calls.arm[1].title.length, 120);
  } finally {
    await rpc.close();
  }
});

test('camera.arm: 缺 sessionId → bad-request；validateSession 失败 → 透传 code', async () => {
  const rpc = await withRpc({
    injectorOverrides: {
      validate: (sessionId) =>
        sessionId === 'session-missing'
          ? { ok: false, code: 'session/not-found', message: 'Session "session-missing" was not found.' }
          : { ok: true, sessionId },
    },
  });
  try {
    const missing = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.arm}`,
      body: envelope(ENDPOINTS.arm, { title: 'x' }),
    });
    assert.equal(missing.json.result.error.code, 'bad-request');

    const notFound = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.arm}`,
      body: envelope(ENDPOINTS.arm, { sessionId: 'session-missing' }),
    });
    assert.equal(notFound.json.result.error.code, 'session/not-found');
    assert.equal(notFound.json.result.error.message, 'Session "session-missing" was not found.');
    assert.equal(rpc.tokens.calls.arm.length, 0, '会话无效时不得创建 token');
  } finally {
    await rpc.close();
  }
});

test('camera.arm: LAN server 未运行 → server-unavailable；无 LAN 地址 → no-lan-address', async () => {
  const unavailable = await withRpc({ serverRef: () => null, serverErrorRef: () => 'server failed to start' });
  try {
    const response = await request(unavailable.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.arm}`,
      body: envelope(ENDPOINTS.arm, { sessionId: 's' }),
    });
    assert.equal(response.json.result.error.code, 'server-unavailable');
    assert.equal(response.json.result.error.message, 'server failed to start');
  } finally {
    await unavailable.close();
  }

  const noLan = await withRpc({ serverOverrides: { buildUrl: () => '' } });
  try {
    const response = await request(noLan.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.arm}`,
      body: envelope(ENDPOINTS.arm, { sessionId: 's' }),
    });
    assert.equal(response.json.result.error.code, 'no-lan-address');
    assert.match(response.json.result.error.message, /lanIpOverride/);
  } finally {
    await noLan.close();
  }
});

test('camera.arm: token 存储抛错 → 200 internal（不让异常打到 HTTP 层）', async () => {
  const rpc = await withRpc({
    tokenOverrides: { methods: { arm: () => { throw new Error('disk full'); } } },
  });
  try {
    const response = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.arm}`,
      body: envelope(ENDPOINTS.arm, { sessionId: 's' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.result.error.code, 'internal');
    assert.equal(response.json.result.error.message, 'disk full');
  } finally {
    await rpc.close();
  }
});

// ---------------------------------------------------------------------------
// camera.disarm / camera.recent
// ---------------------------------------------------------------------------

test('camera.disarm: token 缺失 → bad-request；成功/未命中返回 disarmed，仅 true 时 flush', async () => {
  const rpc = await withRpc();
  try {
    const missing = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.disarm}`,
      body: envelope(ENDPOINTS.disarm, {}),
    });
    assert.equal(missing.json.result.error.code, 'bad-request');

    const success = await request(rpc.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.disarm}`,
      body: envelope(ENDPOINTS.disarm, { token: '  tok-arm  ' }),
    });
    assert.equal(success.json.result.ok, true);
    assert.deepEqual(success.json.result.value, { disarmed: true });
    assert.deepEqual(rpc.tokens.calls.disarm, ['tok-arm'], 'token 应 trim');
    assert.equal(rpc.tokens.calls.flush, 1, 'disarm 命中必须 flush');
  } finally {
    await rpc.close();
  }

  const miss = await withRpc({ tokenOverrides: { disarmed: false } });
  try {
    const response = await request(miss.port, {
      path: `${RPC_CHANNEL}/${ENDPOINTS.disarm}`,
      body: envelope(ENDPOINTS.disarm, { token: 'unknown' }),
    });
    assert.deepEqual(response.json.result.value, { disarmed: false });
    assert.equal(miss.tokens.calls.flush, 0, '未命中不需要 flush');
  } finally {
    await miss.close();
  }
});

test('camera.recent: 默认 limit 10；limit 夹紧到 1..50', async () => {
  const rpc = await withRpc();
  try {
    const cases = [
      [{}, 10],
      [{ limit: 3 }, 3],
      [{ limit: 999 }, 50],
      [{ limit: -5 }, 1],
      [{ limit: 'abc' }, 10],
      [{ limit: 7.9 }, 7],
      [null, 10],
    ];
    for (const [payload, expected] of cases) {
      const response = await request(rpc.port, {
        path: `${RPC_CHANNEL}/${ENDPOINTS.recent}`,
        body: envelope(ENDPOINTS.recent, payload),
      });
      assert.equal(response.json.result.ok, true);
      assert.equal(rpc.tokens.calls.recent.at(-1), expected, `payload=${JSON.stringify(payload)}`);
      assert.deepEqual(response.json.result.value.uploads, [
        { sessionId: 'session-1', title: 't', at: 1, filename: 'a.png', ok: true },
      ]);
    }
  } finally {
    await rpc.close();
  }
});
