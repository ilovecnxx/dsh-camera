// dsh-camera · TokenStore 单元测试（DESIGN 3.3）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TokenStore } from '../lib/tokens.js';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function withStore(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cam-tokens-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = options.file ?? path.join(dir, 'state.json');
  let clock = options.clock ?? T0;
  const store = new TokenStore({
    file,
    ttlMs: options.ttlMs ?? HOUR,
    maxTokens: options.maxTokens,
    now: () => clock,
  });
  await store.load();
  return {
    dir,
    file,
    store,
    tick(ms) {
      clock += ms;
    },
    get clock() {
      return clock;
    },
  };
}

test('arm: 新 token 形状与默认字段', async (t) => {
  const { store, clock } = await withStore(t);
  const entry = store.arm({ sessionId: 'sess-1', title: '测试对话' });
  assert.match(entry.token, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(entry.sessionId, 'sess-1');
  assert.equal(entry.title, '测试对话');
  assert.equal(entry.createdAt, clock);
  assert.equal(entry.expiresAt, clock + HOUR);
  assert.equal(entry.uploads, 0);
  assert.equal(entry.lastUploadAt, null);
  assert.deepEqual(store.get(entry.token), entry);
  assert.equal(store.status().tokens, 1);
});

test('arm: 同一 session 复用未过期 token，不同 session 各自新建', async (t) => {
  const { store } = await withStore(t);
  const first = store.arm({ sessionId: 's1', title: 'A' });
  const again = store.arm({ sessionId: 's1', title: 'B' });
  assert.equal(again.token, first.token);
  assert.equal(again.title, 'A'); // 复用时不改 title（最小实现）
  const other = store.arm({ sessionId: 's2' });
  assert.notEqual(other.token, first.token);
  assert.equal(store.status().tokens, 2);
});

test('armNew: 强制新建，旧 token 保留至过期', async (t) => {
  const { store } = await withStore(t);
  const first = store.arm({ sessionId: 's1' });
  const second = store.armNew({ sessionId: 's1' });
  assert.notEqual(second.token, first.token);
  assert.ok(store.get(first.token));
  assert.ok(store.get(second.token));
  assert.equal(store.status().tokens, 2);
  // rotate 之后再次 arm 应复用最新创建的那个 token（保证面板展示新链接）
  const reused = store.arm({ sessionId: 's1' });
  assert.equal(reused.token, second.token);
});

test('get: 过期/未知/非法入参返回 null 并 prune', async (t) => {
  const { store, tick } = await withStore(t, { ttlMs: 10 * MINUTE });
  const entry = store.arm({ sessionId: 's1' });
  assert.equal(store.get(entry.token).token, entry.token);
  tick(10 * MINUTE); // expiresAt > now 不成立
  assert.equal(store.get(entry.token), null);
  assert.equal(store.status().tokens, 0);
  assert.equal(store.get('nonexistent-token-000000'), null);
  assert.equal(store.get(''), null);
  assert.equal(store.get(null), null);
  assert.equal(store.get(123), null);
});

test('arm: 旧 token 过期后会为同一 session 新建', async (t) => {
  const { store, tick } = await withStore(t, { ttlMs: MINUTE });
  const old = store.arm({ sessionId: 's1' });
  tick(MINUTE + 1);
  const fresh = store.arm({ sessionId: 's1' });
  assert.notEqual(fresh.token, old.token);
  assert.equal(store.get(old.token), null);
  assert.equal(store.status().tokens, 1);
});

test('disarm: 撤销已知 token，未知返回 false', async (t) => {
  const { store } = await withStore(t);
  const entry = store.arm({ sessionId: 's1' });
  assert.equal(store.disarm(entry.token), true);
  assert.equal(store.get(entry.token), null);
  assert.equal(store.disarm(entry.token), false);
  assert.equal(store.disarm('nope'), false);
  assert.equal(store.disarm(null), false);
});

test('recordUpload: 累计次数、最近记录顺序与 ok 标记', async (t) => {
  const { store, tick } = await withStore(t);
  const entry = store.arm({ sessionId: 's1', title: '对话' });
  const updated = store.recordUpload(entry.token, { filename: 'photo.jpg', ok: true });
  assert.equal(updated.uploads, 1);
  assert.equal(updated.lastUploadAt, T0);
  assert.deepEqual(store.recent(10), [
    { token: entry.token, sessionId: 's1', title: '对话', at: T0, filename: 'photo.jpg', ok: true, count: 1 },
  ]);
  tick(5);
  store.recordUpload(entry.token, { filename: 'b.png', ok: false });
  assert.equal(store.get(entry.token).uploads, 2);
  assert.deepEqual(
    store.recent().map((item) => [item.filename, item.ok]),
    [
      ['b.png', false],
      ['photo.jpg', true],
    ],
  );
  assert.equal(store.recent(1).length, 1);
  assert.equal(store.recent(0).length, 0);
  assert.equal(store.recent(999).length, 2);
  assert.equal(store.recordUpload('unknown-token-000000', { ok: true }), null);
  assert.equal(store.recordUpload('', { ok: true }), null);
});

test('recordUpload: 过期 token 返回 null 且不产生记录', async (t) => {
  const { store, tick } = await withStore(t, { ttlMs: MINUTE });
  const entry = store.arm({ sessionId: 's1' });
  tick(MINUTE);
  assert.equal(store.recordUpload(entry.token, { filename: 'x.jpg', ok: true }), null);
  assert.equal(store.recent().length, 0);
});

test('recordUpload: filename 去路径/去控制字符；空 filename 为空串', async (t) => {
  const { store } = await withStore(t);
  const entry = store.arm({ sessionId: 's1' });
  store.recordUpload(entry.token, { filename: '../tmp/../../evil\u0000.png', ok: true });
  const [recent] = store.recent(1);
  assert.equal(recent.filename.includes('/'), false);
  assert.equal(recent.filename.includes('\u0000'), false);
  assert.ok(recent.filename.endsWith('.png'));
  store.recordUpload(entry.token, { filename: 42, ok: true });
  assert.equal(store.recent(1)[0].filename, '');
});

test('recent: 最多保留 50 条', async (t) => {
  const { store } = await withStore(t);
  const entry = store.arm({ sessionId: 's1' });
  for (let i = 0; i < 65; i += 1) {
    store.recordUpload(entry.token, { filename: `p${i}.jpg`, ok: i % 2 === 0 });
  }
  assert.equal(store.recent().length, 10); // 默认 limit 10
  assert.equal(store.recent(1000).length, 50);
  assert.equal(store.recent(1)[0].filename, 'p64.jpg');
});

test('title 截断到 120 字符并清洗控制字符', async (t) => {
  const { store } = await withStore(t);
  const longTitle = `标题\u0000${'很长的对话名'.repeat(40)}`;
  const entry = store.arm({ sessionId: 's1', title: longTitle });
  assert.equal(Array.from(entry.title).length, 120);
  assert.equal(entry.title.includes('\u0000'), false);
  assert.equal(entry.title.includes('\n'), false);
});

test('arm/armNew: 缺少 sessionId 抛 TypeError', async (t) => {
  const { store } = await withStore(t);
  assert.throws(() => store.arm({}), TypeError);
  assert.throws(() => store.arm({ sessionId: '' }), TypeError);
  assert.throws(() => store.armNew({}), TypeError);
});

test('flush: 原子写入 version/tokens/recent，文件 mode 0600', async (t) => {
  const { store, file } = await withStore(t);
  const entry = store.arm({ sessionId: 'sess/1', title: 'hello' });
  store.recordUpload(entry.token, { filename: 'p.jpg', ok: true });
  await store.flush();

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.ok(raw.tokens[entry.token]);
  assert.equal(raw.tokens[entry.token].sessionId, 'sess/1');
  assert.equal(raw.tokens[entry.token].uploads, 1);
  assert.equal(raw.recent.length, 1);

  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('load: reload 后 token 与 recent 恢复', async (t) => {
  const { store, file } = await withStore(t);
  const entry = store.arm({ sessionId: 's1', title: '对话名' });
  store.recordUpload(entry.token, { filename: 'a.png', ok: true });
  await store.flush();

  const reloaded = new TokenStore({ file, ttlMs: HOUR, now: () => T0 });
  await reloaded.load();
  assert.deepEqual(reloaded.get(entry.token), store.get(entry.token));
  assert.equal(reloaded.recent(1)[0].filename, 'a.png');
  assert.equal(reloaded.status().tokens, 1);
  assert.equal(reloaded.get(entry.token).uploads, 1);
});

test('load: 文件不存在视为空', async (t) => {
  const { dir } = await withStore(t);
  const store = new TokenStore({ file: path.join(dir, 'missing', 'state.json'), ttlMs: HOUR });
  await store.load();
  assert.equal(store.status().tokens, 0);
  assert.deepEqual(store.recent(), []);
});

test('load: 损坏 JSON / 结构不符视为空，不抛错', async (t) => {
  const { dir } = await withStore(t);
  const file = path.join(dir, 'broken.json');
  await writeFile(file, '{ this is not json');
  const store = new TokenStore({ file, ttlMs: HOUR });
  await store.load();
  assert.equal(store.status().tokens, 0);
  assert.deepEqual(store.recent(), []);

  await writeFile(file, JSON.stringify({ version: 2, tokens: [1, 2, 3], recent: 'nope' }));
  const store2 = new TokenStore({ file, ttlMs: HOUR });
  await store2.load();
  assert.equal(store2.status().tokens, 0);

  await writeFile(file, JSON.stringify({ version: 1, tokens: { 'short': { sessionId: 'x' } } }));
  const store3 = new TokenStore({ file, ttlMs: HOUR });
  await store3.load();
  assert.equal(store3.status().tokens, 0);
});

test('load: 顺带 prune 过期 token', async (t) => {
  const { store, file } = await withStore(t, { ttlMs: MINUTE });
  const alive = store.arm({ sessionId: 'alive' });
  await store.flush();

  const later = new TokenStore({ file, ttlMs: MINUTE, now: () => T0 + MINUTE + 1 });
  await later.load();
  assert.equal(later.status().tokens, 0);
  assert.equal(later.get(alive.token), null);
});

test('prune(): 公开方法清理过期项并返回 this', async (t) => {
  const { store, tick } = await withStore(t, { ttlMs: MINUTE });
  const entry = store.arm({ sessionId: 's1' });
  assert.equal(store.status().tokens, 1);
  tick(MINUTE);
  assert.equal(store.prune(), store);
  assert.equal(store.status().tokens, 0);
  assert.equal(store.get(entry.token), null);
});

test('maxTokens: 超出容量时淘汰 createdAt 最早的 token', async (t) => {
  const { store, tick } = await withStore(t, { maxTokens: 2, ttlMs: HOUR });
  const first = store.arm({ sessionId: 's1' });
  tick(1);
  const second = store.arm({ sessionId: 's2' });
  tick(1);
  const third = store.arm({ sessionId: 's3' });
  assert.equal(store.status().tokens, 2);
  assert.equal(store.get(first.token), null);
  assert.ok(store.get(second.token));
  assert.ok(store.get(third.token));
});

test('构造参数兜底：非法 ttlMs 回退 2h，非法 maxTokens 回退 16', async (t) => {
  const { dir } = await withStore(t);
  const store = new TokenStore({
    file: path.join(dir, 'fallback.json'),
    ttlMs: Number.NaN,
    maxTokens: 0,
    now: () => T0,
  });
  const entry = store.arm({ sessionId: 's1' });
  assert.equal(entry.expiresAt - entry.createdAt, 2 * HOUR);
  for (let i = 0; i < 20; i += 1) store.arm({ sessionId: `s-${i}` });
  assert.equal(store.status().tokens, 16);
});

test('flush: 写入失败只 log 不抛错', async (t) => {
  const { dir } = await withStore(t);
  // 把目录本身当作文件路径 → rename temp 到目录会失败
  const store = new TokenStore({ file: dir, ttlMs: HOUR, now: () => T0 });
  const entry = store.arm({ sessionId: 's1' });
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await store.flush(); // 不应抛错
  } finally {
    console.error = original;
  }
  assert.ok(logged.length >= 1);
  assert.ok(store.get(entry.token));
  assert.deepEqual(await stat(dir).then((s) => s.isDirectory()), true);
});

test('flush: 无 file 构造时直接 return', async () => {
  const store = new TokenStore({ ttlMs: HOUR, now: () => T0 });
  await store.load();
  store.arm({ sessionId: 's1' });
  await store.flush();
  assert.equal(store.status().tokens, 1);
});

test('load: 重启后 recent 最多恢复 50 条', async (t) => {
  const { dir } = await withStore(t);
  const file = path.join(dir, 'recent.json');
  await mkdir(dir, { recursive: true });
  // 持久化文件里的 recent 本身就是「最新在前」
  const recent = Array.from({ length: 80 }, (_, i) => ({
    token: 'A'.repeat(24),
    sessionId: 's1',
    title: 't',
    at: T0 + (79 - i),
    filename: `f${79 - i}.jpg`,
    ok: true,
  }));
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      tokens: {
        ['A'.repeat(24)]: {
          token: 'A'.repeat(24),
          sessionId: 's1',
          title: 't',
          createdAt: T0,
          expiresAt: T0 + HOUR,
          uploads: 3,
          lastUploadAt: T0 + 5,
        },
      },
      recent,
    }),
  );
  const store = new TokenStore({ file, ttlMs: HOUR, now: () => T0 });
  await store.load();
  assert.equal(store.recent(100).length, 50);
  assert.equal(store.recent(1)[0].filename, 'f79.jpg');
});
