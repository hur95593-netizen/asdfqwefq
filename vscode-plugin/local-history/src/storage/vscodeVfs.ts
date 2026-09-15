import * as vscode from 'vscode';
import { FileStat, Vfs } from './vfs';

/**
 * 基于 vscode.workspace.fs 的实现。
 * 所有路径都是 Uri.path 形式（`/` 分隔），通过 base.with({ path }) 还原成完整 Uri，
 * 这样在 SSH / WSL / Dev Container 等非 file 协议的工作区里也能正常工作。
 */
export class VscodeVfs implements Vfs {
  constructor(private readonly base: vscode.Uri) {}

  private uri(path: string): vscode.Uri {
    return this.base.with({ path, query: '', fragment: '' });
  }

  async read(path: string): Promise<Uint8Array> {
    return vscode.workspace.fs.readFile(this.uri(path));
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    await vscode.workspace.fs.writeFile(this.uri(path), data);
  }

  async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
    await vscode.workspace.fs.delete(this.uri(path), {
      recursive: options?.recursive ?? false,
      useTrash: false,
    });
  }

  async list(path: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.uri(path));
      return entries.map(([name, type]) => ({
        name,
        isDirectory: type === vscode.FileType.Directory,
      }));
    } catch {
      return [];
    }
  }

  async stat(path: string): Promise<FileStat | undefined> {
    try {
      const s = await vscode.workspace.fs.stat(this.uri(path));
      return {
        size: s.size,
        mtime: s.mtime,
        isDirectory: s.type === vscode.FileType.Directory,
      };
    } catch {
      return undefined;
    }
  }

  async mkdirp(path: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.uri(path));
  }

  async rename(from: string, to: string, options?: { overwrite?: boolean }): Promise<void> {
    await vscode.workspace.fs.rename(this.uri(from), this.uri(to), {
      overwrite: options?.overwrite ?? false,
    });
  }
}
