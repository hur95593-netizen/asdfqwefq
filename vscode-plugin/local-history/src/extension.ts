import * as vscode from 'vscode';
import { HistoryService } from './core/historyService';
import { SnapshotManager } from './core/snapshotManager';
import { HistoryContentProvider, SCHEME, parseVersionUri } from './diff/contentProvider';
import { DiffService, basename } from './diff/diffService';
import { RestoreService } from './restore/restoreService';
import { HistoryStore } from './storage/store';
import { Version } from './storage/types';
import { HistoryPanel } from './ui/historyPanel';
import { StatsPanel } from './ui/statsPanel';
import { DeletedFilesTree, FileHistoryTree, RecentChangesTree, VersionTarget } from './ui/trees';
import { formatSize, formatTimestamp } from './util/time';

let activeSnapshots: SnapshotManager | undefined;

const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const CLEANUP_DELAY_MS = 10 * 1000;

interface Resolved {
  folder: vscode.WorkspaceFolder;
  relPath: string;
  store: HistoryStore;
  version?: Version;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const service = new HistoryService(context);
  await service.init();

  const snapshots = new SnapshotManager(service);
  activeSnapshots = snapshots;
  const diff = new DiffService(service);
  const restore = new RestoreService(service, snapshots);
  const contentProvider = new HistoryContentProvider(service);

  const fileHistoryTree = new FileHistoryTree(service);
  const recentChangesTree = new RecentChangesTree(service);
  const deletedFilesTree = new DeletedFilesTree(service);

  context.subscriptions.push(
    service,
    snapshots,
    contentProvider,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
    vscode.window.registerTreeDataProvider('localHistory.fileHistory', fileHistoryTree),
    vscode.window.registerTreeDataProvider('localHistory.recentChanges', recentChangesTree),
    vscode.window.registerTreeDataProvider('localHistory.deletedFiles', deletedFilesTree),
  );

  snapshots.start();
  fileHistoryTree.setActiveFile(vscode.window.activeTextEditor?.document.uri);

  const refreshViews = () => {
    fileHistoryTree.refresh();
    recentChangesTree.refresh();
    deletedFilesTree.refresh();
  };

