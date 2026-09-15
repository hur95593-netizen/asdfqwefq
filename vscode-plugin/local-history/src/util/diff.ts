/**
 * 行级 diff（Myers 最短编辑脚本），不依赖任何第三方库。
 * 超大差异时退化为“整体替换”，保证在大文件上不会卡住扩展主线程。
 */

export type EditType = 'equal' | 'insert' | 'delete';

export interface Edit {
  type: EditType;
  /** 在旧文本中的行号（0 基），insert 时为 -1 */
  a: number;
  /** 在新文本中的行号（0 基），delete 时为 -1 */
  b: number;
}

export interface Hunk {
  /** 旧文本中被替换区间的起始行（0 基） */
  aStart: number;
  /** 旧文本中被替换的行数 */
  aCount: number;
  /** 新文本中对应区间的起始行（0 基） */
  bStart: number;
  /** 新文本中对应区间的行数 */
  bCount: number;
  aLines: string[];
  bLines: string[];
}

export interface DiffStat {
  added: number;
  removed: number;
}

const DEFAULT_MAX_D = 3000;

/** 把文本按行切分，保留空行语义（末尾换行不产生额外空行）。 */
export function splitLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** 计算两组行之间的编辑脚本。 */
export function diffLines(a: string[], b: string[], maxD = DEFAULT_MAX_D): Edit[] {
  const prefix = commonPrefix(a, b);
  const suffix = commonSuffix(a, b, prefix);
  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);

  const edits: Edit[] = [];
  for (let i = 0; i < prefix; i++) {
    edits.push({ type: 'equal', a: i, b: i });
  }

  const mid = myers(aMid, bMid, maxD) ?? replaceAll(aMid, bMid);
  for (const e of mid) {
    edits.push({
      type: e.type,
      a: e.a < 0 ? -1 : e.a + prefix,
      b: e.b < 0 ? -1 : e.b + prefix,
    });
  }

  for (let i = 0; i < suffix; i++) {
    edits.push({
      type: 'equal',
      a: a.length - suffix + i,
      b: b.length - suffix + i,
    });
  }
  return edits;
}

/** 统计新增/删除行数。 */
export function diffStat(a: string[], b: string[]): DiffStat {
  const edits = diffLines(a, b);
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    if (e.type === 'insert') {
      added++;
    } else if (e.type === 'delete') {
      removed++;
    }
  }
  return { added, removed };
}

/** 把编辑脚本合并成连续的变更块。 */
export function toHunks(a: string[], b: string[], maxD = DEFAULT_MAX_D): Hunk[] {
  const edits = diffLines(a, b, maxD);
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  // 下一个变更块在各自文本中的起点：equal 行之后的位置
  let aPos = 0;
  let bPos = 0;

  for (const e of edits) {
    if (e.type === 'equal') {
      current = null;
      aPos = e.a + 1;
      bPos = e.b + 1;
      continue;
    }
    if (!current) {
      current = { aStart: aPos, aCount: 0, bStart: bPos, bCount: 0, aLines: [], bLines: [] };
      hunks.push(current);
    }
    if (e.type === 'delete') {
      current.aCount++;
      current.aLines.push(a[e.a]);
    } else {
      current.bCount++;
      current.bLines.push(b[e.b]);
    }
  }
  return hunks;
}

/**
 * 把 hunk 从“旧文本”方向应用到“新文本”上（即片段级恢复）。
 * hunks 必须来自同一次 toHunks(a, b) 调用，可以只选其中一部分。
 */
export function applyHunks(b: string[], hunks: Hunk[]): string[] {
  const ordered = [...hunks].sort((x, y) => x.bStart - y.bStart);
  const out: string[] = [];
  let cursor = 0;
  for (const h of ordered) {
    if (h.bStart < cursor) {
      continue; // 重叠的块，忽略后一个
    }
    out.push(...b.slice(cursor, h.bStart));
    out.push(...h.aLines);
    cursor = h.bStart + h.bCount;
  }
  out.push(...b.slice(cursor));
  return out;
}

/** 把旧文本中的某个行区间映射到新文本中的行区间，用于“选中片段恢复”。 */
export function mapRange(
  a: string[],
  b: string[],
  aFrom: number,
  aTo: number,
  maxD = DEFAULT_MAX_D,
): { bFrom: number; bTo: number } {
  const edits = diffLines(a, b, maxD);
  let bFrom = -1;
  let bTo = -1;
  let bPos = 0;
  /** 已处理到的旧文本行号，用于判断插入行落在选区内部还是外部 */
  let lastA = -1;
  let anchor = b.length;
  let anchorSet = false;

  const include = (from: number, to: number) => {
    if (bFrom < 0) {
      bFrom = from;
      bTo = to;
      return;
    }
    bFrom = Math.min(bFrom, from);
    bTo = Math.max(bTo, to);
  };

  for (const e of edits) {
    if (e.type === 'insert') {
      // 插入行夹在 lastA 与 lastA+1 之间，两侧任一端落在选区内就一起替换
      const inside =
        (lastA >= aFrom && lastA <= aTo) || (lastA + 1 >= aFrom && lastA + 1 <= aTo);
      if (inside) {
        include(bPos, bPos + 1);
      }
      bPos++;
      continue;
    }
    if (e.a >= aFrom && !anchorSet) {
      anchor = bPos;
      anchorSet = true;
    }
    if (e.type === 'equal') {
      if (e.a >= aFrom && e.a <= aTo) {
        include(bPos, bPos + 1);
      }
      bPos++;
    } else if (e.a >= aFrom && e.a <= aTo) {
      // 该行在新文本中不存在，对应一个零宽位置
      include(bPos, bPos);
    }
    lastA = e.a;
  }

  if (bFrom < 0) {
    return { bFrom: anchor, bTo: anchor };
  }
  return { bFrom, bTo: Math.max(bFrom, bTo) };
}

function commonPrefix(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) {
    i++;
  }
  return i;
}

function commonSuffix(a: string[], b: string[], prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) {
    i++;
  }
  return i;
}

function replaceAll(a: string[], b: string[]): Edit[] {
  const edits: Edit[] = [];
  for (let i = 0; i < a.length; i++) {
    edits.push({ type: 'delete', a: i, b: -1 });
  }
  for (let i = 0; i < b.length; i++) {
    edits.push({ type: 'insert', a: -1, b: i });
  }
  return edits;
}

/** 返回 null 表示差异过大（超出 maxD），调用方退化处理。 */
function myers(a: string[], b: string[], maxD: number): Edit[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return replaceAll(a, b);
  }
  const max = Math.min(maxD, n + m);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, offset, n, m);
      }
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], offset: number, n: number, m: number): Edit[] {
  const reversed: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      reversed.push({ type: 'equal', a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        reversed.push({ type: 'insert', a: -1, b: y - 1 });
      } else {
        reversed.push({ type: 'delete', a: x - 1, b: -1 });
      }
      x = prevX;
      y = prevY;
    }
  }
  return reversed.reverse();
}
