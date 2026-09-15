import * as vscode from 'vscode';
import { HistoryService } from '../core/historyService';
import { StorageStats } from '../storage/types';
import { formatSize, formatTimestamp } from '../util/time';

/** 存储统计与管理界面。 */
export class StatsPanel {
  private static current?: vscode.WebviewPanel;

  static async show(service: HistoryService): Promise<void> {
    if (!StatsPanel.current) {
      const panel = vscode.window.createWebviewPanel(
        'localHistory.stats',
        'Local History 存储',
        vscode.ViewColumn.Active,
        { enableScripts: true },
      );
      panel.onDidDispose(() => (StatsPanel.current = undefined));
      panel.webview.onDidReceiveMessage(async (msg: { type: string }) => {
        if (msg.type === 'cleanup') {
          await vscode.commands.executeCommand('localHistory.runCleanup');
          await StatsPanel.render(service);
        } else if (msg.type === 'purge') {
          await vscode.commands.executeCommand('localHistory.purgeAllHistory');
          await StatsPanel.render(service);
        } else if (msg.type === 'refresh') {
          await StatsPanel.render(service);
        }
      });
      StatsPanel.current = panel;
    }
    StatsPanel.current.reveal();
    await StatsPanel.render(service);
  }

  private static async render(service: HistoryService): Promise<void> {
    const panel = StatsPanel.current;
    if (!panel) {
      return;
    }
    const sections: string[] = [];
    for (const { folder, store } of service.allTargets()) {
      const stats = await store.stats();
      sections.push(renderFolder(folder.name, stats, service.config(folder.uri).retention));
    }
    panel.webview.html = wrap(
      sections.join('\n') || '<p class="muted">当前窗口没有打开任何工作区文件夹。</p>',
    );
  }
}

function renderFolder(
  name: string,
  stats: StorageStats,
  retention: { maxVersionsPerFile: number; maxAgeDays: number; maxTotalSizeMB: number },
): string {
  const limit = retention.maxTotalSizeMB * 1024 * 1024;
  const ratio = limit > 0 ? Math.min(100, Math.round((stats.diskBytes / limit) * 100)) : 0;
  const saved =
    stats.logicalBytes > 0
      ? Math.max(0, Math.round((1 - stats.diskBytes / stats.logicalBytes) * 100))
      : 0;
  const rows = stats.topFiles
    .map(
      (f) =>
        `<tr><td class="path">${escapeHtml(f.relPath)}</td><td>${f.versions}</td><td>${formatSize(
          f.bytes,
        )}</td></tr>`,
    )
    .join('');

  return `
<section>
  <h2>${escapeHtml(name)}</h2>
  <div class="cards">
    <div class="card"><span class="num">${stats.files}</span><span class="cap">个文件</span></div>
    <div class="card"><span class="num">${stats.versions}</span><span class="cap">个版本</span></div>
    <div class="card"><span class="num">${formatSize(stats.diskBytes)}</span><span class="cap">磁盘占用</span></div>
    <div class="card"><span class="num">${saved}%</span><span class="cap">压缩去重节省</span></div>
  </div>
  ${
    limit > 0
      ? `<div class="bar"><div class="fill" style="width:${ratio}%"></div></div>
         <p class="muted">已用 ${formatSize(stats.diskBytes)} / 上限 ${retention.maxTotalSizeMB} MB · 单文件保留 ${
           retention.maxVersionsPerFile
         } 个版本 · 保留 ${retention.maxAgeDays} 天</p>`
      : '<p class="muted">未设置总大小上限。</p>'
  }
  ${
    stats.versions > 0
      ? `<p class="muted">时间跨度：${formatTimestamp(stats.oldestTs)} → ${formatTimestamp(
          stats.newestTs,
        )}</p>`
      : ''
  }
  ${
    rows
      ? `<table><thead><tr><th>文件</th><th>版本数</th><th>占用</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="muted">还没有历史数据。</p>'
  }
</section>`;
}

function wrap(body: string): string {
  const nonce = Math.random().toString(36).slice(2);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px 20px; }
  h2 { font-size: 1.05em; margin: 20px 0 10px; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 8px; }
  button { padding: 5px 12px; border: none; border-radius: 2px; cursor: pointer;
           color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .cards { display: flex; gap: 10px; flex-wrap: wrap; }
  .card { flex: 1 1 120px; padding: 10px 12px; border-radius: 4px;
          background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
  .num { display: block; font-size: 1.4em; font-weight: 600; font-variant-numeric: tabular-nums; }
  .cap { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .bar { height: 6px; margin: 12px 0 6px; border-radius: 3px; overflow: hidden;
         background: var(--vscode-editorWidget-background); }
  .fill { height: 100%; background: var(--vscode-charts-blue, #3794ff); }
  .muted { color: var(--vscode-descriptionForeground); font-size: 0.88em; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.9em; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  td:not(.path), th:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; width: 90px; }
  .path { word-break: break-all; }
</style>
</head>
<body>
  <div class="toolbar">
    <button id="cleanup">按策略清理</button>
    <button id="refresh" class="secondary">刷新</button>
    <button id="purge" class="secondary">清空全部历史</button>
  </div>
  ${body}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('cleanup').addEventListener('click', () => vscode.postMessage({ type: 'cleanup' }));
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('purge').addEventListener('click', () => vscode.postMessage({ type: 'purge' }));
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
