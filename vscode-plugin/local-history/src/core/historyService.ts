import * as vscode from 'vscode';
import { BlobCodec } from '../storage/blobCodec';
import { HistoryStore } from '../storage/store';
import { VscodeVfs } from '../storage/vscodeVfs';
import { joinPath } from '../storage/vfs';
import { matchesAny } from '../util/glob';
import { LocalHistoryConfig, readConfig } from './config';

export interface Target {
  folder: vscode.WorkspaceFolder;
  store: HistoryStore;
  /** 相对工作区根目录，`/` 分隔 */
  relPath: string;
  uri: vscode.Uri;
}

const SECRET_KEY = 'localHistory.passphrase';

/**
 * 按工作区文件夹管理 HistoryStore，并负责路径解析、排除规则、.gitignore 与加密口令。
 */
export class HistoryService implements vscode.Disposable {
  private stores = new Map<string, HistoryStore>();
  private codec = new BlobCodec();
  private disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<vscode.Uri | undefined>();

  /** 历史发生变化（新增/删除版本等），用于刷新视图。 */
  readonly onDidChangeHistory = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async init(): Promise<void> {
    await this.reloadPassphrase();
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        for (const removed of e.removed) {
          this.stores.delete(removed.uri.toString());
        }
        this.changed.fire(undefined);
      }),
    );
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      await this.ensureGitignore(folder);
    }
  }

  dispose(): void {
    this.changed.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  notifyChanged(uri?: vscode.Uri): void {
    this.changed.fire(uri);
  }

  config(scope?: vscode.Uri): LocalHistoryConfig {
    return readConfig(scope);
  }

  // ---------------------------------------------------------------- 加密口令

  async reloadPassphrase(): Promise<void> {
    const enabled = readConfig().encryptionEnabled;
    const secret = enabled ? await this.context.secrets.get(SECRET_KEY) : undefined;
    this.codec.setPassphrase(secret);
    for (const store of this.stores.values()) {
      store.setCodec(this.codec);
    }
  }

  async setPassphrase(passphrase: string | undefined): Promise<void> {
    if (passphrase) {
      await this.context.secrets.store(SECRET_KEY, passphrase);
    } else {
      await this.context.secrets.delete(SECRET_KEY);
    }
    await this.reloadPassphrase();
  }

  get encryptionReady(): boolean {
    return !readConfig().encryptionEnabled || this.codec.encrypted;
  }

  // ---------------------------------------------------------------- store

  storeFor(folder: vscode.WorkspaceFolder): HistoryStore {
    const id = folder.uri.toString();
    let store = this.stores.get(id);
    if (!store) {
      const dirName = readConfig(folder.uri).storageDirName;
      store = new HistoryStore(
        new VscodeVfs(folder.uri),
        joinPath(folder.uri.path, dirName),
        this.codec,
      );
      void store.init();
      this.stores.set(id, store);
    }
    return store;
  }

  allTargets(): Array<{ folder: vscode.WorkspaceFolder; store: HistoryStore }> {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      folder,
      store: this.storeFor(folder),
    }));
  }

  /** 解析一个文件 Uri，落在工作区之外或被排除时返回 undefined。 */
  resolve(uri: vscode.Uri | undefined): Target | undefined {
    if (!uri || uri.scheme !== 'file') {
      return undefined;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    const base = folder.uri.path.endsWith('/') ? folder.uri.path : folder.uri.path + '/';
    if (!uri.path.startsWith(base)) {
      return undefined;
    }
    const relPath = uri.path.slice(base.length);
    if (!relPath) {
      return undefined;
    }
    const cfg = readConfig(folder.uri);
    if (relPath === cfg.storageDirName || relPath.startsWith(cfg.storageDirName + '/')) {
      return undefined;
    }
    if (matchesAny(relPath, cfg.exclude)) {
      return undefined;
    }
    return { folder, store: this.storeFor(folder), relPath, uri };
  }

  /** 由 folder + relPath 反推文件 Uri。 */
  fileUri(folder: vscode.WorkspaceFolder, relPath: string): vscode.Uri {
    return folder.uri.with({ path: joinPath(folder.uri.path, relPath) });
  }

  folderById(id: string): vscode.WorkspaceFolder | undefined {
    return (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.toString() === id);
  }

  // ---------------------------------------------------------------- .gitignore

  /** 工作区是 git 仓库时，把历史目录写进 .gitignore，避免被提交。 */
  async ensureGitignore(folder: vscode.WorkspaceFolder): Promise<void> {
    const cfg = readConfig(folder.uri);
    if (!cfg.enabled || !cfg.addToGitignore) {
      return;
    }
    const gitDir = folder.uri.with({ path: joinPath(folder.uri.path, '.git') });
    try {
      await vscode.workspace.fs.stat(gitDir);
    } catch {
      return; // 不是 git 仓库，不去创建 .gitignore
    }
    const entry = `${cfg.storageDirName}/`;
    const gitignore = folder.uri.with({ path: joinPath(folder.uri.path, '.gitignore') });
    let text = '';
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(gitignore)).toString('utf8');
    } catch {
      text = '';
    }
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(entry) || lines.includes(cfg.storageDirName)) {
      return;
    }
    const suffix = text.length === 0 || text.endsWith('\n') ? '' : '\n';
    const addition = `${suffix}\n# VSCode Local History\n${entry}\n`;
    await vscode.workspace.fs.writeFile(gitignore, Buffer.from(text + addition, 'utf8'));
  }
}
