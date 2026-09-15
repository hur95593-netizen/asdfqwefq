import * as vscode from 'vscode';
import { HistoryService } from '../core/historyService';
import { Version } from '../storage/types';
import { formatTimestamp } from '../util/time';
import { versionUri } from './contentProvider';

export interface OpenDiffOptions {
  /** 对比方向：历史在左（默认）或历史在右 */
  reversed?: boolean;
  /** 打开在哪个编辑器分组，默认为旁边一栏 */
  viewColumn?: vscode.ViewColumn;
  preview?: boolean;
}

/** 复用 VSCode 原生 diff 编辑器：并排视图、行内差异高亮都由编辑器本身提供。 */
export class DiffService {
  constructor(private readonly service: HistoryService) {}

  /** 历史版本 ↔ 当前文件 */
  async openAgainstCurrent(
    folder: vscode.WorkspaceFolder,
    relPath: string,
    version: Version,
    options: OpenDiffOptions = {},
  ): Promise<void> {
    const left = versionUri(folder, relPath, version);
    const right = this.service.fileUri(folder, relPath);
    const exists = await fileExists(right);
    if (!exists) {
      // 文件已被删除，只能预览历史内容
      await vscode.window.showTextDocument(left, {
        preview: options.preview ?? true,
        viewColumn: options.viewColumn ?? vscode.ViewColumn.Beside,
      });
      return;
    }
    const name = basename(relPath);
    const title = `${name} (${formatTimestamp(version.ts)}) ↔ 当前`;
    await this.showDiff(
      options.reversed ? right : left,
      options.reversed ? left : right,
      options.reversed ? `${name} 当前 ↔ (${formatTimestamp(version.ts)})` : title,
      options,
    );
  }

  /** 任意两个历史版本对比 */
  async openBetweenVersions(
    folder: vscode.WorkspaceFolder,
    relPath: string,
    older: Version,
    newer: Version,
    options: OpenDiffOptions = {},
  ): Promise<void> {
    const name = basename(relPath);
    await this.showDiff(
      versionUri(folder, relPath, older),
      versionUri(folder, relPath, newer),
      `${name} (${formatTimestamp(older.ts)}) ↔ (${formatTimestamp(newer.ts)})`,
      options,
    );
  }

  private async showDiff(
    left: vscode.Uri,
    right: vscode.Uri,
    title: string,
    options: OpenDiffOptions,
  ): Promise<void> {
    await vscode.commands.executeCommand('vscode.diff', left, right, title, {
      preview: options.preview ?? true,
      viewColumn: options.viewColumn ?? vscode.ViewColumn.Beside,
      preserveFocus: true,
    } satisfies vscode.TextDocumentShowOptions);
  }
}

export function basename(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? relPath : relPath.slice(i + 1);
}

export function dirname(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
}

export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
