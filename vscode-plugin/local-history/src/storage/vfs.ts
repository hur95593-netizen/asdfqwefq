/**
 * 存储层依赖的最小文件系统抽象。
 * 生产环境用 vscode.workspace.fs 实现（兼容 SSH / WSL / Dev Container），
 * 单元测试用内存实现，这样存储逻辑不需要真实磁盘也不需要 VSCode 运行时。
 */

export interface FileStat {
  size: number;
  mtime: number;
  isDirectory: boolean;
}

export interface Vfs {
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  delete(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** 返回目录内的条目名（不含路径）。目录不存在时返回空数组。 */
  list(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  stat(path: string): Promise<FileStat | undefined>;
  mkdirp(path: string): Promise<void>;
  rename(from: string, to: string, options?: { overwrite?: boolean }): Promise<void>;
}

const SEP = '/';

/** 存储层内部统一使用 `/` 拼接，适配器负责转换成平台路径。 */
export function joinPath(...parts: string[]): string {
  const joined = parts
    .filter((p) => p !== '')
    .join(SEP)
    .replace(/\/{2,}/g, SEP);
  return joined;
}

export class MemVfs implements Vfs {
  private files = new Map<string, Uint8Array>();
  private dirs = new Set<string>(['']);

  async read(path: string): Promise<Uint8Array> {
    const data = this.files.get(norm(path));
    if (!data) {
      throw new Error(`ENOENT: ${path}`);
    }
    return data;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const p = norm(path);
    await this.mkdirp(parent(p));
    this.files.set(p, data);
  }

  async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
    const p = norm(path);
    if (this.files.delete(p)) {
      return;
    }
    if (this.dirs.has(p)) {
      if (!options?.recursive) {
        throw new Error(`EISDIR: ${path}`);
      }
      for (const f of [...this.files.keys()]) {
        if (f.startsWith(p + SEP)) {
          this.files.delete(f);
        }
      }
      for (const d of [...this.dirs]) {
        if (d === p || d.startsWith(p + SEP)) {
          this.dirs.delete(d);
        }
      }
      return;
    }
    throw new Error(`ENOENT: ${path}`);
  }

  async list(path: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
    const p = norm(path);
    if (!this.dirs.has(p)) {
      return [];
    }
    const prefix = p === '' ? '' : p + SEP;
    const out = new Map<string, boolean>();
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        if (rest && !rest.includes(SEP)) {
          out.set(rest, false);
        }
      }
    }
    for (const d of this.dirs) {
      if (d.startsWith(prefix) && d !== p) {
        const rest = d.slice(prefix.length);
        if (rest && !rest.includes(SEP)) {
          out.set(rest, true);
        }
      }
    }
    return [...out].map(([name, isDirectory]) => ({ name, isDirectory }));
  }

  async stat(path: string): Promise<FileStat | undefined> {
    const p = norm(path);
    const data = this.files.get(p);
    if (data) {
      return { size: data.byteLength, mtime: 0, isDirectory: false };
    }
    if (this.dirs.has(p)) {
      return { size: 0, mtime: 0, isDirectory: true };
    }
    return undefined;
  }

  async mkdirp(path: string): Promise<void> {
    const p = norm(path);
    const absolute = p.startsWith(SEP);
    const parts = p.split(SEP).filter(Boolean);
    let cur = absolute ? '' : '';
    this.dirs.add('');
    for (const part of parts) {
      cur = cur === '' ? (absolute ? SEP + part : part) : cur + SEP + part;
      this.dirs.add(cur);
    }
  }

  async rename(from: string, to: string, options?: { overwrite?: boolean }): Promise<void> {
    const f = norm(from);
    const t = norm(to);
    const data = this.files.get(f);
    if (!data) {
      throw new Error(`ENOENT: ${from}`);
    }
    if (this.files.has(t) && !options?.overwrite) {
      throw new Error(`EEXIST: ${to}`);
    }
    this.files.delete(f);
    await this.write(t, data);
  }
}

function norm(p: string): string {
  return p.replace(/\\/g, SEP).replace(/\/{2,}/g, SEP).replace(/\/$/, '');
}

function parent(p: string): string {
  const i = p.lastIndexOf(SEP);
  return i <= 0 ? '' : p.slice(0, i);
}
