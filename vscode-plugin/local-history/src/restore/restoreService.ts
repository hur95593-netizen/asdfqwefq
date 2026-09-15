import * as vscode from 'vscode';
import { HistoryService } from '../core/historyService';
import { SnapshotManager } from '../core/snapshotManager';
import { basename, fileExists } from '../diff/diffService';
import { parseVersionUri } from '../diff/contentProvider';
import { Version } from '../storage/types';
import { Hunk, applyHunks, mapRange, splitLines, toHunks } from '../util/diff';
import { formatTimestamp } from '../util/time';

/** 全文件还原、片段级还原、已删除文件恢复、工作区时间点回滚。 */
export class RestoreService {
  constructor(
    private readonly service: HistoryService,
    private readonly snapshots: SnapshotManager,
  ) {}

  // ---------------------------------------------------------------- 全文件

  async restoreVersion(
    folder: vscode.WorkspaceFolder,
    relPath: string,
    version: Version,
    options: { silent?: boolean } = {},
  ): Promise<boolean> {
    const cfg = this.service.config(folder.uri);
    if (!options.silent && cfg.confirmRestore) {
      const ok = await vscode.window.showWarningMessage(
        `将 ${basename(relPath)} 还原到 ${formatTimestamp(version.ts)} 的版本？`,
        { modal: true, detail: cfg.keepBackupBeforeRestore ? '当前内容会先被保存为一个快照。' : undefined },
        '还原',
      );
      if (ok !== '还原') {
        return false;
      }
    }
    const store = this.service.storeFor(folder);
    const content = await store.readContent(version);
    const uri = this.service.fileUri(folder, relPath);

    await this.backupCurrent(folder, relPath);
    await this.writeContent(uri, content);
    this.service.notifyChanged(uri);
    if (!options.silent) {
      await vscode.window.showTextDocument(uri, { preview: false });
      void vscode.window.setStatusBarMessage(
        `Local History: 已还原到 ${formatTimestamp(version.ts)}`,
        4000,
      );
    }
    return true;
  }

  // ---------------------------------------------------------------- 片段级

  /** 列出历史版本与当前内容之间的变更块，让用户勾选要恢复的部分。 */
  async restoreHunks(
    folder: vscode.WorkspaceFolder,
    relPath: string,
    version: Version,
  ): Promise<void> {
    const store = this.service.storeFor(folder);
    const historic = splitLines(await store.readContent(version));
    const uri = this.service.fileUri(folder, relPath);
    const currentText = await this.readCurrent(uri);
    if (currentText === undefined) {
      void vscode.window.showWarningMessage('当前文件不存在，请使用「还原到此版本」恢复整个文件。');
      return;
    }
    const current = splitLines(currentText);
    const hunks = toHunks(historic, current);
    if (hunks.length === 0) {
      void vscode.window.showInformationMessage('该版本与当前内容没有差异。');
      return;
    }

    const items = hunks.map((h, i) => ({
      label: `$(git-pull-request-go-to-changes) 变更块 ${i + 1}`,
      description: describeHunk(h),
      detail: previewHunk(h),
      hunk: h,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: `从 ${formatTimestamp(version.ts)} 的版本恢复片段`,
      placeHolder: '勾选要恢复到当前文件的变更块',
    });
    if (!picked || picked.length === 0) {
      return;
    }
    const merged = applyHunks(
      current,
      picked.map((p) => p.hunk),
    ).join('\n');
    await this.backupCurrent(folder, relPath);
    await this.writeContent(uri, endsWithNewline(currentText) ? merged + '\n' : merged);
    this.service.notifyChanged(uri);
    void vscode.window.setStatusBarMessage(
      `Local History: 已恢复 ${picked.length} 个变更块`,
      4000,
    );
  }

  /** 在历史版本的编辑器里选中若干行，直接把这段内容写回当前文件的对应位置。 */
  async restoreSelection(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor) {
      return;
    }
    const ref = parseVersionUri(editor.document.uri);
    if (!ref) {
      void vscode.window.showInformationMessage('请在历史版本的编辑器中选中要恢复的内容。');
      return;
    }
    const folder = this.service.folderById(ref.folderId);
    if (!folder) {
      return;
    }
    const store = this.service.storeFor(folder);
    const version = await store.getVersion(ref.relPath, ref.versionId);
    if (!version) {
      return;
    }
    const historic = splitLines(await store.readContent(version));
    const uri = this.service.fileUri(folder, ref.relPath);
    const currentText = await this.readCurrent(uri);
    if (currentText === undefined) {
      void vscode.window.showWarningMessage('当前文件不存在。');
      return;
    }
    const current = splitLines(currentText);
    const sel = editor.selection;
    const aFrom = sel.start.line;
    const aTo = sel.isEmpty || sel.end.character > 0 ? sel.end.line : Math.max(aFrom, sel.end.line - 1);
    const { bFrom, bTo } = mapRange(historic, current, aFrom, aTo);

    const replacement = historic.slice(aFrom, aTo + 1);
    const next = [...current.slice(0, bFrom), ...replacement, ...current.slice(bTo)].join('\n');
    await this.backupCurrent(folder, ref.relPath);
    await this.writeContent(uri, endsWithNewline(currentText) ? next + '\n' : next);
    this.service.notifyChanged(uri);
    void vscode.window.setStatusBarMessage(
      `Local History: 已恢复 ${replacement.length} 行到 ${basename(ref.relPath)}`,
      4000,
    );
  }

