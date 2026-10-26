// dsh-camera · TLS 证书材料单元测试（task-5）
//
// 覆盖：首生成（文件/权限/解析/SAN/链验证/指纹/meta/mobileconfig）、复用、
// hosts 变化只重签 server、renderCaProfile 输出与转义、CA 损坏重建、
// server.crt 缺失、meta 丢失、openssl 不可用/执行失败等异常路径。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { ensureTlsMaterial, renderCaProfile } from '../lib/tls.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CA_CERT = 'ca.crt';
const CA_KEY = 'ca.key';
const SERVER_CERT = 'server.crt';
const SERVER_KEY = 'server.key';
const META = 'meta.json';
const ALL_FILES = [CA_KEY, CA_CERT, SERVER_KEY, SERVER_CERT, META];

function tlsDir(stateDir) {
  return path.join(stateDir, 'tls');
}

function tlsPath(stateDir, name) {
  return path.join(tlsDir(stateDir), name);
}

function modeOf(file) {
  return fs.statSync(file).mode & 0o777;
}

function withStateDir(fn) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-camera-tls-test-'));
  try {
    return fn(stateDir);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function openssl(args) {
  return execFileSync('openssl', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function x509Pem(stateDir, name) {
  return fs.readFileSync(tlsPath(stateDir, name), 'utf8');
}

function certOf(pem) {
  return new crypto.X509Certificate(pem);
}

function fingerprintOf(caPem) {
  return certOf(caPem).fingerprint256;
}

/** openssl x509 -noout -fingerprint -sha256 的输出，例如 "sha256 Fingerprint=AA:BB:..."。 */
function opensslCaFingerprint(stateDir) {
  const out = openssl([
    'x509',
    '-in',
    tlsPath(stateDir, CA_CERT),
    '-noout',
    '-fingerprint',
    '-sha256',
  ]);
  return out.trim().split('=').pop().trim();
}

function pubkeyOfCert(pem) {
  const tmp = path.join(os.tmpdir(), `dsh-camera-tls-pub-${crypto.randomUUID()}.pem`);
  try {
    fs.writeFileSync(tmp, pem);
    return openssl(['x509', '-in', tmp, '-noout', '-pubkey']).trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function pubkeyOfKey(keyPem) {
  const tmp = path.join(os.tmpdir(), `dsh-camera-tls-pubkey-${crypto.randomUUID()}.pem`);
  try {
    fs.writeFileSync(tmp, keyPem);
    return openssl(['pkey', '-in', tmp, '-pubout']).trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function sanTextOf(stateDir, name = SERVER_CERT) {
  return openssl(['x509', '-in', tlsPath(stateDir, name), '-noout', '-ext', 'subjectAltName']);
}

function verifyChain(stateDir) {
  return openssl([
    'verify',
    '-CAfile',
    tlsPath(stateDir, CA_CERT),
    tlsPath(stateDir, SERVER_CERT),
  ]).trim();
}

function readMeta(stateDir) {
  return JSON.parse(fs.readFileSync(tlsPath(stateDir, META), 'utf8'));
}

function daysUntil(date) {
  return (date.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
}

function pemBase64Body(pem) {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  assert.ok(match, 'caPem 应该包含 PEM certificate block');
  return match[1].replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// 1. 首次生成
// ---------------------------------------------------------------------------

test('ensureTlsMaterial: 首次生成 CA + server 证书，文件/权限/SAN/链验证/指纹均正确', () => {
  withStateDir((stateDir) => {
    const hosts = [{ ip: '192.168.1.50' }, { dns: 'cam.local' }];
    const material = ensureTlsMaterial({ stateDir, hosts });

    // 返回结构
    assert.equal(material.generated, true);
    assert.ok(Buffer.isBuffer(material.key), 'key 必须是 Buffer');
    assert.ok(Buffer.isBuffer(material.cert), 'cert 必须是 Buffer');
    assert.equal(typeof material.caPem, 'string');
    assert.equal(material.caPath, tlsPath(stateDir, CA_CERT));
    assert.match(material.caPem, /-----BEGIN CERTIFICATE-----/);
    assert.deepEqual(material.san, [
      'IP:127.0.0.1',
      'DNS:localhost',
      'IP:192.168.1.50',
      'DNS:cam.local',
    ]);
    assert.equal(typeof material.mobileConfig, 'string');
    assert.match(material.fingerprint, /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    // 文件齐全 + 权限 0600，目录 0700
    assert.equal(modeOf(tlsDir(stateDir)), 0o700);
    for (const name of ALL_FILES) {
      const file = tlsPath(stateDir, name);
      assert.ok(fs.existsSync(file), `${name} 应该存在`);
      assert.ok(fs.statSync(file).size > 0, `${name} 不应为空`);
      assert.equal(modeOf(file), 0o600, `${name} 应该是 0600`);
    }

    // 证书可被 openssl x509 解析
    const subject = openssl([
      'x509',
      '-in',
      tlsPath(stateDir, SERVER_CERT),
      '-noout',
      '-subject',
    ]).trim();
    assert.match(subject, /dsh-camera local server/);
    openssl(['x509', '-in', tlsPath(stateDir, CA_CERT), '-noout', '-subject']);

    // SAN 真的写进了 server.crt
    const sanText = sanTextOf(stateDir);
    assert.match(sanText, /IP Address:127\.0\.0\.1/);
    assert.match(sanText, /DNS:localhost/);
    assert.match(sanText, /IP Address:192\.168\.1\.50/);
    assert.match(sanText, /DNS:cam\.local/);

    // CA + 链验证
    const caText = openssl(['x509', '-in', tlsPath(stateDir, CA_CERT), '-noout', '-text']);
    assert.match(caText, /CA:TRUE/);
    assert.match(caText, /Certificate Sign/);
    assert.match(caText, /CRL Sign/);
    assert.match(caText, /Public-Key: \(2048 bit\)/);
    assert.match(caText, /CN\s*=\s*dsh-camera local CA/);
    assert.equal(verifyChain(stateDir), `${tlsPath(stateDir, SERVER_CERT)}: OK`);

    // server 证书扩展：serverAuth + 不是 CA
    const serverText = openssl([
      'x509',
      '-in',
      tlsPath(stateDir, SERVER_CERT),
      '-noout',
      '-text',
    ]);
    assert.match(serverText, /TLS Web Server Authentication/);
    assert.match(serverText, /CA:FALSE/);
    assert.match(serverText, /Public-Key: \(2048 bit\)/);

    // 私钥与证书配对
    assert.equal(pubkeyOfCert(x509Pem(stateDir, CA_CERT)), pubkeyOfKey(x509Pem(stateDir, CA_KEY)));
    assert.equal(
      pubkeyOfCert(x509Pem(stateDir, SERVER_CERT)),
      pubkeyOfKey(x509Pem(stateDir, SERVER_KEY)),
    );

    // 有效期：CA ≈3650 天，server ≈825 天
    const caDays = daysUntil(certOf(x509Pem(stateDir, CA_CERT)).validToDate);
    const serverDays = daysUntil(certOf(x509Pem(stateDir, SERVER_CERT)).validToDate);
    assert.ok(caDays > 3600 && caDays <= 3651, `CA 有效期异常: ${caDays} 天`);
    assert.ok(serverDays > 800 && serverDays <= 826, `server 有效期异常: ${serverDays} 天`);

    // 指纹与 openssl 输出一致
    assert.equal(material.fingerprint, opensslCaFingerprint(stateDir));
    assert.equal(material.fingerprint, fingerprintOf(material.caPem));

    // key/cert 返回的是文件内容（Buffer）
    assert.ok(material.key.equals(fs.readFileSync(tlsPath(stateDir, SERVER_KEY))));
    assert.ok(material.cert.equals(fs.readFileSync(tlsPath(stateDir, SERVER_CERT))));

    // meta.json 字段
    const meta = readMeta(stateDir);
    assert.deepEqual(meta.hosts, material.san);
    assert.equal(meta.caFingerprint, material.fingerprint);
    assert.match(meta.caUUID, UUID_RE);
    assert.match(meta.profileUUID, UUID_RE);
    assert.notEqual(meta.caUUID, meta.profileUUID);
    assert.equal(typeof meta.generatedAt, 'string');
    assert.ok(Number.isFinite(Date.parse(meta.generatedAt)));
    assert.ok(Math.abs(Date.parse(meta.generatedAt) - Date.now()) < 5 * 60 * 1000);

    // mobileconfig：内嵌 CA base64 + 两个 UUID + 正确 PayloadType
    const b64 = pemBase64Body(material.caPem);
    assert.ok(material.mobileConfig.includes(`<data>${b64}</data>`));
    assert.ok(material.mobileConfig.includes(`<string>${meta.caUUID}</string>`));
    assert.ok(material.mobileConfig.includes(`<string>${meta.profileUUID}</string>`));
    assert.ok(material.mobileConfig.includes('<string>com.apple.security.root</string>'));
  });
});

// ---------------------------------------------------------------------------
// 2. 复用
// ---------------------------------------------------------------------------

test('ensureTlsMaterial: 二次调用复用已有材料（generated=false，指纹/证书/meta UUID 不变）', () => {
  withStateDir((stateDir) => {
    const hosts = [{ ip: '10.10.10.10' }, { dns: 'phone.local' }];
    const first = ensureTlsMaterial({ stateDir, hosts });
    const firstMeta = readMeta(stateDir);
    const certMtime = fs.statSync(tlsPath(stateDir, SERVER_CERT)).mtimeMs;
    const keyMtime = fs.statSync(tlsPath(stateDir, SERVER_KEY)).mtimeMs;

    const second = ensureTlsMaterial({ stateDir, hosts });

    assert.equal(second.generated, false);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(second.caPem, first.caPem);
    assert.deepEqual(second.cert, first.cert);
    assert.deepEqual(second.key, first.key);
    assert.deepEqual(second.san, first.san);
    assert.equal(second.mobileConfig, first.mobileConfig);

    // 复用不应该动证书文件
    assert.equal(fs.statSync(tlsPath(stateDir, SERVER_CERT)).mtimeMs, certMtime);
    assert.equal(fs.statSync(tlsPath(stateDir, SERVER_KEY)).mtimeMs, keyMtime);

    // meta UUID 持久化复用
    const secondMeta = readMeta(stateDir);
    assert.equal(secondMeta.caUUID, firstMeta.caUUID);
    assert.equal(secondMeta.profileUUID, firstMeta.profileUUID);
    assert.equal(secondMeta.caFingerprint, first.fingerprint);
    assert.equal(secondMeta.generatedAt, firstMeta.generatedAt);

    // 重复 host 归一化后仍算同一 SAN（固定项不重复，FQDN 末尾点被去掉）
    const third = ensureTlsMaterial({
      stateDir,
      hosts: [
        { ip: '10.10.10.10' },
        { dns: 'phone.local.' },
        { ip: '127.0.0.1' },
        { dns: 'localhost' },
      ],
    });
    assert.equal(third.generated, false);
    assert.deepEqual(third.san, first.san);
  });
});

// ---------------------------------------------------------------------------
// 3. hosts 变化 → 只重签 server 证书
// ---------------------------------------------------------------------------

test('ensureTlsMaterial: hosts 变化时只重签 server 证书，CA 与 server.key 不变', () => {
  withStateDir((stateDir) => {
    const first = ensureTlsMaterial({ stateDir, hosts: [{ ip: '10.0.0.5' }] });
    const firstMeta = readMeta(stateDir);
    const caPemBefore = x509Pem(stateDir, CA_CERT);
    const caKeyBefore = x509Pem(stateDir, CA_KEY);
    const serverKeyBefore = x509Pem(stateDir, SERVER_KEY);
    const serverCertBefore = x509Pem(stateDir, SERVER_CERT);

    const second = ensureTlsMaterial({
      stateDir,
      hosts: [{ ip: '10.0.0.6' }, { dns: 'new.local' }],
    });

    assert.equal(second.generated, true);
    assert.deepEqual(second.san, [
      'IP:127.0.0.1',
      'DNS:localhost',
      'IP:10.0.0.6',
      'DNS:new.local',
    ]);

    // CA 完全不变（PEM / 指纹 / 私钥）
    assert.equal(second.caPem, first.caPem);
    assert.equal(x509Pem(stateDir, CA_CERT), caPemBefore);
    assert.equal(x509Pem(stateDir, CA_KEY), caKeyBefore);
    assert.equal(second.fingerprint, first.fingerprint);

    // server.key 复用，server.crt 重签
    assert.equal(x509Pem(stateDir, SERVER_KEY), serverKeyBefore);
    assert.notEqual(x509Pem(stateDir, SERVER_CERT), serverCertBefore);
    assert.ok(!second.cert.equals(first.cert));

    // 新 SAN 生效，旧 IP 不再出现
    const sanText = sanTextOf(stateDir);
    assert.match(sanText, /IP Address:10\.0\.0\.6/);
    assert.match(sanText, /DNS:new\.local/);
    assert.doesNotMatch(sanText, /10\.0\.0\.5/);

    // 新证书仍可被同一 CA 验证
    assert.equal(verifyChain(stateDir), `${tlsPath(stateDir, SERVER_CERT)}: OK`);
    assert.equal(
      pubkeyOfCert(x509Pem(stateDir, SERVER_CERT)),
      pubkeyOfKey(x509Pem(stateDir, SERVER_KEY)),
    );

    // UUID 不变，hosts 更新
    const secondMeta = readMeta(stateDir);
    assert.equal(secondMeta.caUUID, firstMeta.caUUID);
    assert.equal(secondMeta.profileUUID, firstMeta.profileUUID);
    assert.deepEqual(secondMeta.hosts, second.san);
    assert.equal(secondMeta.generatedAt === firstMeta.generatedAt, false);
  });
});

// ---------------------------------------------------------------------------
// 4. hosts 为空 / 非法条目
// ---------------------------------------------------------------------------

test('ensureTlsMaterial: hosts 为空时 SAN 只含固定项，非法条目被忽略', () => {
  withStateDir((stateDir) => {
    const empty = ensureTlsMaterial({ stateDir, hosts: [] });
    assert.deepEqual(empty.san, ['IP:127.0.0.1', 'DNS:localhost']);
    assert.match(sanTextOf(stateDir), /IP Address:127\.0\.0\.1/);
    assert.match(sanTextOf(stateDir), /DNS:localhost/);

    const mixed = ensureTlsMaterial({
      stateDir,
      hosts: ['10.1.2.3', { ip: 'not-an-ip' }, { dns: 'bad host' }, { ip: '::1' }, null, 42],
    });
    assert.equal(mixed.generated, true);
    assert.deepEqual(mixed.san, ['IP:127.0.0.1', 'DNS:localhost', 'IP:10.1.2.3', 'IP:::1']);

    const noHosts = ensureTlsMaterial({ stateDir, hosts: [] });
    assert.equal(noHosts.generated, true); // hosts 从混合集合变回空集合 → 重签
    assert.deepEqual(noHosts.san, ['IP:127.0.0.1', 'DNS:localhost']);
    assert.equal(verifyChain(stateDir), `${tlsPath(stateDir, SERVER_CERT)}: OK`);
  });
});

// ---------------------------------------------------------------------------
// 5. renderCaProfile
// ---------------------------------------------------------------------------

test('renderCaProfile: 输出合法 iOS .mobileconfig（CA base64 / 两个 UUID / PayloadType / 转义）', () => {
  withStateDir((stateDir) => {
    const material = ensureTlsMaterial({ stateDir, hosts: [] });
    const caUUID = crypto.randomUUID();
    const profileUUID = crypto.randomUUID();
    const profile = renderCaProfile({
      caPem: material.caPem,
      caUUID,
      profileUUID,
      displayName: 'dsh-camera test CA',
    });

    assert.match(profile, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(profile, /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN"/);
    assert.match(profile, /<plist version="1\.0">/);
    assert.match(profile, /<\/plist>\s*$/);

    // Root CA payload
    assert.ok(profile.includes('<key>PayloadType</key>'));
    assert.ok(profile.includes('<string>com.apple.security.root</string>'));
    assert.ok(profile.includes('<string>Configuration</string>'));
    assert.ok(profile.includes(`<string>${caUUID}</string>`));
    assert.ok(profile.includes(`<string>${profileUUID}</string>`));
    assert.ok(profile.includes('<string>local.dsh-camera.ca</string>'));
    assert.ok(profile.includes('<string>local.dsh-camera.profile</string>'));
    assert.ok(profile.includes('dsh-camera test CA'));
    assert.ok(profile.includes('<string>dsh-camera-ca.crt</string>'));

    // CA 证书是 DER 的 base64（即 PEM body）
    const b64 = pemBase64Body(material.caPem);
    assert.ok(profile.includes(`<data>${b64}</data>`));
    const embedded = /<data>([A-Za-z0-9+/=]+)<\/data>/.exec(profile);
    assert.ok(embedded);
    const der = Buffer.from(embedded[1], 'base64');
    assert.ok(der.length > 0);
    assert.equal(der.toString('base64'), embedded[1]);
    assert.equal(certOf(material.caPem).raw.equals(der), true);

    // XML 转义
    const escaped = renderCaProfile({
      caPem: material.caPem,
      caUUID,
      profileUUID,
      displayName: 'A&B <C> "D"',
    });
    assert.ok(escaped.includes('A&amp;B &lt;C&gt; &quot;D&quot;'));
    assert.ok(!escaped.includes('A&B <C>'));

    // displayName 省略时用默认名
    const defaulted = renderCaProfile({ caPem: material.caPem, caUUID, profileUUID });
    assert.ok(defaulted.includes('dsh-camera local CA'));

    // 非法 caPem → Error
    assert.throws(() => renderCaProfile({ caPem: '', caUUID, profileUUID }), /caPem/);
    assert.throws(() => renderCaProfile({ caPem: 'not a certificate', caUUID, profileUUID }), /PEM/);
    assert.throws(
      () =>
        renderCaProfile({
          caPem: '-----BEGIN CERTIFICATE-----\n@@@@\n-----END CERTIFICATE-----',
          caUUID,
          profileUUID,
        }),
      /base64/,
    );

    // 结构平衡（粗校验 plist XML 没有漏闭合）
    for (const tag of ['dict', 'array', 'plist']) {
      const open = (profile.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
      const close = (profile.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      assert.equal(open, close, `<${tag}> 标签应成对`);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. 异常路径：openssl 不可用 / 执行失败
// ---------------------------------------------------------------------------

test('ensureTlsMaterial: openssl 不可用（PATH 为空）时抛出含 openssl 的 Error', () => {
  withStateDir((stateDir) => {
    const originalPath = process.env.PATH;
    const originalOverride = process.env.DSH_CAMERA_OPENSSL;
    try {
      delete process.env.DSH_CAMERA_OPENSSL;
      process.env.PATH = '';
      assert.throws(
        () => ensureTlsMaterial({ stateDir, hosts: [{ ip: '10.9.9.9' }] }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /openssl/i);
          return true;
        },
      );
    } finally {
      process.env.PATH = originalPath;
      if (originalOverride === undefined) delete process.env.DSH_CAMERA_OPENSSL;
      else process.env.DSH_CAMERA_OPENSSL = originalOverride;
    }
  });
});

test('ensureTlsMaterial: openssl 以非零码退出时 Error 里带 stderr 摘要', () => {
  withStateDir((stateDir) => {
    const originalOverride = process.env.DSH_CAMERA_OPENSSL;
    try {
      // 用 node 自己冒充 openssl：它会拒绝 genpkey 参数并以非零码退出，产生 stderr。
      process.env.DSH_CAMERA_OPENSSL = process.execPath;
      assert.throws(
        () => ensureTlsMaterial({ stateDir, hosts: [{ ip: '10.9.9.9' }] }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /openssl genpkey failed/);
          assert.ok(err.message.length > 'openssl genpkey failed: '.length);
          return true;
        },
      );
    } finally {
      if (originalOverride === undefined) delete process.env.DSH_CAMERA_OPENSSL;
      else process.env.DSH_CAMERA_OPENSSL = originalOverride;
    }
  });
});

test('ensureTlsMaterial: 非法 stateDir 抛 TypeError', () => {
  assert.throws(() => ensureTlsMaterial({}), /stateDir/);
  assert.throws(() => ensureTlsMaterial({ stateDir: '   ' }), /stateDir/);
  assert.throws(() => ensureTlsMaterial({ stateDir: 42 }), /stateDir/);
});

// ---------------------------------------------------------------------------
// 7. 自愈：CA 损坏 / server.crt 缺失 / meta 丢失
// ---------------------------------------------------------------------------

test('ensureTlsMaterial: CA 文件损坏时重建 CA 并重签 server 证书', () => {
  withStateDir((stateDir) => {
    const first = ensureTlsMaterial({ stateDir, hosts: [{ ip: '10.2.2.2' }] });
    const oldCaPem = first.caPem;
    const metaBefore = readMeta(stateDir);

    // 用垃圾内容覆盖 ca.crt 模拟损坏
    fs.writeFileSync(tlsPath(stateDir, CA_CERT), 'garbage not a certificate\n');

    const second = ensureTlsMaterial({ stateDir, hosts: [{ ip: '10.2.2.2' }] });
    assert.equal(second.generated, true);
    assert.notEqual(second.fingerprint, first.fingerprint);
    assert.notEqual(second.caPem, oldCaPem);
    assert.equal(second.fingerprint, opensslCaFingerprint(stateDir));
    assert.equal(verifyChain(stateDir), `${tlsPath(stateDir, SERVER_CERT)}: OK`);
    assert.equal(
      pubkeyOfCert(x509Pem(stateDir, CA_CERT)),
      pubkeyOfKey(x509Pem(stateDir, CA_KEY)),
    );
    // UUID 持久化在 meta 里，CA 重建后仍复用（同一个 mobileconfig 身份）
    const metaAfter = readMeta(stateDir);
    assert.match(metaAfter.caUUID, UUID_RE);
    assert.equal(metaAfter.caUUID, metaBefore.caUUID);
    assert.equal(metaAfter.profileUUID, metaBefore.profileUUID);
    assert.equal(metaAfter.caFingerprint, second.fingerprint);
  });
});

test('ensureTlsMaterial: server.crt 缺失时重签，CA 不变', () => {
  withStateDir((stateDir) => {
    const first = ensureTlsMaterial({ stateDir, hosts: [{ ip: '10.3.3.3' }] });
    const metaBefore = readMeta(stateDir);
    const caPemBefore = x509Pem(stateDir, CA_CERT);
    const serverKeyBefore = x509Pem(stateDir, SERVER_KEY);

    fs.rmSync(tlsPath(stateDir, SERVER_CERT));

    const second = ensureTlsMaterial({ stateDir, hosts: [{ ip: '10.3.3.3' }] });
    assert.equal(second.generated, true);
    assert.equal(second.caPem, caPemBefore); // CA 复用
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(x509Pem(stateDir, SERVER_KEY), serverKeyBefore);
    assert.equal(verifyChain(stateDir), `${tlsPath(stateDir, SERVER_CERT)}: OK`);

    const metaAfter = readMeta(stateDir);
    assert.equal(metaAfter.caUUID, metaBefore.caUUID);
    assert.equal(metaAfter.profileUUID, metaBefore.profileUUID);
    assert.equal(second.mobileConfig, renderCaProfile({
      caPem: second.caPem,
      caUUID: metaAfter.caUUID,
      profileUUID: metaAfter.profileUUID,
      displayName: 'dsh-camera local CA',
    }));
  });
});

test('ensureTlsMaterial: meta.json 丢失时重签 server 证书但复用 CA', () => {
  withStateDir((stateDir) => {
    const first = ensureTlsMaterial({ stateDir, hosts: [{ ip: '10.4.4.4' }] });
    const caPemBefore = x509Pem(stateDir, CA_CERT);
    const serverCertBefore = x509Pem(stateDir, SERVER_CERT);

    fs.rmSync(tlsPath(stateDir, META));

    const second = ensureTlsMaterial({ stateDir, hosts: [{ ip: '10.4.4.4' }] });
    assert.equal(second.generated, true);
    assert.equal(second.caPem, caPemBefore);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.notEqual(x509Pem(stateDir, SERVER_CERT), serverCertBefore);
    assert.equal(verifyChain(stateDir), `${tlsPath(stateDir, SERVER_CERT)}: OK`);

    // meta 被重建
    const metaAfter = readMeta(stateDir);
    assert.deepEqual(metaAfter.hosts, second.san);
    assert.equal(metaAfter.caFingerprint, second.fingerprint);
    assert.match(metaAfter.caUUID, UUID_RE);
    assert.match(metaAfter.profileUUID, UUID_RE);
  });
});
