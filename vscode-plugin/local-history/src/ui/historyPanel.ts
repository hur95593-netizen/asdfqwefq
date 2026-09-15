import * as vscode from 'vscode';
import { HistoryService } from '../core/historyService';
import { SnapshotManager } from '../core/snapshotManager';
import { DiffService } from '../diff/diffService';
import { RestoreService } from '../restore/restoreService';
import { AutoTag, Version } from '../storage/types';
import { BUCKET_LABEL, bucketOf, formatClock, formatRelative, inTimeFilter } from '../util/time';

const TAG_TEXT: Record<AutoTag, string> = {
  created: 'Created',
  deleted: 'Deleted',
  saved: '保存',
  pause: '编辑停顿',
  external: '外部修改',
  closed: '关闭文件',
  manual: '手动快照',
  restore: '还原前备份',
  rename: '重命名',
};

interface PanelState {
  folderId?: string;
  relPath?: string;
  keyword: string;
  tag: string;
  time: string;
  reversed: boolean;
}

/**
 * 历史记录面板：左侧时间轴（本 Webview），右侧 diff 由 VSCode 原生 diff 编辑器承担，
 * 面板打开在当前编辑器分组，diff 开在旁边一栏，形成 WebStorm 的双栏观感。
 */
export class HistoryPanel {
  private static current?: HistoryPanel;

  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private state: PanelState = { keyword: '', tag: '', time: '', reversed: false };
  private searchHits?: Set<string>;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: HistoryService,
    private readonly diff: DiffService,
    private readonly restore: RestoreService,
    private readonly snapshots: SnapshotManager,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'localHistory.panel',
      'Local History',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'activity-bar.svg');
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => void this.onMessage(msg),
      null,
      this.disposables,
    );
    this.disposables.push(
      this.service.onDidChangeHistory(() => void this.refresh()),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const target = editor && this.service.resolve(editor.document.uri);
        if (target) {
          void this.setTarget(target.folder, target.relPath);
        }
      }),
    );
  }

  static show(
    context: vscode.ExtensionContext,
    service: HistoryService,
    diff: DiffService,
    restore: RestoreService,
    snapshots: SnapshotManager,
    folder: vscode.WorkspaceFolder,
    relPath: string,
  ): HistoryPanel {
    if (!HistoryPanel.current) {
      HistoryPanel.current = new HistoryPanel(context, service, diff, restore, snapshots);
    }
    const panel = HistoryPanel.current;
    panel.panel.reveal(panel.panel.viewColumn ?? vscode.ViewColumn.Active, false);
    void panel.setTarget(folder, relPath);
    return panel;
  }

  private dispose(): void {
    HistoryPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.panel.dispose();
  }

  private get folder(): vscode.WorkspaceFolder | undefined {
    return this.state.folderId ? this.service.folderById(this.state.folderId) : undefined;
  }

  async setTarget(folder: vscode.WorkspaceFolder, relPath: string): Promise<void> {
    if (this.state.folderId === folder.uri.toString() && this.state.relPath === relPath) {
      return;
    }
    this.state.folderId = folder.uri.toString();
    this.state.relPath = relPath;
    this.searchHits = undefined;
    this.panel.title = `Local History: ${relPath.split('/').pop()}`;
    await this.refresh();
  }

  // ---------------------------------------------------------------- 渲染

  private async refresh(): Promise<void> {
    const folder = this.folder;
    const relPath = this.state.relPath;
    if (!folder || !relPath) {
      await this.panel.webview.postMessage({
        type: 'data',
        versions: [],
        relPath: '',
        folderId: '',
        reversed: this.state.reversed,
        searching: false,
      });
      return;
    }
    const store = this.service.storeFor(folder);
    const all = await store.getVersions(relPath);
    const now = Date.now();

    const tagOptions = collectTagOptions(all);
    const filtered = all.filter((v) => {
      if (this.state.tag) {
        const matchesTag =
          this.state.tag === '__labeled__'
            ? !!v.label
            : v.tags.includes(this.state.tag as AutoTag) || v.label === this.state.tag;
        if (!matchesTag) {
          return false;
        }
      }
      if (!inTimeFilter(v.ts, this.state.time, now)) {
        return false;
      }
      if (this.searchHits && !this.searchHits.has(v.id)) {
        return false;
      }
      return true;
    });

    await this.panel.webview.postMessage({
      type: 'data',
      relPath,
      folderId: this.state.folderId,
      reversed: this.state.reversed,
      searching: !!this.state.keyword,
      keyword: this.state.keyword,
      tag: this.state.tag,
      tagOptions,
      versions: filtered.map((v) => ({
        id: v.id,
        time: formatClock(v.ts),
        relative: formatRelative(v.ts, now),
        group: BUCKET_LABEL[bucketOf(v.ts, now)],
        label: v.label,
        added: v.added,
        removed: v.removed,
        tags: v.tags.map((t) => ({ text: TAG_TEXT[t] ?? t, kind: t })),
      })),
    });
  }

  // ---------------------------------------------------------------- 消息

  private async onMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    const folder = this.folder;
    const relPath = this.state.relPath;

    if (msg.type === 'ready') {
      await this.refresh();
      return;
    }
    if (msg.type === 'settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'localHistory');
      return;
    }
    if (!folder || !relPath) {
      return;
    }
    const store = this.service.storeFor(folder);
    const uri = this.service.fileUri(folder, relPath);

    switch (msg.type) {
      case 'search': {
        this.state.keyword = String(msg.keyword ?? '');
        this.searchHits = this.state.keyword
          ? await store.searchContent(
              relPath,
              this.state.keyword,
              this.service.config(folder.uri).searchMaxVersions,
            )
          : undefined;
        await this.refresh();
        return;
      }
      case 'filter': {
        if (typeof msg.tag === 'string') {
          this.state.tag = msg.tag;
        }
        if (typeof msg.time === 'string') {
          this.state.time = msg.time;
        }
        await this.refresh();
        return;
      }
      case 'reverse': {
        this.state.reversed = !this.state.reversed;
        await this.refresh();
        return;
      }
      case 'snapshot': {
        const label = await vscode.window.showInputBox({
          title: '创建快照',
          prompt: '给这个快照起个标签（可留空）',
        });
        if (label === undefined) {
          return;
        }
        await this.snapshots.manualSnapshot(uri, label || undefined);
        await this.refresh();
        return;
      }
      case 'select': {
        const version = await this.version(store, relPath, msg.id);
        if (version) {
          await this.diff.openAgainstCurrent(folder, relPath, version, {
            reversed: this.state.reversed,
          });
        }
        return;
      }
      case 'compare': {
        const a = await this.version(store, relPath, msg.a);
        const b = await this.version(store, relPath, msg.b);
        if (a && b) {
          const [older, newer] = a.ts <= b.ts ? [a, b] : [b, a];
          await this.diff.openBetweenVersions(folder, relPath, older, newer);
        }
        return;
      }
      case 'restore': {
        const version = await this.version(store, relPath, msg.id);
        if (version) {
          await this.restore.restoreVersion(folder, relPath, version);
        }
        return;
      }
      case 'restoreHunks': {
        const version = await this.version(store, relPath, msg.id);
        if (version) {
          await this.restore.restoreHunks(folder, relPath, version);
        }
        return;
      }
      case 'label': {
        const version = await this.version(store, relPath, msg.id);
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
        await store.setLabel(relPath, version.id, label || undefined);
        this.service.notifyChanged(uri);
        return;
      }
      case 'export': {
        const version = await this.version(store, relPath, msg.id);
        if (version) {
          await this.restore.exportVersion(folder, relPath, version);
        }
        return;
      }
      case 'delete': {
        const version = await this.version(store, relPath, msg.id);
        if (!version) {
          return;
        }
        const ok = await vscode.window.showWarningMessage(
          '删除这个历史版本？该操作不可撤销。',
          { modal: true },
          '删除',
        );
        if (ok === '删除') {
          await store.deleteVersion(relPath, version.id);
          this.service.notifyChanged(uri);
        }
        return;
      }
      default:
        return;
    }
  }

  private async version(
    store: ReturnType<HistoryService['storeFor']>,
    relPath: string,
    id: unknown,
  ): Promise<Version | undefined> {
    return typeof id === 'string' ? store.getVersion(relPath, id) : undefined;
  }

  // ---------------------------------------------------------------- HTML

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.css'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.js'),
    );
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Local History</title>
</head>
<body>
  <div class="toolbar">
    <input id="search" type="search" placeholder="搜索历史内容…" />
    <select id="tagFilter" title="按标签筛选"><option value="">全部标签</option></select>
    <select id="timeFilter" title="按时间筛选">
      <option value="">全部时间</option>
      <option value="today">今天</option>
      <option value="yesterday">昨天</option>
      <option value="week">本周</option>
      <option value="month">本月</option>
    </select>
    <button id="reverse" title="切换对比方向">⇄</button>
    <button id="snapshot" class="primary" title="为当前文件创建快照">快照</button>
    <button id="settings" title="打开设置">⚙</button>
  </div>
  <div id="fileBar" class="file-bar"></div>
  <div id="timeline" class="timeline"></div>
  <div class="hint">单击查看 diff · Ctrl/Cmd + 单击选第二个版本互相对比 · 右键更多操作</div>
  <div id="menu" class="menu" hidden></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function collectTagOptions(versions: Version[]): Array<{ value: string; label: string }> {
  const tags = new Set<AutoTag>();
  let hasLabel = false;
  for (const v of versions) {
    for (const t of v.tags) {
      tags.add(t);
    }
    hasLabel = hasLabel || !!v.label;
  }
  const options: Array<{ value: string; label: string }> = [...tags].map((t) => ({
    value: t as string,
    label: TAG_TEXT[t] ?? t,
  }));
  if (hasLabel) {
    options.unshift({ value: '__labeled__', label: '带标签的版本' });
  }
  return options;
}

function randomNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
