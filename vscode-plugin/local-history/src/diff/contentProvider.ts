import * as vscode from 'vscode';
import { HistoryService } from '../core/historyService';
import { Version } from '../storage/types';

export const SCHEME = 'local-history';

export interface VersionRef {
  folderId: string;
  relPath: string;
  versionId: string;
}

/** 构造一个指向历史版本的只读 Uri；path 保留原始文件名，diff 标题和语法高亮才正常。 */
export function versionUri(
  folder: vscode.WorkspaceFolder,
  relPath: string,
  version: Version,
): vscode.Uri {
  const query = new URLSearchParams({
    folder: folder.uri.toString(),
    rel: relPath,
    v: version.id,
    ts: String(version.ts),
  }).toString();
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + relPath, query });
}

export function parseVersionUri(uri: vscode.Uri): VersionRef | undefined {
  if (uri.scheme !== SCHEME) {
    return undefined;
  }
  const params = new URLSearchParams(uri.query);
  const folderId = params.get('folder');
  const relPath = params.get('rel');
  const versionId = params.get('v');
  if (!folderId || !relPath || !versionId) {
    return undefined;
  }
  return { folderId, relPath, versionId };
}

/** 把历史版本内容以只读文档的形式提供给 VSCode 原生 diff 编辑器。 */
export class HistoryContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly service: HistoryService) {}

  dispose(): void {
    this.emitter.dispose();
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = parseVersionUri(uri);
    if (!ref) {
      return '';
    }
    const folder = this.service.folderById(ref.folderId);
    if (!folder) {
      return '// 对应的工作区文件夹已不在当前窗口中';
    }
    const store = this.service.storeFor(folder);
    const version = await store.getVersion(ref.relPath, ref.versionId);
    if (!version) {
      return '// 该历史版本已被清理';
    }
    try {
      return await store.readContent(version);
    } catch (err) {
      return `// 无法读取历史内容：${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
