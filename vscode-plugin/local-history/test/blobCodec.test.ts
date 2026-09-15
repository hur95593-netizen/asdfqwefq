import { strict as assert } from 'assert';
import { test } from 'node:test';
import { BlobCodec, sha1, sha256 } from '../src/storage/blobCodec';

test('明文模式：压缩后能原样解回', async () => {
  const codec = new BlobCodec();
  const text = 'const a = 1;\n'.repeat(500);
  const encoded = await codec.encode(text);
  assert.ok(encoded.byteLength < Buffer.byteLength(text, 'utf8'), '应该被压缩');
  assert.equal(await codec.decode(encoded), text);
});

test('空内容与多字节字符往返正确', async () => {
  const codec = new BlobCodec();
  for (const text of ['', '你好，世界\n', '🎯 emoji 与\ttab']) {
    assert.equal(await codec.decode(await codec.encode(text)), text);
  }
});

test('加密模式：口令正确才能解开', async () => {
  const codec = new BlobCodec('correct horse');
  const encoded = await codec.encode('secret content');
  assert.equal(await codec.decode(encoded), 'secret content');

  const wrong = new BlobCodec('wrong horse');
  await assert.rejects(() => wrong.decode(encoded));

  const none = new BlobCodec();
  await assert.rejects(() => none.decode(encoded), /已加密/);
});

test('没有头部的旧数据按纯文本读取', async () => {
  const codec = new BlobCodec();
  assert.equal(await codec.decode(Buffer.from('plain text', 'utf8')), 'plain text');
});

test('hash 稳定且区分内容', () => {
  assert.equal(sha256('a'), sha256('a'));
  assert.notEqual(sha256('a'), sha256('b'));
  assert.equal(sha1('src/index.ts').length, 40);
});
