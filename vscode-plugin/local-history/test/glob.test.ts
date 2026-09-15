import { strict as assert } from 'assert';
import { test } from 'node:test';
import { matchesAny } from '../src/util/glob';

const DEFAULTS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.git/**',
  '**/*.log',
  '**/*.tmp',
];

test('默认排除规则命中常见构建产物', () => {
  assert.equal(matchesAny('node_modules/left-pad/index.js', DEFAULTS), true);
  assert.equal(matchesAny('packages/app/node_modules/x/y.js', DEFAULTS), true);
  assert.equal(matchesAny('dist/main.js', DEFAULTS), true);
  assert.equal(matchesAny('.git/HEAD', DEFAULTS), true);
  assert.equal(matchesAny('logs/app.log', DEFAULTS), true);
  assert.equal(matchesAny('tmp/x.tmp', DEFAULTS), true);
});

test('默认排除规则不会误伤源码', () => {
  assert.equal(matchesAny('src/index.ts', DEFAULTS), false);
  assert.equal(matchesAny('src/distance.ts', DEFAULTS), false);
  assert.equal(matchesAny('README.md', DEFAULTS), false);
  assert.equal(matchesAny('src/node_modules_helper.ts', DEFAULTS), false);
});

test('单星号不跨目录', () => {
  assert.equal(matchesAny('a/b.ts', ['*.ts']), false);
  assert.equal(matchesAny('b.ts', ['*.ts']), true);
  assert.equal(matchesAny('a/b.ts', ['*/*.ts']), true);
});

test('支持花括号与问号', () => {
  assert.equal(matchesAny('src/a.js', ['src/*.{js,ts}']), true);
  assert.equal(matchesAny('src/a.ts', ['src/*.{js,ts}']), true);
  assert.equal(matchesAny('src/a.css', ['src/*.{js,ts}']), false);
  assert.equal(matchesAny('a1.ts', ['a?.ts']), true);
  assert.equal(matchesAny('a12.ts', ['a?.ts']), false);
});

test('目录模式同时命中目录本身', () => {
  assert.equal(matchesAny('dist', ['dist/**']), true);
  assert.equal(matchesAny('dist/a/b.js', ['dist/**']), true);
});

test('空模式被忽略', () => {
  assert.equal(matchesAny('a.ts', ['', 'b.ts']), false);
});
