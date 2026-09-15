/** 极简 glob → RegExp，支持 `**`、`*`、`?`、`{a,b}`、`[abc]`，用于排除规则。 */

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) {
    return cached;
  }
  let out = '';
  let i = 0;
  const braces: number[] = [];
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      const isGlobStar = pattern[i + 1] === '*';
      if (isGlobStar) {
        const nextIsSlash = pattern[i + 2] === '/';
        if (nextIsSlash) {
          // `**/` 允许匹配零级目录
          out += '(?:[^/]*\\/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (c === '{') {
      braces.push(1);
      out += '(?:';
      i++;
      continue;
    }
    if (c === '}' && braces.length > 0) {
      braces.pop();
      out += ')';
      i++;
      continue;
    }
    if (c === ',' && braces.length > 0) {
      out += '|';
      i++;
      continue;
    }
    if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end > i + 1) {
        const body = pattern.slice(i + 1, end);
        out += '[' + (body.startsWith('!') ? '^' + body.slice(1) : body) + ']';
        i = end + 1;
        continue;
      }
    }
    out += c.replace(/[.+^$()|\\\/]/g, '\\$&');
    i++;
  }
  const re = new RegExp('^' + out + '$');
  cache.set(pattern, re);
  return re;
}

/** relPath 使用 `/` 分隔且不以 `/` 开头。 */
export function matchesAny(relPath: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (!p) {
      continue;
    }
    if (globToRegExp(p).test(relPath)) {
      return true;
    }
    // 目录模式（`dist/**`）也应命中目录本身
    if (p.endsWith('/**') && globToRegExp(p.slice(0, -3)).test(relPath)) {
      return true;
    }
  }
  return false;
}
