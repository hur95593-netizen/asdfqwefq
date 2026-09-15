import { BlobCodec, sha1, sha256 } from './blobCodec';
import { CleanupPlan, PlanFile, planCleanup } from './cleanup';
import {
  AutoTag,
  ChangeKind,
  FileHistory,
  IndexEntry,
  RetentionPolicy,
  StorageStats,
  Version,
  emptyHistory,
} from './types';
import { Vfs, joinPath } from './vfs';
import { diffStat, splitLines } from '../util/diff';

export interface AddVersionOptions {
  tags: AutoTag[];
  label?: string;
  /** 该时间窗口内的同类变更合并进上一个版本 */
  mergeWindowMs: number;
  /** 强制新建版本，不做合并 */
  forceNew?: boolean;
}

export interface SearchHit {
  entry: IndexEntry;
  version: Version;
}

interface IndexFile {
  v: number;
  files: Record<string, Omit<IndexEntry, 'key'>>;
}

const INDEX_VERSION = 1;

/**
 * 一个工作区文件夹对应一个 HistoryStore。
 *
 * 目录结构：
 *   <storageDir>/blobs/<hh>/<sha256>   内容 blob（按 hash 去重，gzip/可选加密）
 *   <storageDir>/meta/<sha1(relPath)>.json  单个文件的时间轴
 *   <storageDir>/index/files.json      文件索引（用于 Recent Changes，可从 meta 重建）
 */
