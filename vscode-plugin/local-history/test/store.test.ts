import { strict as assert } from 'assert';
import { test } from 'node:test';
import { BlobCodec } from '../src/storage/blobCodec';
import { HistoryStore } from '../src/storage/store';
import { MemVfs } from '../src/storage/vfs';
import { AutoTag } from '../src/storage/types';

const ROOT = '/ws/.local-history';

function newStore(vfs = new MemVfs(), codec = new BlobCodec()): HistoryStore {
  return new HistoryStore(vfs, ROOT, codec);
}

const NO_MERGE: { tags: AutoTag[]; mergeWindowMs: number } = { tags: ['saved'], mergeWindowMs: 0 };

test('第一次写入创建版本，内容不变时不创建新版本', async () => {
  const store = newStore();
  const first = await store.addVersion('a.ts', 'hello', { tags: ['created'], mergeWindowMs: 0 });
  assert.ok(first);
  const same = await store.addVersion('a.ts', 'hello', { tags: ['saved'], mergeWindowMs: 0 });
  assert.equal(same, undefined);
  const versions = await store.getVersions('a.ts');
  assert.equal(versions.length, 1);
  assert.deepEqual(versions[0].tags, ['created']);
});

test('版本按时间倒序返回并能读回内容', async () => {
  const store = newStore();
  await store.addVersion('a.ts', 'v1', { ...NO_MERGE, tags: ['saved'] });
  await store.addVersion('a.ts', 'v2', { ...NO_MERGE, tags: ['saved'] });
  const versions = await store.getVersions('a.ts');
  assert.equal(versions.length, 2);
  assert.equal(await store.readContent(versions[0]), 'v2');
  assert.equal(await store.readContent(versions[1]), 'v1');
});

test('合并窗口内的连续修改合并为一个版本', async () => {
  const store = newStore();
  await store.addVersion('a.ts', 'line1\n', { tags: ['saved'], mergeWindowMs: 60000 });
  await store.addVersion('a.ts', 'line1\nline2\n', { tags: ['pause'], mergeWindowMs: 60000 });
  await store.addVersion('a.ts', 'line1\nline2\nline3\n', { tags: ['pause'], mergeWindowMs: 60000 });
  const versions = await store.getVersions('a.ts');
  assert.equal(versions.length, 1);
  assert.equal(await store.readContent(versions[0]), 'line1\nline2\nline3\n');
  // 合并后的统计相对“合并前的上一个版本”重新计算
  assert.equal(versions[0].added, 3);
  assert.deepEqual(versions[0].tags.sort(), ['pause', 'saved']);
});

test('带标签的版本不参与合并', async () => {
  const store = newStore();
  await store.addVersion('a.ts', 'x', { tags: ['manual'], mergeWindowMs: 60000, label: '基线' });
  await store.addVersion('a.ts', 'y', { tags: ['pause'], mergeWindowMs: 60000 });
  const versions = await store.getVersions('a.ts');
  assert.equal(versions.length, 2);
  assert.equal(versions[1].label, '基线');
});

test('增删行统计正确', async () => {
  const store = newStore();
  await store.addVersion('a.ts', 'a\nb\nc\n', NO_MERGE);
  await store.addVersion('a.ts', 'a\nB\nc\nd\n', NO_MERGE);
  const [latest] = await store.getVersions('a.ts');
  assert.equal(latest.added, 2);
  assert.equal(latest.removed, 1);
});

test('内容相同的两个文件共用一个 blob', async () => {
  const vfs = new MemVfs();
  const store = newStore(vfs);
  await store.addVersion('a.ts', 'shared', NO_MERGE);
  await store.addVersion('b.ts', 'shared', NO_MERGE);
  const stats = await store.stats();
  assert.equal(stats.files, 2);
  assert.equal(stats.versions, 2);
  assert.equal(stats.blobs, 1);
});

test('标签可以增删', async () => {
  const store = newStore();
  await store.addVersion('a.ts', 'x', NO_MERGE);
  const [v] = await store.getVersions('a.ts');
  await store.setLabel('a.ts', v.id, '重要');
  assert.equal((await store.getVersion('a.ts', v.id))?.label, '重要');
  await store.setLabel('a.ts', v.id, undefined);
  assert.equal((await store.getVersion('a.ts', v.id))?.label, undefined);
});

