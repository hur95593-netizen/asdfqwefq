import { strict as assert } from 'assert';
import { test } from 'node:test';
import { applyHunks, diffLines, diffStat, mapRange, splitLines, toHunks } from '../src/util/diff';

test('splitLines 不为末尾换行产生多余空行', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('\n'), ['']);
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
});

test('相同内容没有编辑操作', () => {
  const a = ['x', 'y', 'z'];
  assert.deepEqual(diffStat(a, a), { added: 0, removed: 0 });
  assert.equal(toHunks(a, a).length, 0);
});

test('纯新增与纯删除', () => {
  assert.deepEqual(diffStat(['a'], ['a', 'b']), { added: 1, removed: 0 });
  assert.deepEqual(diffStat(['a', 'b'], ['a']), { added: 0, removed: 1 });
  assert.deepEqual(diffStat([], ['a', 'b']), { added: 2, removed: 0 });
  assert.deepEqual(diffStat(['a', 'b'], []), { added: 0, removed: 2 });
});

test('编辑脚本能还原出新文本', () => {
  const a = ['one', 'two', 'three', 'four'];
  const b = ['one', 'TWO', 'three', 'four', 'five'];
  const edits = diffLines(a, b);
  const rebuilt: string[] = [];
  for (const e of edits) {
    if (e.type === 'equal') {
      rebuilt.push(b[e.b]);
    } else if (e.type === 'insert') {
      rebuilt.push(b[e.b]);
    }
  }
  assert.deepEqual(rebuilt, b);
});

test('toHunks 定位到正确的行区间', () => {
  const a = ['a', 'OLD', 'c'];
  const b = ['a', 'NEW1', 'NEW2', 'c'];
  const hunks = toHunks(a, b);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].aStart, 1);
  assert.deepEqual(hunks[0].aLines, ['OLD']);
  assert.equal(hunks[0].bStart, 1);
  assert.deepEqual(hunks[0].bLines, ['NEW1', 'NEW2']);
});

test('applyHunks 只恢复被选中的变更块', () => {
  const historic = ['h1', 'same', 'h2'];
  const current = ['c1', 'same', 'c2'];
  const hunks = toHunks(historic, current);
  assert.equal(hunks.length, 2);
  assert.deepEqual(applyHunks(current, [hunks[0]]), ['h1', 'same', 'c2']);
  assert.deepEqual(applyHunks(current, [hunks[1]]), ['c1', 'same', 'h2']);
  assert.deepEqual(applyHunks(current, hunks), historic);
  assert.deepEqual(applyHunks(current, []), current);
});

test('applyHunks 能处理纯删除块（历史里没有对应行）', () => {
  const historic = ['keep'];
  const current = ['keep', 'extra'];
  const hunks = toHunks(historic, current);
  assert.deepEqual(applyHunks(current, hunks), historic);
});

test('mapRange 把历史行区间映射到当前文本', () => {
  const historic = ['a', 'b', 'c', 'd'];
  const current = ['a', 'X', 'c', 'd'];
  const { bFrom, bTo } = mapRange(historic, current, 1, 1);
  assert.deepEqual(current.slice(0, bFrom).concat(['b'], current.slice(bTo)), historic);
});

test('mapRange 对未改动区间返回同样的位置', () => {
  const lines = ['a', 'b', 'c'];
  assert.deepEqual(mapRange(lines, lines, 1, 2), { bFrom: 1, bTo: 3 });
});

test('差异超过上限时退化为整体替换，不会抛错', () => {
  const a = Array.from({ length: 200 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 200 }, (_, i) => `b${i}`);
  const stat = diffStat(a, b);
  const limited = diffLines(a, b, 2);
  assert.equal(stat.added, 200);
  assert.equal(stat.removed, 200);
  assert.equal(limited.filter((e) => e.type === 'insert').length, 200);
  assert.equal(limited.filter((e) => e.type === 'delete').length, 200);
});