export class HistoryStore {
  private index: Map<string, IndexEntry> = new Map();
  private metaCache = new Map<string, FileHistory>();
  private indexLoaded = false;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly vfs: Vfs,
    /** 历史数据根目录（绝对路径，`/` 分隔） */
    readonly storageDir: string,
    private codec: BlobCodec,
  ) {}

  setCodec(codec: BlobCodec): void {
    this.codec = codec;
  }

  private get blobsDir(): string {
    return joinPath(this.storageDir, 'blobs');
  }

  private get metaDir(): string {
    return joinPath(this.storageDir, 'meta');
  }

  private get indexPath(): string {
    return joinPath(this.storageDir, 'index', 'files.json');
  }

  /** 把所有写操作串行化，避免并发写坏索引。 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  async init(): Promise<void> {
    await this.loadIndex();
  }

  // ---------------------------------------------------------------- 索引

  private async loadIndex(): Promise<void> {
    if (this.indexLoaded) {
      return;
    }
    this.indexLoaded = true;
    try {
      const raw = await this.vfs.read(this.indexPath);
      const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as IndexFile;
      if (!parsed || parsed.v !== INDEX_VERSION || typeof parsed.files !== 'object') {
        throw new Error('索引格式不兼容');
      }
      this.index = new Map(
        Object.entries(parsed.files).map(([key, value]) => [key, { key, ...value }]),
      );
    } catch (err) {
      const stat = await this.vfs.stat(this.metaDir);
      if (stat) {
        // 索引损坏或缺失：从 meta 目录重建
        await this.rebuildIndex();
      } else {
        this.index = new Map();
      }
    }
  }

  /** 从 meta 目录重建索引（索引损坏时的自愈路径）。 */
  async rebuildIndex(): Promise<void> {
    const entries = await this.vfs.list(this.metaDir);
    const rebuilt = new Map<string, IndexEntry>();
    for (const e of entries) {
      if (e.isDirectory || !e.name.endsWith('.json')) {
        continue;
      }
      const key = e.name.slice(0, -'.json'.length);
      const history = await this.readMeta(key);
      if (!history || history.versions.length === 0) {
        continue;
      }
      rebuilt.set(key, toIndexEntry(history));
    }
    this.index = rebuilt;
    this.indexLoaded = true;
    await this.writeIndex();
  }

  private async writeIndex(): Promise<void> {
    const files: IndexFile['files'] = {};
    for (const [key, entry] of this.index) {
      const { key: _ignored, ...rest } = entry;
      files[key] = rest;
    }
    await this.writeJson(this.indexPath, { v: INDEX_VERSION, files } satisfies IndexFile);
  }

  async listIndex(): Promise<IndexEntry[]> {
    await this.loadIndex();
    return [...this.index.values()].sort((a, b) => b.lastTs - a.lastTs);
  }

  // ---------------------------------------------------------------- 元数据

  keyOf(relPath: string): string {
    return sha1(relPath);
  }

  private metaPath(key: string): string {
    return joinPath(this.metaDir, `${key}.json`);
  }

  private async readMeta(key: string): Promise<FileHistory | undefined> {
    const cached = this.metaCache.get(key);
    if (cached) {
      return cached;
    }
    let raw: Uint8Array;
    try {
      raw = await this.vfs.read(this.metaPath(key));
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as FileHistory;
      if (!parsed || !Array.isArray(parsed.versions)) {
        throw new Error('元数据格式错误');
      }
      parsed.versions.sort((a, b) => a.ts - b.ts);
      this.metaCache.set(key, parsed);
      return parsed;
    } catch {
      // 损坏的元数据：备份后当作不存在，避免整个面板打不开
      try {
        await this.vfs.rename(this.metaPath(key), this.metaPath(key) + '.corrupt', {
          overwrite: true,
        });
      } catch {
        /* 备份失败也不阻塞 */
      }
      return undefined;
    }
  }

  private async writeMeta(history: FileHistory): Promise<void> {
    this.metaCache.set(history.key, history);
    await this.writeJson(this.metaPath(history.key), history);
  }

  /** 按时间倒序返回某个文件的所有版本。 */
  async getVersions(relPath: string): Promise<Version[]> {
    const history = await this.readMeta(this.keyOf(relPath));
    return history ? [...history.versions].reverse() : [];
  }

  async getHistory(relPath: string): Promise<FileHistory | undefined> {
    return this.readMeta(this.keyOf(relPath));
  }

  async getHistoryByKey(key: string): Promise<FileHistory | undefined> {
    return this.readMeta(key);
  }

  async getVersion(relPath: string, versionId: string): Promise<Version | undefined> {
    const history = await this.readMeta(this.keyOf(relPath));
    return history?.versions.find((v) => v.id === versionId);
  }

  // ---------------------------------------------------------------- blob

  private blobPath(hash: string): string {
    return joinPath(this.blobsDir, hash.slice(0, 2), hash);
  }

  private async writeBlob(hash: string, content: string): Promise<void> {
    const path = this.blobPath(hash);
    if (await this.vfs.stat(path)) {
      return; // 内容去重：已经存在就不重复写
    }
    const encoded = await this.codec.encode(content);
    await this.writeAtomic(path, encoded);
  }

  /** 读取某个版本的完整内容。 */
  async readContent(version: Version): Promise<string> {
    const raw = await this.vfs.read(this.blobPath(version.blob));
    return this.codec.decode(raw);
  }

  async hasBlob(hash: string): Promise<boolean> {
    return !!(await this.vfs.stat(this.blobPath(hash)));
  }

  // ---------------------------------------------------------------- 写入

  /**
   * 追加一个版本。内容与最新版本相同时返回 undefined（空变更过滤）。
   */
  async addVersion(
    relPath: string,
    content: string,
    options: AddVersionOptions,
  ): Promise<Version | undefined> {
    return this.enqueue(async () => {
      await this.loadIndex();
      const key = this.keyOf(relPath);
      const history = (await this.readMeta(key)) ?? emptyHistory(key, relPath);
      history.relPath = relPath;

      const hash = sha256(content);
      const latest = history.versions[history.versions.length - 1];
      const isDeletion = options.tags.includes('deleted');

      if (latest && latest.blob === hash && !isDeletion && !options.label && !options.forceNew) {
        return undefined; // 内容没变，不产生新版本
      }

      const previousContent = latest ? await this.readContentSafe(latest) : '';
      const stat = diffStat(splitLines(previousContent), splitLines(content));

      const now = Date.now();
      const version: Version = {
        id: newVersionId(now),
        ts: now,
        blob: hash,
        size: Buffer.byteLength(content, 'utf8'),
        tags: dedupeTags(options.tags),
        added: stat.added,
        removed: stat.removed,
      };
      if (options.label) {
        version.label = options.label;
      }
      if (isDeletion) {
        version.isDeletion = true;
      }

      await this.writeBlob(hash, content);

      const mergeable =
        !!latest &&
        !options.forceNew &&
        !options.label &&
        !latest.label &&
        !latest.isDeletion &&
        !isDeletion &&
        options.mergeWindowMs > 0 &&
        now - latest.ts <= options.mergeWindowMs;

      if (mergeable) {
        // 防抖合并：连续的小修改更新同一个版本，避免产生大量细碎节点
        const base =
          history.versions.length >= 2
            ? await this.readContentSafe(history.versions[history.versions.length - 2])
            : '';
        const merged = diffStat(splitLines(base), splitLines(content));
        latest.blob = hash;
        latest.ts = now;
        latest.size = version.size;
        latest.added = merged.added;
        latest.removed = merged.removed;
        latest.tags = dedupeTags([...latest.tags, ...version.tags]);
      } else {
        history.versions.push(version);
      }

      history.deleted = isDeletion;
      await this.writeMeta(history);
      this.index.set(key, toIndexEntry(history));
      await this.writeIndex();
      return mergeable ? latest : version;
    });
  }

  private async readContentSafe(version: Version): Promise<string> {
    try {
      return await this.readContent(version);
    } catch {
      return '';
    }
  }

  async setLabel(relPath: string, versionId: string, label: string | undefined): Promise<void> {
    await this.enqueue(async () => {
      const key = this.keyOf(relPath);
      const history = await this.readMeta(key);
      const version = history?.versions.find((v) => v.id === versionId);
      if (!history || !version) {
        return;
      }
      if (label) {
        version.label = label;
      } else {
        delete version.label;
      }
      await this.writeMeta(history);
    });
  }

  async deleteVersion(relPath: string, versionId: string): Promise<void> {
    await this.enqueue(async () => {
      await this.loadIndex();
      const key = this.keyOf(relPath);
      const history = await this.readMeta(key);
      if (!history) {
        return;
      }
      history.versions = history.versions.filter((v) => v.id !== versionId);
      if (history.versions.length === 0) {
        await this.dropFile(key);
        return;
      }
      history.deleted = !!history.versions[history.versions.length - 1].isDeletion;
      await this.writeMeta(history);
      this.index.set(key, toIndexEntry(history));
      await this.writeIndex();
    });
  }

  async clearFile(relPath: string): Promise<void> {
    await this.enqueue(async () => {
      await this.loadIndex();
      await this.dropFile(this.keyOf(relPath));
    });
  }

  private async dropFile(key: string): Promise<void> {
    this.metaCache.delete(key);
    this.index.delete(key);
    try {
      await this.vfs.delete(this.metaPath(key));
    } catch {
      /* 已经不存在 */
    }
    await this.writeIndex();
  }

  /** 文件重命名：历史跟着新路径走，不丢时间轴。 */
  async renameFile(oldRelPath: string, newRelPath: string): Promise<void> {
    await this.enqueue(async () => {
      await this.loadIndex();
      const oldKey = this.keyOf(oldRelPath);
      const history = await this.readMeta(oldKey);
      if (!history) {
        return;
      }
      const newKey = this.keyOf(newRelPath);
      const target = await this.readMeta(newKey);
      const merged: FileHistory = target
        ? {
            ...target,
            versions: [...target.versions, ...history.versions].sort((a, b) => a.ts - b.ts),
          }
        : { ...history, key: newKey, relPath: newRelPath };
      merged.key = newKey;
      merged.relPath = newRelPath;
      merged.deleted = false;
      const last = merged.versions[merged.versions.length - 1];
      if (last) {
        last.tags = dedupeTags([...last.tags, 'rename']);
      }
      await this.writeMeta(merged);
      this.index.set(newKey, toIndexEntry(merged));
      this.metaCache.delete(oldKey);
      this.index.delete(oldKey);
      try {
        await this.vfs.delete(this.metaPath(oldKey));
      } catch {
        /* ignore */
      }
      await this.writeIndex();
    });
  }

  async purgeAll(): Promise<void> {
    await this.enqueue(async () => {
      this.metaCache.clear();
      this.index.clear();
      this.indexLoaded = true;
      try {
        await this.vfs.delete(this.storageDir, { recursive: true });
      } catch {
        /* 目录本来就不存在 */
      }
    });
  }

  // ---------------------------------------------------------------- 搜索

  /** 按内容关键词过滤版本（限制扫描数量，避免在大历史上卡住）。 */
  async searchContent(relPath: string, keyword: string, maxVersions: number): Promise<Set<string>> {
    const hits = new Set<string>();
    if (!keyword) {
      return hits;
    }
    const needle = keyword.toLowerCase();
    const versions = await this.getVersions(relPath);
    let scanned = 0;
    for (const v of versions) {
      if (scanned >= maxVersions) {
        break;
      }
      scanned++;
      const content = await this.readContentSafe(v);
      if (content.toLowerCase().includes(needle)) {
        hits.add(v.id);
      }
    }
    return hits;
  }

  // ---------------------------------------------------------------- 清理与统计

  private async allHistories(): Promise<FileHistory[]> {
    await this.loadIndex();
    const out: FileHistory[] = [];
    for (const key of this.index.keys()) {
      const history = await this.readMeta(key);
      if (history) {
        out.push(history);
      }
    }
    return out;
  }

  private async blobSizes(): Promise<Record<string, number>> {
    const sizes: Record<string, number> = {};
    const shards = await this.vfs.list(this.blobsDir);
    for (const shard of shards) {
      if (!shard.isDirectory) {
        continue;
      }
      const files = await this.vfs.list(joinPath(this.blobsDir, shard.name));
      for (const f of files) {
        if (f.isDirectory) {
          continue;
        }
        const stat = await this.vfs.stat(joinPath(this.blobsDir, shard.name, f.name));
        sizes[f.name] = stat?.size ?? 0;
      }
    }
    return sizes;
  }

  /** 执行保留策略，并回收引用计数归零的 blob。 */
  async cleanup(policy: RetentionPolicy): Promise<CleanupPlan> {
    return this.enqueue(async () => {
      const histories = await this.allHistories();
      const blobSizes = await this.blobSizes();
      const files: PlanFile[] = histories.map((h) => ({
        key: h.key,
        versions: h.versions.map((v) => ({ id: v.id, ts: v.ts, blob: v.blob, label: v.label })),
      }));
      const plan = planCleanup({ files, blobSizes, policy, now: Date.now() });
      if (plan.remove.length === 0) {
        await this.collectOrphanBlobs(histories, blobSizes);
        return plan;
      }

      const byKey = new Map<string, Set<string>>();
      for (const r of plan.remove) {
        const set = byKey.get(r.key) ?? new Set<string>();
        set.add(r.id);
        byKey.set(r.key, set);
      }
      const survivors: FileHistory[] = [];
      for (const history of histories) {
        const drop = byKey.get(history.key);
        if (!drop) {
          survivors.push(history);
          continue;
        }
        history.versions = history.versions.filter((v) => !drop.has(v.id));
        if (history.versions.length === 0) {
          await this.dropFile(history.key);
          continue;
        }
        await this.writeMeta(history);
        this.index.set(history.key, toIndexEntry(history));
        survivors.push(history);
      }
      await this.writeIndex();
      await this.collectOrphanBlobs(survivors, blobSizes);
      return plan;
    });
  }

  /** 重新统计引用计数，删除没人引用的 blob。 */
  private async collectOrphanBlobs(
    histories: FileHistory[],
    blobSizes: Record<string, number>,
  ): Promise<void> {
    const alive = new Set<string>();
    for (const h of histories) {
      for (const v of h.versions) {
        alive.add(v.blob);
      }
    }
    for (const hash of Object.keys(blobSizes)) {
      if (!alive.has(hash)) {
        try {
          await this.vfs.delete(this.blobPath(hash));
        } catch {
          /* ignore */
        }
      }
    }
  }

  async stats(): Promise<StorageStats> {
    const histories = await this.allHistories();
    const blobSizes = await this.blobSizes();
    let versions = 0;
    let logicalBytes = 0;
    let oldestTs = Number.MAX_SAFE_INTEGER;
    let newestTs = 0;
    const perFile: StorageStats['topFiles'] = [];

    for (const h of histories) {
      versions += h.versions.length;
      const unique = new Set(h.versions.map((v) => v.blob));
      let bytes = 0;
      for (const blob of unique) {
        bytes += blobSizes[blob] ?? 0;
      }
      for (const v of h.versions) {
        logicalBytes += v.size;
        oldestTs = Math.min(oldestTs, v.ts);
        newestTs = Math.max(newestTs, v.ts);
      }
      perFile.push({ relPath: h.relPath, versions: h.versions.length, bytes });
    }
    perFile.sort((a, b) => b.bytes - a.bytes);

    let diskBytes = 0;
    for (const size of Object.values(blobSizes)) {
      diskBytes += size;
    }

    return {
      files: histories.length,
      versions,
      blobs: Object.keys(blobSizes).length,
      diskBytes,
      logicalBytes,
      oldestTs: versions === 0 ? 0 : oldestTs,
      newestTs,
      topFiles: perFile.slice(0, 20),
    };
  }

  // ---------------------------------------------------------------- 底层写

  private async writeJson(path: string, value: unknown): Promise<void> {
    await this.writeAtomic(path, Buffer.from(JSON.stringify(value), 'utf8'));
  }

  /** 先写临时文件再改名，避免进程被杀时留下半个文件。 */
  private async writeAtomic(path: string, data: Uint8Array): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf('/'));
    await this.vfs.mkdirp(dir);
    const tmp = `${path}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
    await this.vfs.write(tmp, data);
    try {
      await this.vfs.rename(tmp, path, { overwrite: true });
    } catch (err) {
      // 少数文件系统不支持覆盖改名，退化为直接写
      await this.vfs.write(path, data);
      try {
        await this.vfs.delete(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

function toIndexEntry(history: FileHistory): IndexEntry {
  const last = history.versions[history.versions.length - 1];
  let lastChange: ChangeKind = 'modified';
  if (last?.isDeletion) {
    lastChange = 'deleted';
  } else if (history.versions.length === 1 && last?.tags.includes('created')) {
    lastChange = 'created';
  }
  return {
    key: history.key,
    relPath: history.relPath,
    lastTs: last?.ts ?? 0,
    count: history.versions.length,
    deleted: history.deleted,
    lastChange,
  };
}

function dedupeTags(tags: AutoTag[]): AutoTag[] {
  return [...new Set(tags)];
}

let counter = 0;

/** 时间有序且不会重复的版本 id。 */
export function newVersionId(now: number): string {
  counter = (counter + 1) % 0xffff;
  return `${now.toString(36)}-${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