  context.subscriptions.push(
    service.onDidChangeHistory(() => refreshViews()),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri.scheme === 'file') {
        fileHistoryTree.setActiveFile(editor.document.uri);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
      for (const added of e.added) {
        await service.ensureGitignore(added);
      }
      refreshViews();
    }),
  );

  // -------------------------------------------------------------- 参数解析

  /** 命令可能来自树节点、资源管理器右键（Uri）或命令面板（当前编辑器）。 */
  async function resolveArg(arg: unknown): Promise<Resolved | undefined> {
    let target: VersionTarget | undefined;
    if (arg && typeof arg === 'object' && 'target' in arg) {
      target = (arg as { target: VersionTarget }).target;
    }
    if (target) {
      const folder = service.folderById(target.folderId);
      if (!folder) {
        return undefined;
      }
      const store = service.storeFor(folder);
      const version = target.versionId
        ? await store.getVersion(target.relPath, target.versionId)
        : undefined;
      return { folder, relPath: target.relPath, store, version };
    }

    let uri = arg instanceof vscode.Uri ? arg : undefined;
    if (!uri) {
      const active = vscode.window.activeTextEditor?.document.uri;
      // 在历史版本的编辑器里执行命令时，回落到它对应的真实文件
      const ref = active ? parseVersionUri(active) : undefined;
      if (ref) {
        const folder = service.folderById(ref.folderId);
        if (folder) {
          const store = service.storeFor(folder);
          return {
            folder,
            relPath: ref.relPath,
            store,
            version: await store.getVersion(ref.relPath, ref.versionId),
          };
        }
      }
      uri = active;
    }
    if (!uri) {
      const activeFile = fileHistoryTree.activeFile;
      if (activeFile) {
        return {
          folder: activeFile.folder,
          relPath: activeFile.relPath,
          store: service.storeFor(activeFile.folder),
        };
      }
      return undefined;
    }
    const resolved = service.resolve(uri);
    if (!resolved) {
      return undefined;
    }
    return { folder: resolved.folder, relPath: resolved.relPath, store: resolved.store };
  }

  async function requireTarget(arg: unknown): Promise<Resolved | undefined> {
    const resolved = await resolveArg(arg);
    if (!resolved) {
      void vscode.window.showInformationMessage(
        'Local History：请先在工作区中打开或选中一个被跟踪的文件。',
      );
      return undefined;
    }
    return resolved;
  }

  /** 让用户从时间轴里挑一个版本（用于没有指定版本的命令）。 */
  async function pickVersion(resolved: Resolved, title: string): Promise<Version | undefined> {
    const versions = await resolved.store.getVersions(resolved.relPath);
    if (versions.length === 0) {
      void vscode.window.showInformationMessage(`${basename(resolved.relPath)} 还没有历史记录。`);
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      versions.map((v) => ({
        label: formatTimestamp(v.ts),
        description: [v.label, v.added > 0 ? `+${v.added}` : '', v.removed > 0 ? `-${v.removed}` : '']
          .filter(Boolean)
          .join('  '),
        detail: v.tags.join(', '),
        version: v,
      })),
      { title, placeHolder: '选择一个历史版本' },
    );
    return picked?.version;
  }

  // -------------------------------------------------------------- 命令

  const register = (id: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('localHistory.showHistory', async (arg) => {
    const resolved = await requireTarget(arg);
    if (!resolved) {
      return;
    }
    HistoryPanel.show(
      context,
      service,
      diff,
      restore,
      snapshots,
      resolved.folder,
      resolved.relPath,
    );
  });

  register('localHistory.showRecentChanges', async () => {
    await vscode.commands.executeCommand('localHistory.recentChanges.focus');
  });

  register('localHistory.takeSnapshot', async (arg) => {
    const resolved = await requireTarget(arg);
    if (!resolved) {
      return;
    }
    const label = await vscode.window.showInputBox({
      title: '创建快照',
      prompt: '给这个快照起个标签（可留空）',
    });
    if (label === undefined) {
      return;
    }
    const uri = service.fileUri(resolved.folder, resolved.relPath);
    const version = await snapshots.manualSnapshot(uri, label || undefined);
    void vscode.window.setStatusBarMessage(
      version
        ? `Local History: 已创建快照 ${formatTimestamp(version.ts)}`
        : 'Local History: 内容没有变化，未创建新版本',
      4000,
    );
  });

  register('localHistory.addLabel', async (arg) => {
    const resolved = await requireTarget(arg);
    if (!resolved) {
      return;
    }
    const version = resolved.version ?? (await pickVersion(resolved, '为哪个版本添加标签'));
    if (!version) {
      return;
    }
    const label = await vscode.window.showInputBox({
      title: '版本标签',
      value: version.label ?? '',
      prompt: '留空表示删除标签',
    });
    if (label === undefined) {
      return;
    }
    await resolved.store.setLabel(resolved.relPath, version.id, label || undefined);
    service.notifyChanged();
  });

  register('localHistory.labelVersion', (arg) =>
    vscode.commands.executeCommand('localHistory.addLabel', arg),
  );

  register('localHistory.openVersionDiff', async (arg) => {
    const resolved = await requireTarget(arg);
    if (!resolved) {
      return;
    }
    const version = resolved.version ?? (await pickVersion(resolved, '与当前版本对比'));
    if (version) {
      await diff.openAgainstCurrent(resolved.folder, resolved.relPath, version);
    }
  });

  register('localHistory.restoreVersion', async (arg) => {
    const resolved = await requireTarget(arg);
    if (!resolved) {
      return;
    }
    const version = resolved.version ?? (await pickVersion(resolved, '还原到哪个版本'));
    if (version) {
      await restore.restoreVersion(resolved.folder, resolved.relPath, version);
    }
  });

  register('localHistory.restoreHunks', async (arg) => {
    const resolved = await requireTarget(arg);
    if (!resolved) {
      return;
    }
    const version = resolved.version ?? (await pickVersion(resolved, '从哪个版本恢复片段'));
    if (version) {
      await restore.restoreHunks(resolved.folder, resolved.relPath, version);
    }
  });

  register('localHistory.restoreSelection', async () => {
    await restore.restoreSelection(vscode.window.activeTextEditor);
  });

  register('localHistory.exportVersion', async (arg) => {
    const resolved = await requireTarget(arg);
    if (!resolved) {
      return;
    }
    const version = resolved.version ?? (await pickVersion(resolved, '导出哪个版本'));
    if (version) {
      await restore.exportVersion(resolved.folder, resolved.relPath, version);
    }
  });

  register('localHistory.deleteVersion', async (arg) => {
    const resolved = await requireTarget(arg);
    if (!resolved?.version) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `删除 ${formatTimestamp(resolved.version.ts)} 的版本？该操作不可撤销。`,
      { modal: true },
      '删除',
    );
    if (ok === '删除') {
      await resolved.store.deleteVersion(resolved.relPath, resolved.version.id);
      service.notifyChanged();
    }
  });

  register('localHistory.restoreDeletedFile', async (arg) => {
    const resolved = await requireTarget(arg);
    if (!resolved) {
      return;
    }
    await restore.restoreDeletedFile(resolved.folder, resolved.relPath, resolved.version);
  });

  register('localHistory.clearHistory', async (arg) => {
    const resolved = await requireTarget(arg);
    if (!resolved) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `清除 ${basename(resolved.relPath)} 的全部历史记录？`,
      { modal: true, detail: '该操作不可撤销。' },
      '清除',
    );
    if (ok === '清除') {
      await resolved.store.clearFile(resolved.relPath);
      service.notifyChanged();
    }
  });

  register('localHistory.purgeAllHistory', async () => {
    const ok = await vscode.window.showWarningMessage(
      '清除当前窗口所有工作区文件夹的全部本地历史？',
      { modal: true, detail: '该操作不可撤销，历史数据将从磁盘删除。' },
      '全部清除',
    );
    if (ok !== '全部清除') {
      return;
    }
    for (const { store } of service.allTargets()) {
      await store.purgeAll();
    }
    service.notifyChanged();
    void vscode.window.showInformationMessage('Local History: 已清除全部历史。');
  });

  register('localHistory.runCleanup', async () => {
    let removed = 0;
    let freed = 0;
    for (const { folder, store } of service.allTargets()) {
      const plan = await store.cleanup(service.config(folder.uri).retention);
      removed += plan.remove.length;
      freed += plan.freedBytes;
    }
    service.notifyChanged();
    void vscode.window.showInformationMessage(
      `Local History: 清理了 ${removed} 个版本，释放 ${formatSize(freed)}。`,
    );
  });

  register('localHistory.showStorage', async () => {
    await StatsPanel.show(service);
  });

  register('localHistory.refreshViews', () => refreshViews());

  register('localHistory.rollbackToTime', async () => {
    const folders = service.allTargets();
    if (folders.length === 0) {
      return;
    }
    const chosenFolder =
      folders.length === 1
        ? folders[0]
        : await vscode.window
            .showQuickPick(
              folders.map((f) => ({ label: f.folder.name, value: f })),
              { title: '回滚哪个工作区文件夹' },
            )
            .then((p) => p?.value);
    if (!chosenFolder) {
      return;
    }
    const entries = await chosenFolder.store.listIndex();
    const stamps = [...new Set(entries.map((e) => e.lastTs))].sort((a, b) => b - a).slice(0, 100);
    if (stamps.length === 0) {
      void vscode.window.showInformationMessage('还没有可回滚的时间点。');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      stamps.map((ts) => ({
        label: formatTimestamp(ts),
        description: entries.find((e) => e.lastTs === ts)?.relPath,
        ts,
      })),
      { title: '把工作区回滚到哪个时间点', placeHolder: '将把所有有历史的文件还原到该时刻的状态' },
    );
    if (!picked) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `把 ${chosenFolder.folder.name} 回滚到 ${picked.label}？`,
      { modal: true, detail: '每个被修改的文件都会先保存一份当前状态的快照。' },
      '回滚',
    );
    if (ok !== '回滚') {
      return;
    }
    const result = await restore.rollbackWorkspaceTo(chosenFolder.folder, picked.ts);
    void vscode.window.showInformationMessage(
      `Local History: 已回滚 ${result.restored} 个文件，跳过 ${result.skipped} 个（在该时间点还没有历史）。`,
    );
  });

  register('localHistory.setEncryptionPassphrase', async () => {
    const passphrase = await vscode.window.showInputBox({
      title: '历史存储加密口令',
      password: true,
      prompt: '留空表示清除口令。口令保存在 VSCode SecretStorage 中，丢失后已加密的历史无法读取。',
    });
    if (passphrase === undefined) {
      return;
    }
    await service.setPassphrase(passphrase || undefined);
    void vscode.window.showInformationMessage(
      passphrase ? 'Local History: 加密口令已设置。' : 'Local History: 加密口令已清除。',
    );
  });

  // -------------------------------------------------------------- 定时清理

  const runCleanupQuietly = async () => {
    for (const { folder, store } of service.allTargets()) {
      try {
        await store.cleanup(service.config(folder.uri).retention);
      } catch (err) {
        console.error('[Local History] 清理失败', folder.name, err);
      }
    }
  };
  const startupCleanup = setTimeout(() => void runCleanupQuietly(), CLEANUP_DELAY_MS);
  const periodicCleanup = setInterval(() => void runCleanupQuietly(), CLEANUP_INTERVAL_MS);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearTimeout(startupCleanup);
      clearInterval(periodicCleanup);
    }),
  );

  if (service.config().encryptionEnabled && !service.encryptionReady) {
    const action = await vscode.window.showWarningMessage(
      'Local History: 已开启加密存储，但还没有设置口令，快照暂停中。',
      '设置口令',
    );
    if (action === '设置口令') {
      await vscode.commands.executeCommand('localHistory.setEncryptionPassphrase');
    }
  }
}

export async function deactivate(): Promise<void> {
  // 退出前把还在防抖窗口里的停顿快照写掉，避免最后一段编辑丢失
  await activeSnapshots?.flushPending();
  activeSnapshots = undefined;
}