  // ---------------------------------------------------------------- 已删除文件

  async restoreDeletedFile(
    folder: vscode.WorkspaceFolder,
    relPath: string,
    version?: Version,
  ): Promise<void> {
    const store = this.service.storeFor(folder);
    const versions = await store.getVersions(relPath);
    // 删除标记版本的内容就是删除前的最后一版，直接用它
    const target = version ?? versions[0];
    if (!target) {
      void vscode.window.showWarningMessage('没有可用于恢复的历史版本。');
      return;
    }
    const content = await store.readContent(target);
    const uri = this.service.fileUri(folder, relPath);
    if (await fileExists(uri)) {
      const ok = await vscode.window.showWarningMessage(
        `${relPath} 已经存在，覆盖它？`,
        { modal: true },
        '覆盖',
      );
      if (ok !== '覆盖') {
        return;
      }
      await this.backupCurrent(folder, relPath);
    }
    await this.writeContent(uri, content);
    // 恢复后历史链继续沿用同一个 key，不丢时间轴
    await store.addVersion(relPath, content, { tags: ['restore'], mergeWindowMs: 0, forceNew: true });
    this.service.notifyChanged(uri);
    await vscode.window.showTextDocument(uri, { preview: false });
  }

  // ---------------------------------------------------------------- 时间点回滚

  /** 把工作区里所有有历史的文件回滚到指定时间点的状态。 */
  async rollbackWorkspaceTo(
    folder: vscode.WorkspaceFolder,
    ts: number,
  ): Promise<{ restored: number; skipped: number }> {
    const store = this.service.storeFor(folder);
    const entries = await store.listIndex();
    let restored = 0;
    let skipped = 0;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在回滚工作区…' },
      async (progress) => {
        let done = 0;
        for (const entry of entries) {
          done++;
          progress.report({
            message: `${done}/${entries.length} ${entry.relPath}`,
            increment: 100 / Math.max(1, entries.length),
          });
          const history = await store.getHistoryByKey(entry.key);
          if (!history) {
            continue;
          }
          const candidates = history.versions.filter((v) => v.ts <= ts);
          const version = candidates[candidates.length - 1];
          if (!version) {
            skipped++;
            continue;
          }
          const uri = this.service.fileUri(folder, entry.relPath);
          const content = await store.readContent(version).catch(() => undefined);
          if (content === undefined) {
            skipped++;
            continue;
          }
          if (version.isDeletion) {
            if (await fileExists(uri)) {
              await this.backupCurrent(folder, entry.relPath);
              await vscode.workspace.fs.delete(uri, { useTrash: true });
              restored++;
            }
            continue;
          }
          const currentText = await this.readCurrent(uri);
          if (currentText === content) {
            continue;
          }
          await this.backupCurrent(folder, entry.relPath);
          await this.writeContent(uri, content);
          restored++;
        }
      },
    );
    this.service.notifyChanged();
    return { restored, skipped };
  }

  // ---------------------------------------------------------------- 导出

  async exportVersion(
    folder: vscode.WorkspaceFolder,
    relPath: string,
    version: Version,
  ): Promise<void> {
    const store = this.service.storeFor(folder);
    const content = await store.readContent(version);
    const stamp = formatTimestamp(version.ts).replace(/[: ]/g, '-');
    const name = basename(relPath);
    const dot = name.lastIndexOf('.');
    const suggested =
      dot > 0 ? `${name.slice(0, dot)}.${stamp}${name.slice(dot)}` : `${name}.${stamp}`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: this.service.fileUri(folder, relPath).with({
        path: this.service.fileUri(folder, relPath).path.replace(/[^/]+$/, suggested),
      }),
      saveLabel: '导出此版本',
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    void vscode.window.setStatusBarMessage(`Local History: 已导出到 ${target.fsPath}`, 4000);
  }

  // ---------------------------------------------------------------- 内部

  /** 还原前先把当前内容存成一个快照，避免误操作丢失。 */
  private async backupCurrent(folder: vscode.WorkspaceFolder, relPath: string): Promise<void> {
    if (!this.service.config(folder.uri).keepBackupBeforeRestore) {
      return;
    }
    const uri = this.service.fileUri(folder, relPath);
    const content = await this.readCurrent(uri);
    if (content === undefined) {
      return;
    }
    await this.snapshots.snapshot(uri, content, ['restore'], { forceNew: true });
  }

  private async readCurrent(uri: vscode.Uri): Promise<string | undefined> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) {
      return doc.getText();
    }
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private async writeContent(uri: vscode.Uri, content: string): Promise<void> {
    this.snapshots.suppress(uri);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
      return;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }
}

function describeHunk(h: Hunk): string {
  const parts: string[] = [];
  if (h.aLines.length > 0) {
    parts.push(`+${h.aLines.length}`);
  }
  if (h.bLines.length > 0) {
    parts.push(`-${h.bLines.length}`);
  }
  return `当前文件第 ${h.bStart + 1} 行 · ${parts.join(' ') || '无变化'}`;
}

function previewHunk(h: Hunk): string {
  const from = h.aLines.slice(0, 2).map((l) => `+ ${l.trim()}`);
  const to = h.bLines.slice(0, 2).map((l) => `- ${l.trim()}`);
  return [...from, ...to].join('  ').slice(0, 160) || '(空行变更)';
}

function endsWithNewline(text: string): boolean {
  return text.endsWith('\n') || text.endsWith('\r\n');
}
