import { strict as assert } from 'assert';
import { test } from 'node:test';
import { PlanFile, planCleanup } from '../src/storage/cleanup';

const DAY = 86400000;
const NOW = new Date('2026-09-15T12:00:00').getTime();

function file(key: string, versions: Array<[string, number, string, string?]>): PlanFile {
  return {
    key,
    versions: versions.map(([id, ts, blob, label]) => ({ id, ts, blob, label })),
  };
}

test('超过保留天数的版本被清理，最新版本保留', () => {
  const files = [
    file('f1', [
      ['v1', NOW - 40 * DAY, 'b1'],
      ['v2', NOW - 35 * DAY, 'b2'],
      ['v3', NOW - DAY, 'b3'],
    ]),
  ];
  const plan = planCleanup({
    files,
    blobSizes: { b1: 100, b2: 100, b3: 100 },
    policy: { maxVersionsPerFile: 100, maxAgeDays: 30, maxTotalSizeMB: 0 },
    now: NOW,
  });
  assert.deepEqual(
    plan.remove.map((r) => r.id).sort(),
    ['v1', 'v2'],
  );
  assert.deepEqual(plan.orphanBlobs.sort(), ['b1', 'b2']);
  assert.equal(plan.freedBytes, 200);
});

test('带标签的版本不会被自动清理', () => {
  const files = [
    file('f1', [
      ['v1', NOW - 90 * DAY, 'b1', '上线前'],
      ['v2', NOW - 80 * DAY, 'b2'],
      ['v3', NOW, 'b3'],
    ]),
  ];
  const plan = planCleanup({
    files,
    blobSizes: { b1: 10, b2: 10, b3: 10 },
    policy: { maxVersionsPerFile: 100, maxAgeDays: 30, maxTotalSizeMB: 0 },
    now: NOW,
  });
  assert.deepEqual(
    plan.remove.map((r) => r.id),
    ['v2'],
  );
});

test('单文件版本数上限淘汰最旧的', () => {
  const versions: Array<[string, number, string]> = [];
  for (let i = 0; i < 10; i++) {
    versions.push([`v${i}`, NOW - (10 - i) * 1000, `b${i}`]);
  }
  const plan = planCleanup({
    files: [file('f1', versions)],
    blobSizes: {},
    policy: { maxVersionsPerFile: 4, maxAgeDays: 0, maxTotalSizeMB: 0 },
    now: NOW,
  });
  assert.deepEqual(
    plan.remove.map((r) => r.id),
    ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'],
  );
});

test('总大小超限时跨文件按时间淘汰', () => {
  const files = [
    file('f1', [
      ['a1', NOW - 5000, 'ba1'],
      ['a2', NOW - 1000, 'ba2'],
    ]),
    file('f2', [
      ['c1', NOW - 4000, 'bc1'],
      ['c2', NOW - 500, 'bc2'],
    ]),
  ];
  const oneMb = 1024 * 1024;
  const plan = planCleanup({
    files,
    blobSizes: { ba1: oneMb, ba2: oneMb, bc1: oneMb, bc2: oneMb },
    policy: { maxVersionsPerFile: 100, maxAgeDays: 0, maxTotalSizeMB: 3 },
    now: NOW,
  });
  // 只需要腾出 1MB，最旧的 a1 被淘汰
  assert.deepEqual(
    plan.remove.map((r) => r.id),
    ['a1'],
  );
  assert.equal(plan.freedBytes, oneMb);
});

test('共享同一个 blob 时引用计数不归零就不算释放', () => {
  const files = [
    file('f1', [
      ['v1', NOW - 40 * DAY, 'shared'],
      ['v2', NOW - 39 * DAY, 'shared'],
      ['v3', NOW, 'newest'],
    ]),
  ];
  const plan = planCleanup({
    files,
    blobSizes: { shared: 500, newest: 100 },
    policy: { maxVersionsPerFile: 100, maxAgeDays: 30, maxTotalSizeMB: 0 },
    now: NOW,
  });
  assert.equal(plan.remove.length, 2);
  assert.deepEqual(plan.orphanBlobs, ['shared']);
  assert.equal(plan.freedBytes, 500);
});

test('策略全部关闭时什么都不删', () => {
  const plan = planCleanup({
    files: [file('f1', [['v1', 0, 'b1']])],
    blobSizes: { b1: 1 },
    policy: { maxVersionsPerFile: 0, maxAgeDays: 0, maxTotalSizeMB: 0 },
    now: NOW,
  });
  assert.equal(plan.remove.length, 0);
});
