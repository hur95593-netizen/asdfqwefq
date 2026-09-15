/** 自动标签：由触发来源决定，展示时带颜色区分。 */
export type AutoTag =
  | 'created'
  | 'deleted'
  | 'saved'
  | 'pause'
  | 'external'
  | 'closed'
  | 'manual'
  | 'restore'
  | 'rename';

export interface Version {
  /** 版本 id，时间有序 */
  id: string;
  /** 创建时间（epoch ms） */
  ts: number;
  /** 内容 blob 的 sha256（内容去重的依据） */
  blob: string;
  /** 原始内容字节数 */
  size: number;
  /** 用户自定义标签 */
  label?: string;
  /** 自动标签 */
  tags: AutoTag[];
  /** 相对上一个版本的新增行数 */
  added: number;
  /** 相对上一个版本的删除行数 */
  removed: number;
  /** 该版本表示文件在此刻被删除 */
  isDeletion?: boolean;
}

export interface FileHistory {
  /** 元数据格式版本 */
  v: number;
  /** 文件 key（相对路径的 sha1） */
  key: string;
  /** 相对工作区根目录的路径，使用 `/` 分隔 */
  relPath: string;
  /** 文件当前是否处于已删除状态 */
  deleted: boolean;
  /** 按时间升序 */
  versions: Version[];
}

export type ChangeKind = 'created' | 'modified' | 'deleted';

export interface IndexEntry {
  key: string;
  relPath: string;
  lastTs: number;
  count: number;
  deleted: boolean;
  lastChange: ChangeKind;
}

export interface StorageStats {
  files: number;
  versions: number;
  blobs: number;
  /** blob 实际占用的磁盘字节数 */
  diskBytes: number;
  /** 所有版本的原始内容字节数之和（去重前） */
  logicalBytes: number;
  oldestTs: number;
  newestTs: number;
  topFiles: Array<{ relPath: string; versions: number; bytes: number }>;
}

export interface RetentionPolicy {
  maxVersionsPerFile: number;
  maxAgeDays: number;
  maxTotalSizeMB: number;
}

export function emptyHistory(key: string, relPath: string): FileHistory {
  return { v: 1, key, relPath, deleted: false, versions: [] };
}
