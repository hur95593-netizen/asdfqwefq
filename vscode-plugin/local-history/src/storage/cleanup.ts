import { RetentionPolicy } from './types';

export interface PlanVersion {
  id: string;
  ts: number;
  blob: string;
  label?: string;
}

export interface PlanFile {
  key: string;
  /** 按时间升序 */
  versions: PlanVersion[];
}

export interface PlanInput {
  files: PlanFile[];
  /** blob hash -> 磁盘字节数 */
  blobSizes: Record<string, number>;
  policy: RetentionPolicy;
  now: number;
}

export interface CleanupPlan {
  /** 需要删除的版本 */
  remove: Array<{ key: string; id: string }>;
  /** 删除后引用计数归零、可以真正删除的 blob */
  orphanBlobs: string[];
  freedBytes: number;
}

/**
 * 纯函数形式的清理规划：先按保留天数，再按单文件版本数，最后按总大小。
 * 带标签的版本和每个文件的最新版本永不自动清理。
 */
export function planCleanup(input: PlanInput): CleanupPlan {
  const { files, blobSizes, policy, now } = input;

  const refs = new Map<string, number>();
  for (const f of files) {
    for (const v of f.versions) {
      refs.set(v.blob, (refs.get(v.blob) ?? 0) + 1);
    }
  }

  const removed = new Set<string>();
  const remove: Array<{ key: string; id: string }> = [];
  const orphanBlobs: string[] = [];
  let freedBytes = 0;

  const markId = (key: string, id: string) => `${key}::${id}`;

  const doRemove = (key: string, v: PlanVersion) => {
    const mark = markId(key, v.id);
    if (removed.has(mark)) {
      return;
    }
    removed.add(mark);
    remove.push({ key, id: v.id });
    const next = (refs.get(v.blob) ?? 1) - 1;
    refs.set(v.blob, next);
    if (next <= 0) {
      orphanBlobs.push(v.blob);
      freedBytes += blobSizes[v.blob] ?? 0;
    }
  };

  const isProtected = (f: PlanFile, v: PlanVersion) =>
    !!v.label || f.versions[f.versions.length - 1]?.id === v.id;

  // 1) 保留天数
  if (policy.maxAgeDays > 0) {
    const cutoff = now - policy.maxAgeDays * 86400000;
    for (const f of files) {
      for (const v of f.versions) {
        if (v.ts < cutoff && !isProtected(f, v)) {
          doRemove(f.key, v);
        }
      }
    }
  }

  // 2) 单文件版本数上限（淘汰最旧的）
  if (policy.maxVersionsPerFile > 0) {
    for (const f of files) {
      const alive = f.versions.filter((v) => !removed.has(markId(f.key, v.id)));
      let excess = alive.length - policy.maxVersionsPerFile;
      for (const v of alive) {
        if (excess <= 0) {
          break;
        }
        if (isProtected(f, v)) {
          continue;
        }
        doRemove(f.key, v);
        excess--;
      }
    }
  }

  // 3) 总大小上限（全局按时间从旧到新淘汰）
  if (policy.maxTotalSizeMB > 0) {
    const limit = policy.maxTotalSizeMB * 1024 * 1024;
    let used = 0;
    for (const [blob, count] of refs) {
      if (count > 0) {
        used += blobSizes[blob] ?? 0;
      }
    }
    if (used > limit) {
      const all: Array<{ file: PlanFile; v: PlanVersion }> = [];
      for (const f of files) {
        for (const v of f.versions) {
          if (!removed.has(markId(f.key, v.id)) && !isProtected(f, v)) {
            all.push({ file: f, v });
          }
        }
      }
      all.sort((x, y) => x.v.ts - y.v.ts);
      for (const item of all) {
        if (used <= limit) {
          break;
        }
        const before = freedBytes;
        doRemove(item.file.key, item.v);
        used -= freedBytes - before;
      }
    }
  }

  return { remove, orphanBlobs, freedBytes };
}