test('删除最后一个版本会一并清掉文件条目', async () => {
  const store = newStore();
  await store.addVersion('a.ts', 'x', NO_MERGE);
  const [v] = await store.getVersions('a.ts');
  await store.deleteVersion('a.ts', v.id);
  assert.equal((await store.getVersions('a.ts')).length, 0);
  assert.equal((await store.listIndex()).length, 0);
});

test('删除标记让文件出现在已删除列表里', async () => {
  const store = newStore();
  await store.addVersion('a.ts', 'x', NO_MERGE);
  await store.addVersion('a.ts', 'x', { tags: ['deleted'], mergeWindowMs: 0, forceNew: true });
  const [entry] = await store.listIndex();
  assert.equal(entry.deleted, true);
  assert.equal(entry.lastChange, 'deleted');
  const [latest] = await store.getVersions('a.ts');
  assert.equal(latest.isDeletion, true);
});

test('重命名把时间轴带到新路径', async () => {
  const store = newStore();
  await store.addVersion('old.ts', 'v1', NO_MERGE);
  await store.addVersion('old.ts', 'v2', NO_MERGE);
  await store.renameFile('old.ts', 'new.ts');
  assert.equal((await store.getVersions('old.ts')).length, 0);
  const versions = await store.getVersions('new.ts');
  assert.equal(versions.length, 2);
  assert.ok(versions[0].tags.includes('rename'));
  const index = await store.listIndex();
  assert.equal(index.length, 1);
  assert.equal(index[0].relPath, 'new.ts');
});

test('清理会按策略删版本并回收 blob', async () => {
  const vfs = new MemVfs();
  const store = newStore(vfs);
  for (let i = 0; i < 6; i++) {
    await store.addVersion('a.ts', `content ${i}`, { ...NO_MERGE, forceNew: true });
  }
  assert.equal((await store.stats()).blobs, 6);
  const plan = await store.cleanup({
    maxVersionsPerFile: 2,
    maxAgeDays: 0,
    maxTotalSizeMB: 0,
  });
  assert.equal(plan.remove.length, 4);
  assert.equal((await store.getVersions('a.ts')).length, 2);
  const stats = await store.stats();
  assert.equal(stats.blobs, 2, '孤儿 blob 应该被回收');
});

test('索引损坏时能从 meta 目录重建', async () => {
  const vfs = new MemVfs();
  const store = newStore(vfs);
  await store.addVersion('a.ts', 'x', NO_MERGE);
  await store.addVersion('b.ts', 'y', NO_MERGE);

  await vfs.write(`${ROOT}/index/files.json`, Buffer.from('{ 这不是合法 JSON', 'utf8'));
  const reopened = newStore(vfs);
  await reopened.init();
  const index = await reopened.listIndex();
  assert.deepEqual(index.map((e) => e.relPath).sort(), ['a.ts', 'b.ts']);
});

test('元数据损坏不会让整个面板打不开', async () => {
  const vfs = new MemVfs();
  const store = newStore(vfs);
  await store.addVersion('a.ts', 'x', NO_MERGE);
  const key = store.keyOf('a.ts');
  await vfs.write(`${ROOT}/meta/${key}.json`, Buffer.from('坏掉的内容', 'utf8'));

  const reopened = newStore(vfs);
  assert.deepEqual(await reopened.getVersions('a.ts'), []);
  assert.ok(await vfs.stat(`${ROOT}/meta/${key}.json.corrupt`), '损坏的元数据应被备份');
});

test('内容搜索命中包含关键词的版本', async () => {
  const store = newStore();
  await store.addVersion('a.ts', 'const needle = 1;', { ...NO_MERGE, forceNew: true });
  await store.addVersion('a.ts', 'const other = 2;', { ...NO_MERGE, forceNew: true });
  const hits = await store.searchContent('a.ts', 'NEEDLE', 100);
  assert.equal(hits.size, 1);
  const versions = await store.getVersions('a.ts');
  assert.ok(hits.has(versions[1].id));
});

test('purgeAll 清空整个存储目录', async () => {
  const vfs = new MemVfs();
  const store = newStore(vfs);
  await store.addVersion('a.ts', 'x', NO_MERGE);
  await store.purgeAll();
  assert.equal((await store.listIndex()).length, 0);
  assert.equal(await vfs.stat(ROOT), undefined);
});

test('并发写入不会丢版本', async () => {
  const store = newStore();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.addVersion('a.ts', `content ${i}`, { ...NO_MERGE, forceNew: true }),
    ),
  );
  assert.equal((await store.getVersions('a.ts')).length, 20);
  assert.equal((await store.listIndex())[0].count, 20);
});
