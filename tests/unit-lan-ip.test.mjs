// dsh-camera · LanIp 单元测试（DESIGN 3.2）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectDefaultRouteIp, lanCandidates, pickLanIp } from '../lib/lan-ip.js';

/** @param {string} address */
function ipEntry(address, extra = {}) {
  return { address, family: 'IPv4', internal: false, ...extra };
}

test('lanCandidates: 过滤 internal/IPv6/公网/link-local，并按 192.168 > 10 > 172 排序', () => {
  const interfaces = {
    docker0: [ipEntry('172.17.0.1')],
    eth0: [ipEntry('10.10.10.10')],
    wlan0: [ipEntry('192.168.1.23')],
    lo: [ipEntry('127.0.0.1', { internal: true })],
    utun0: [
      ipEntry('fe80::1', { family: 'IPv6' }),
      ipEntry('::1', { family: 'IPv6', internal: true }),
    ],
    public0: [ipEntry('8.8.8.8')],
    link0: [ipEntry('169.254.10.2')],
    cgnat0: [ipEntry('100.64.0.1')],
    edge0: [ipEntry('172.32.0.1')],
  };
  const candidates = lanCandidates(() => interfaces);
  assert.deepEqual(
    candidates.map((item) => item.address),
    ['192.168.1.23', '10.10.10.10', '172.17.0.1'],
  );
  assert.deepEqual(
    candidates.map((item) => item.score),
    [0, 1, 2],
  );
  assert.deepEqual(
    candidates.map((item) => item.iface),
    ['wlan0', 'eth0', 'docker0'],
  );
});

test('lanCandidates: 同分时按地址数值排序，地址相同按网卡名排序', () => {
  const interfaces = {
    eth1: [ipEntry('10.0.0.10')],
    eth0: [ipEntry('10.0.0.2')],
    eth2: [ipEntry('10.0.0.2')],
  };
  const candidates = lanCandidates(() => interfaces);
  assert.deepEqual(
    candidates.map((item) => `${item.address}@${item.iface}`),
    ['10.0.0.2@eth0', '10.0.0.10@eth1'],
  );
});

test('lanCandidates: 接受 family=4（数字）并 trim 地址', () => {
  const candidates = lanCandidates(() => ({
    eth0: [{ address: ' 192.168.0.5 ', family: 4, internal: false }],
  }));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].address, '192.168.0.5');
});

test('lanCandidates: 排除非法地址/前导零/越界 octet', () => {
  const candidates = lanCandidates(() => ({
    bad: [
      ipEntry('10.0.0'),
      ipEntry('10.0.0.256'),
      ipEntry('010.0.0.1'),
      ipEntry('192.169.1.1'),
      ipEntry('11.0.0.1'),
      ipEntry('172.15.0.1'),
      ipEntry('172.32.0.1'),
    ],
  }));
  assert.deepEqual(candidates, []);
});

test('lanCandidates: 包含 172.16/12 边界与 10/8、192.168/16', () => {
  const candidates = lanCandidates(() => ({
    a: [ipEntry('172.16.0.1'), ipEntry('172.31.255.254')],
    b: [ipEntry('10.255.255.255'), ipEntry('192.168.255.255')],
  }));
  assert.deepEqual(
    candidates.map((item) => item.address),
    ['192.168.255.255', '10.255.255.255', '172.16.0.1', '172.31.255.254'],
  );
});

test('lanCandidates: 容忍 interfacesFn 抛错 / 返回异常值', () => {
  assert.deepEqual(
    lanCandidates(() => {
      throw new Error('boom');
    }),
    [],
  );
  assert.deepEqual(lanCandidates(() => null), []);
  assert.deepEqual(lanCandidates(() => 'nope'), []);
  assert.deepEqual(lanCandidates(() => ({ eth0: null, eth1: [], eth2: [null, 42] })), []);
});

test('lanCandidates: 默认使用 os.networkInterfaces，返回结构合法', () => {
  const candidates = lanCandidates();
  assert.ok(Array.isArray(candidates));
  for (const candidate of candidates) {
    assert.equal(typeof candidate.address, 'string');
    assert.equal(typeof candidate.iface, 'string');
    assert.ok([0, 1, 2].includes(candidate.score));
  }
});

test('pickLanIp: 合法 override 直接返回且不探测网卡', () => {
  let called = 0;
  const result = pickLanIp('192.168.8.8', () => {
    called += 1;
    return {};
  });
  assert.equal(result, '192.168.8.8');
  assert.equal(called, 0);
});

test('pickLanIp: override 前后空白会 trim', () => {
  assert.equal(pickLanIp(' 10.1.2.3 ', () => ({})), '10.1.2.3');
});

test('pickLanIp: 非法 override 回退到自动探测', () => {
  const interfaces = () => ({ eth0: [ipEntry('192.168.3.4')] });
  assert.equal(pickLanIp('not-an-ip', interfaces), '192.168.3.4');
  assert.equal(pickLanIp('999.1.1.1', interfaces), '192.168.3.4');
  assert.equal(pickLanIp('', interfaces), '192.168.3.4');
  assert.equal(pickLanIp(undefined, interfaces), '192.168.3.4');
});

test('pickLanIp: 没有候选时返回 null', () => {
  assert.equal(pickLanIp('', () => ({})), null);
  assert.equal(pickLanIp('bad', () => ({ lo: [ipEntry('127.0.0.1', { internal: true })] })), null);
});

test('pickLanIp: 默认探测不抛错', () => {
  const value = pickLanIp('');
  assert.ok(value === null || /^\d{1,3}(\.\d{1,3}){3}$/.test(value));
});

test('lanCandidates: 默认路由所在网段优先于私网段偏好', () => {
  const interfaces = {
    wlo1: [ipEntry('10.0.0.20')],
    usb0: [ipEntry('192.168.77.1')],
  };
  const candidates = lanCandidates(() => interfaces, () => '10.0.0.20');
  assert.deepEqual(
    candidates.map((item) => item.address),
    ['10.0.0.20', '192.168.77.1'],
  );
  assert.equal(candidates[0].defaultRoute, true);
});

test('lanCandidates: /30 窄网段（USB 共享/点对点）降权，手机通常不可达', () => {
  const interfaces = {
    wlo1: [ipEntry('10.10.10.10', { netmask: '255.255.255.0' })],
    usb0: [ipEntry('192.168.77.1', { netmask: '255.255.255.252' })],
  };
  const candidates = lanCandidates(() => interfaces);
  assert.equal(candidates[0].address, '10.10.10.10');
  assert.equal(candidates[0].narrow, false);
  assert.equal(candidates[1].narrow, true);
});

test('pickLanIp: 传入 defaultRouteFn 时选中默认路由网段', () => {
  const interfaces = () => ({
    wlo1: [ipEntry('10.10.10.10')],
    usb0: [ipEntry('192.168.77.1')],
  });
  assert.equal(pickLanIp('', interfaces, () => '10.10.10.10'), '10.10.10.10');
  assert.equal(pickLanIp('', interfaces, () => null), '192.168.77.1');
});

test('detectDefaultRouteIp: 返回 null 或合法 IPv4（不抛错）', () => {
  const value = detectDefaultRouteIp();
  assert.ok(value === null || /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|[0-9])(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|[0-9])){3}$/.test(value));
});
