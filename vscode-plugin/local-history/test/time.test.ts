import { strict as assert } from 'assert';
import { test } from 'node:test';
import { bucketOf, formatSize, formatTimestamp, inTimeFilter } from '../src/util/time';

// 2026-09-17 是周四，本周从 9/14（周一）开始
const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
const DAY = 86400000;

test('时间分组按本地自然日划分', () => {
  assert.equal(bucketOf(NOW, NOW), 'today');
  assert.equal(bucketOf(new Date(2026, 8, 17, 0, 0, 1).getTime(), NOW), 'today');
  assert.equal(bucketOf(new Date(2026, 8, 16, 23, 59, 0).getTime(), NOW), 'yesterday');
  // 本周从周一（9/14）算起
  assert.equal(bucketOf(new Date(2026, 8, 14, 10, 0, 0).getTime(), NOW), 'thisWeek');
  assert.equal(bucketOf(new Date(2026, 8, 15, 10, 0, 0).getTime(), NOW), 'thisWeek');
  // 上周日已经不算本周
  assert.equal(bucketOf(new Date(2026, 8, 13, 10, 0, 0).getTime(), NOW), 'thisMonth');
  assert.equal(bucketOf(new Date(2026, 8, 2, 10, 0, 0).getTime(), NOW), 'thisMonth');
  assert.equal(bucketOf(NOW - 90 * DAY, NOW), 'older');
});

test('时间筛选是累进的', () => {
  const yesterday = new Date(2026, 8, 16, 10, 0, 0).getTime();
  assert.equal(inTimeFilter(NOW, 'today', NOW), true);
  assert.equal(inTimeFilter(yesterday, 'today', NOW), false);
  assert.equal(inTimeFilter(yesterday, 'week', NOW), true);
  assert.equal(inTimeFilter(NOW - 90 * DAY, 'month', NOW), false);
  assert.equal(inTimeFilter(NOW - 900 * DAY, '', NOW), true);
});

test('时间戳格式补零到秒', () => {
  assert.equal(formatTimestamp(new Date(2026, 0, 2, 3, 4, 5).getTime()), '2026-01-02 03:04:05');
});

test('体积格式化', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
});
