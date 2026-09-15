import * as vscode from 'vscode';
import { AutoTag, Version } from '../storage/types';
import { HistoryService, Target } from './historyService';

const EXTERNAL_SUPPRESS_MS = 2000;
const EXTERNAL_DEBOUNCE_MS = 400;
const MAX_FILES_PER_DELETED_FOLDER = 2000;

/**
 * 自动快照系统：保存、编辑停顿、关闭、外部变更、创建、删除、重命名。
 * 所有磁盘 IO 都是异步的，不阻塞编辑器输入。
 */
export class SnapshotManager implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private pauseTimers = new Map<string, NodeJS.Timeout>();
  private externalTimers = new Map<string, NodeJS.Timeout>();
  /** 我们自己刚写过的文件，短时间内忽略文件系统事件 */
  private suppressed = new Map<string, number>();
  /** 删除前抢救下来的内容 */
  private pendingDeleteContent = new Map<string, string>();
  private watcher?: vscode.FileSystemWatcher;

  constructor(private readonly service: HistoryService) {}

  start(): void {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.onClose(doc)),
      vscode.workspace.onWillDeleteFiles((e) => this.onWillDelete(e)),
      vscode.workspace.onDidDeleteFiles((e) => void this.onDidDelete(e)),
      vscode.workspace.onDidRenameFiles((e) => void this.onDidRename(e)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('localHistory')) {
          void this.service.reloadPassphrase();
          this.restartWatcher();
        }
      }),
    );
    this.restartWatcher();
  }

  dispose(): void {
    for (const t of this.pauseTimers.values()) {
      clearTimeout(t);
    }
    for (const t of this.externalTimers.values()) {
      clearTimeout(t);
    }
    this.pauseTimers.clear();
    this.externalTimers.clear();
    this.watcher?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  /** 关闭编辑器/退出前把还没落盘的停顿快照写掉。 */
  async flushPending(): Promise<void> {
    const uris = [...this.pauseTimers.keys()];
    for (const key of uris) {
      const timer = this.pauseTimers.get(key);
      if (timer) {
        clearTimeout(timer);
      }
      this.pauseTimers.delete(key);
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
      if (doc) {
        await this.snapshotDocument(doc, ['pause']);
      }
    }
  }

  private restartWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    const cfg = this.service.config();
    if (!cfg.enabled || !cfg.onExternalChange) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidChange((uri) => this.scheduleExternal(uri, 'external'));
    watcher.onDidCreate((uri) => this.scheduleExternal(uri, 'created'));
    // VSCode 之外的删除不会触发 onDidDeleteFiles，只能靠文件系统监听
    watcher.onDidDelete((uri) => void this.onExternalDelete(uri));
    this.watcher = watcher;
  }

  // ---------------------------------------------------------------- 触发器

  private onSave(doc: vscode.TextDocument): void {
    const cfg = this.service.config(doc.uri);
    if (!cfg.enabled || !cfg.onSave) {
      return;
    }
    this.clearPause(doc.uri);
    void this.snapshotDocument(doc, ['saved']);
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    const cfg = this.service.config(e.document.uri);
    if (!cfg.enabled || !cfg.onPause || e.contentChanges.length === 0) {
      return;
    }
    if (!this.service.resolve(e.document.uri)) {
      return;
    }
    if (Buffer.byteLength(e.document.getText(), 'utf8') > cfg.largeFileThresholdBytes) {
      return; // 大文件只在保存/手动时快照
    }
    const key = e.document.uri.toString();
    this.clearPause(e.document.uri);
    this.pauseTimers.set(
      key,
      setTimeout(() => {
        this.pauseTimers.delete(key);
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
        if (doc) {
          void this.snapshotDocument(doc, ['pause']);
        }
      }, cfg.debounceMs),
    );
  }

  private onClose(doc: vscode.TextDocument): void {
    const cfg = this.service.config(doc.uri);
    this.clearPause(doc.uri);
    if (!cfg.enabled || !cfg.onClose) {
      return;
    }
    void this.snapshotDocument(doc, ['closed']);
  }

  private onWillDelete(e: vscode.FileWillDeleteEvent): void {
    // 在文件真正消失之前把最后一版内容读出来
    e.waitUntil(this.captureBeforeDelete(e.files));
  }

  private async captureBeforeDelete(files: readonly vscode.Uri[]): Promise<void> {
    for (const uri of files) {
      for (const file of await this.expandFiles(uri)) {
        const target = this.service.resolve(file);
        if (!target) {
          continue;
        }
        const content = await this.readTextFile(file);
        if (content !== undefined) {
          this.pendingDeleteContent.set(file.toString(), content);
        }
      }
    }
  }

  private async onDidDelete(e: vscode.FileDeleteEvent): Promise<void> {
    const cfg = this.service.config();
    if (!cfg.enabled) {
      return;
    }
    for (const uri of e.files) {
      await this.markDeleted(uri);
      // 目录删除时，索引里该目录下的文件也要标记
      const prefix = uri.path + '/';
      for (const { folder, store } of this.service.allTargets()) {
        const base = folder.uri.path.endsWith('/') ? folder.uri.path : folder.uri.path + '/';
        for (const entry of await store.listIndex()) {
          if (entry.deleted) {
            continue;
          }
          const full = base + entry.relPath;
          if (full.startsWith(prefix)) {
            await this.markDeleted(folder.uri.with({ path: full }));
          }
        }
      }
    }
    this.service.notifyChanged();
  }

  private async onExternalDelete(uri: vscode.Uri): Promise<void> {
    if (!this.service.config().enabled || !this.service.resolve(uri)) {
      return;
    }
    // 重命名等操作会先删后建，稍等一下再确认文件确实不在了
    await new Promise((resolve) => setTimeout(resolve, EXTERNAL_DEBOUNCE_MS));
    try {
      await vscode.workspace.fs.stat(uri);
      return;
    } catch {
      /* 确实已经不存在 */
    }
    await this.markDeleted(uri);
    this.service.notifyChanged();
  }

  private async markDeleted(uri: vscode.Uri): Promise<void> {
    const target = this.service.resolve(uri);
    if (!target) {
      return;
    }
    const pending = this.pendingDeleteContent.get(uri.toString());
    this.pendingDeleteContent.delete(uri.toString());
    let content = pending;
    if (content === undefined) {
      const versions = await target.store.getVersions(target.relPath);
      const latest = versions[0];
      if (!latest || latest.isDeletion) {
        return; // 没有历史或已经标记过删除
      }
      content = await target.store.readContent(latest).catch(() => undefined);
      if (content === undefined) {
        return;
      }
    }
    await target.store.addVersion(target.relPath, content, {
      tags: ['deleted'],
      mergeWindowMs: 0,
      forceNew: true,
    });
  }

  private async onDidRename(e: vscode.FileRenameEvent): Promise<void> {
    const cfg = this.service.config();
    if (!cfg.enabled) {
      return;
    }
    for (const { oldUri, newUri } of e.files) {
      const from = this.service.resolve(oldUri);
      const to = this.service.resolve(newUri);
      if (from && to && from.store === to.store) {
        await to.store.renameFile(from.relPath, to.relPath);
      } else if (to) {
        const content = await this.readTextFile(newUri);
        if (content !== undefined) {
          await to.store.addVersion(to.relPath, content, {
            tags: ['rename'],
            mergeWindowMs: 0,
          });
        }
      }
    }
    this.service.notifyChanged();
  }

  private scheduleExternal(uri: vscode.Uri, tag: AutoTag): void {
    if (!this.service.resolve(uri)) {
      return;
    }
    const key = uri.toString();
    const suppressedAt = this.suppressed.get(key);
    if (suppressedAt && Date.now() - suppressedAt < EXTERNAL_SUPPRESS_MS) {
      return;
    }
    const existing = this.externalTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.externalTimers.set(
      key,
      setTimeout(() => {
        this.externalTimers.delete(key);
        void this.snapshotExternal(uri, tag);
      }, EXTERNAL_DEBOUNCE_MS),
    );
  }

  private async snapshotExternal(uri: vscode.Uri, tag: AutoTag): Promise<void> {
    const cfg = this.service.config(uri);
    if (!cfg.enabled) {
      return;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open?.isDirty) {
      return; // 编辑器里的内容才是权威版本，交给停顿/保存触发器
    }
    const content = await this.readTextFile(uri);
    if (content === undefined) {
      return;
    }
    if (
      tag === 'external' &&
      Buffer.byteLength(content, 'utf8') > cfg.largeFileThresholdBytes
    ) {
      return;
    }
    await this.snapshot(uri, content, [tag]);
  }

  // ---------------------------------------------------------------- 快照

  /** 手动快照（可带标签）。 */
  async manualSnapshot(uri: vscode.Uri, label?: string): Promise<Version | undefined> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const content = doc ? doc.getText() : await this.readTextFile(uri);
    if (content === undefined) {
      return undefined;
    }
    return this.snapshot(uri, content, ['manual'], { label, forceNew: true });
  }

  async snapshotDocument(doc: vscode.TextDocument, tags: AutoTag[]): Promise<Version | undefined> {
    if (doc.uri.scheme !== 'file') {
      return undefined;
    }
    return this.snapshot(doc.uri, doc.getText(), tags);
  }

  async snapshot(
    uri: vscode.Uri,
    content: string,
    tags: AutoTag[],
    options: { label?: string; forceNew?: boolean } = {},
  ): Promise<Version | undefined> {
    const target = this.service.resolve(uri);
    if (!target) {
      return undefined;
    }
    const cfg = this.service.config(uri);
    if (!cfg.enabled) {
      return undefined;
    }
    if (!this.service.encryptionReady) {
      return undefined;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (cfg.maxFileSizeBytes > 0 && bytes > cfg.maxFileSizeBytes) {
      return undefined;
    }
    if (looksBinary(content)) {
      return undefined;
    }
    this.suppressed.set(uri.toString(), Date.now());
    try {
      const version = await target.store.addVersion(target.relPath, content, {
        tags,
        label: options.label,
        mergeWindowMs: cfg.mergeWindowMs,
        forceNew: options.forceNew,
      });
      if (version) {
        this.service.notifyChanged(uri);
      }
      return version;
    } catch (err) {
      console.error('[Local History] 创建快照失败', target.relPath, err);
      return undefined;
    }
  }

  /** 供还原逻辑使用：写文件时抑制随之而来的文件系统事件。 */
  suppress(uri: vscode.Uri): void {
    this.suppressed.set(uri.toString(), Date.now());
  }

  resolveTarget(uri: vscode.Uri): Target | undefined {
    return this.service.resolve(uri);
  }

  // ---------------------------------------------------------------- 辅助

  private clearPause(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = this.pauseTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.pauseTimers.delete(key);
    }
  }

  private async readTextFile(uri: vscode.Uri): Promise<string | undefined> {
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(data).toString('utf8');
    } catch {
      return undefined;
    }
  }

  /** 把可能是目录的 Uri 展开成文件列表（带上限，避免删大目录时卡住）。 */
  private async expandFiles(uri: vscode.Uri): Promise<vscode.Uri[]> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return [];
    }
    if (stat.type !== vscode.FileType.Directory) {
      return [uri];
    }
    const out: vscode.Uri[] = [];
    const queue = [uri];
    while (queue.length > 0 && out.length < MAX_FILES_PER_DELETED_FOLDER) {
      const dir = queue.shift()!;
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(dir);
      } catch {
        continue;
      }
      for (const [name, type] of entries) {
        const child = dir.with({ path: dir.path + '/' + name });
        if (type === vscode.FileType.Directory) {
          queue.push(child);
        } else if (out.length < MAX_FILES_PER_DELETED_FOLDER) {
          out.push(child);
        }
      }
    }
    return out;
  }
}

/** 粗略的二进制判定：出现 NUL 就不记录，避免把图片等塞进历史。 */
export function looksBinary(content: string): boolean {
  const probe = content.length > 8192 ? content.slice(0, 8192) : content;
  return probe.includes(' ');
}
