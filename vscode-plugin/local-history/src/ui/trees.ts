import * as vscode from 'vscode';
import { HistoryService } from '../core/historyService';
import { basename, dirname } from '../diff/diffService';
import { AutoTag, IndexEntry, Version } from '../storage/types';
import {
  BUCKET_LABEL,
  BUCKET_ORDER,
  TimeBucket,
  bucketOf,
  formatRelative,
  formatTimestamp,
} from '../util/time';

/** 命令参数：既可以来自树节点，也可以来自 Webview。 */
export interface VersionTarget {
  folderId: string;
  relPath: string;
  versionId?: string;
}

export class VersionItem extends vscode.TreeItem {
  readonly target: VersionTarget;

  constructor(folder: vscode.WorkspaceFolder, relPath: string, version: Version) {
    super(formatTimestamp(version.ts), vscode.TreeItemCollapsibleState.None);
    this.target = { folderId: folder.uri.toString(), relPath, versionId: version.id };
    this.contextValue = 'localHistory.version';
    this.iconPath = new vscode.ThemeIcon(iconForTags(version));
    const stats: string[] = [];
    if (version.added > 0) {
      stats.push(`+${version.added}`);
    }
    if (version.removed > 0) {
      stats.push(`-${version.removed}`);
    }
    this.description = [version.label, stats.join(' ')].filter(Boolean).join('  ');
    this.tooltip = new vscode.MarkdownString(
      [
        `**${formatTimestamp(version.ts)}**（${formatRelative(version.ts)}）`,
        version.label ? `标签：\`${version.label}\`` : '',
        version.tags.length > 0 ? `触发：${version.tags.join(', ')}` : '',
        `变更：+${version.added} / -${version.removed}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    this.command = {
      command: 'localHistory.openVersionDiff',
      title: '与当前版本对比',
      arguments: [this],
    };
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'localHistory.message';
  }
}

/** 侧边栏「File History」：当前活动文件的时间轴。 */
export class FileHistoryTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private current?: { folder: vscode.WorkspaceFolder; relPath: string };

  constructor(private readonly service: HistoryService) {}

  refresh(): void {
    this.emitter.fire();
  }

  setActiveFile(uri: vscode.Uri | undefined): void {
    const target = this.service.resolve(uri);
    if (target) {
      this.current = { folder: target.folder, relPath: target.relPath };
    } else if (!uri) {
      this.current = undefined;
    }
    this.refresh();
  }

  get activeFile(): { folder: vscode.WorkspaceFolder; relPath: string } | undefined {
    return this.current;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element || !this.current) {
      return [];
    }
    const { folder, relPath } = this.current;
    const versions = await this.service.storeFor(folder).getVersions(relPath);
    if (versions.length === 0) {
      return [new MessageItem(`${basename(relPath)} 还没有历史记录`)];
    }
    return versions.map((v) => new VersionItem(folder, relPath, v));
  }
}

class BucketItem extends vscode.TreeItem {
  constructor(
    readonly bucket: TimeBucket,
    count: number,
  ) {
    super(BUCKET_LABEL[bucket], vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${count}`;
    this.contextValue = 'localHistory.bucket';
  }
}

class ChangedFileItem extends vscode.TreeItem {
  readonly target: VersionTarget;

  constructor(folder: vscode.WorkspaceFolder, entry: IndexEntry, service: HistoryService) {
    super(basename(entry.relPath), vscode.TreeItemCollapsibleState.None);
    this.target = { folderId: folder.uri.toString(), relPath: entry.relPath };
    this.contextValue = entry.deleted ? 'localHistory.deletedFile' : 'localHistory.changedFile';
    this.resourceUri = service.fileUri(folder, entry.relPath);
    const dir = dirname(entry.relPath);
    this.description = `${dir ? dir + '  ·  ' : ''}${formatRelative(entry.lastTs)}  ·  ${entry.count} 版本`;
    this.iconPath = new vscode.ThemeIcon(iconForChange(entry));
    this.tooltip = new vscode.MarkdownString(
      `**${entry.relPath}**\n\n最后变更：${formatTimestamp(entry.lastTs)}\n\n版本数：${entry.count}`,
    );
    this.command = {
      command: 'localHistory.showHistory',
      title: '显示文件历史',
      arguments: [this],
    };
  }
}

/** 侧边栏「Recent Changes」：整个工作区按时间分组的变更。 */
export class RecentChangesTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** 一次刷新内复用同一份快照，避免展开每个分组都重扫索引 */
  private cache?: Promise<
    Map<TimeBucket, Array<{ folder: vscode.WorkspaceFolder; entry: IndexEntry }>>
  >;

  constructor(private readonly service: HistoryService) {}

  refresh(): void {
    this.cache = undefined;
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      this.cache = undefined;
    }
    if (!this.cache) {
      this.cache = this.load();
    }
    const grouped = await this.cache;
    if (!element) {
      const total = [...grouped.values()].reduce((sum, list) => sum + list.length, 0);
      if (total === 0) {
        return [new MessageItem('还没有记录到任何变更')];
      }
      return BUCKET_ORDER.filter((b) => (grouped.get(b)?.length ?? 0) > 0).map(
        (b) => new BucketItem(b, grouped.get(b)!.length),
      );
    }
    if (element instanceof BucketItem) {
      return (grouped.get(element.bucket) ?? []).map(
        ({ folder, entry }) => new ChangedFileItem(folder, entry, this.service),
      );
    }
    return [];
  }

  private async load(): Promise<
    Map<TimeBucket, Array<{ folder: vscode.WorkspaceFolder; entry: IndexEntry }>>
  > {
    const now = Date.now();
    const grouped = new Map<TimeBucket, Array<{ folder: vscode.WorkspaceFolder; entry: IndexEntry }>>();
    for (const { folder, store } of this.service.allTargets()) {
      for (const entry of await store.listIndex()) {
        const bucket = bucketOf(entry.lastTs, now);
        const list = grouped.get(bucket) ?? [];
        list.push({ folder, entry });
        grouped.set(bucket, list);
      }
    }
    for (const list of grouped.values()) {
      list.sort((a, b) => b.entry.lastTs - a.entry.lastTs);
    }
    return grouped;
  }
}

/** 侧边栏「Deleted Files」：已删除文件的历史，可一键恢复。 */
export class DeletedFilesTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly service: HistoryService) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return [];
    }
    const items: vscode.TreeItem[] = [];
    for (const { folder, store } of this.service.allTargets()) {
      for (const entry of await store.listIndex()) {
        if (entry.deleted) {
          items.push(new ChangedFileItem(folder, entry, this.service));
        }
      }
    }
    return items;
  }
}

function iconForTags(version: Version): string {
  const priority: Array<[AutoTag, string]> = [
    ['deleted', 'trash'],
    ['created', 'new-file'],
    ['manual', 'device-camera'],
    ['restore', 'discard'],
    ['rename', 'replace'],
    ['external', 'link-external'],
    ['closed', 'close'],
    ['pause', 'edit'],
    ['saved', 'save'],
  ];
  if (version.label) {
    return 'tag';
  }
  for (const [tag, icon] of priority) {
    if (version.tags.includes(tag)) {
      return icon;
    }
  }
  return 'circle-outline';
}

function iconForChange(entry: IndexEntry): string {
  if (entry.deleted) {
    return 'trash';
  }
  return entry.lastChange === 'created' ? 'new-file' : 'edit';
}
