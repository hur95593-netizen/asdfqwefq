# Local History for VSCode

WebStorm「Local History」的 VSCode 实现：自动记录每一次有意义的文件修改，随时回溯、对比、还原。
不依赖 Git 或任何版本控制系统，数据全部存在本地。

对应需求文档：[`../vscode历史插件需求设计文档.md`](../vscode历史插件需求设计文档.md)

## 功能

### 自动快照

| 触发 | 说明 | 配置 |
| --- | --- | --- |
| 保存 | `onDidSaveTextDocument` | `localHistory.trigger.onSave` |
| 编辑停顿 | 停止输入 N 秒后记录未保存的内容 | `localHistory.trigger.onPause`、`localHistory.debounceSeconds` |
| 关闭标签页 | 关闭时记录一次 | `localHistory.trigger.onClose` |
| 外部变更 | 文件系统监听，捕获 VSCode 之外的修改 | `localHistory.trigger.onExternalChange` |
| 创建 / 删除 / 重命名 | 自动打 `Created` / `Deleted` 标签，重命名保留同一条时间轴 | — |
| 手动 | `Local History: 为当前文件创建快照`，可带标签 | — |

去噪规则：

- **空变更过滤** —— 内容哈希与上一版相同就不产生新版本；
- **防抖合并** —— `mergeWindowSeconds` 内的连续修改合并进同一个版本（带标签的版本不参与合并）；
- **大文件降频** —— 超过 `largeFileThresholdKB` 只在保存和手动时快照，超过 `maxFileSizeMB` 完全不记录；
- **二进制跳过** —— 内容里出现 NUL 字节的文件不进历史。

### 历史面板

`Ctrl+Shift+H`（macOS `Cmd+Shift+H`）打开。左侧是 Webview 时间轴，单击任意版本就在右边一栏拉起
**VSCode 原生 diff 编辑器**——并排视图、行内字符级高亮都由编辑器本身提供，风格与其它 diff 完全一致。

- 时间戳精确到秒，按今天 / 昨天 / 本周 / 本月 / 更早分组；
- 每条显示标签、触发来源、`+N / -N` 变更行数；
- 内容搜索、标签筛选、时间筛选；
- `Ctrl/Cmd + 单击` 选第二个版本，两个历史版本互相对比；
- `⇄` 切换对比方向；
- 右键：还原 / 片段恢复 / 标签 / 导出 / 删除该版本。

### 侧边栏

活动栏的 Local History 图标下有三个视图：

- **File History** —— 当前文件的时间轴；
- **Recent Changes** —— 整个工作区按时间分组的变更，支持「把工作区回滚到某个时间点」；
- **Deleted Files** —— 被删除文件的历史，可一键恢复到原路径。

### 恢复

- **全文件还原** —— 还原前自动把当前内容存为一个快照（`keepBackupBeforeRestore`），误操作可再还原回来；
- **片段级恢复** —— `选择要恢复的变更块`：列出该版本与当前内容的所有变更块，勾选其中几块单独恢复；
- **选区恢复** —— 在历史版本的编辑器里选中若干行，`Ctrl+Alt+R` 把这段内容写回当前文件的对应位置；
- **已删除文件恢复** —— 删除前的最后一版内容会被保留，恢复后历史链继续沿用；
- **时间点回滚** —— 把整个工作区文件夹回滚到某个时刻的状态，逐个文件都会先留备份快照。

### 存储

```
<工作区>/.local-history/
├── blobs/<hh>/<sha256>        # 内容 blob，gzip 压缩 + 按内容哈希去重
├── meta/<sha1(相对路径)>.json  # 单个文件的时间轴
└── index/files.json           # 文件索引（损坏时可从 meta 自动重建）
```

- 所有写入都是「先写临时文件再改名」，进程被杀不会留下半个文件；
- 索引或元数据损坏时自动重建 / 隔离，不会导致面板打不开；
- 存储目录在 git 仓库里会自动写入 `.gitignore`；
- 清理策略：保留天数 → 单文件版本数 → 总大小，三级依次生效；带标签的版本和每个文件的最新版本永不自动清理；
- 版本被清理后，引用计数归零的 blob 才真正从磁盘删除；
- `Local History: 存储统计与管理` 可以看到占用、压缩去重节省比例，以及手动触发清理。

### 加密（可选）

打开 `localHistory.encryption.enabled` 并执行 `Local History: 设置历史存储加密口令`，之后写入的 blob 会用
AES-256-GCM 加密（口令经 scrypt 派生，保存在 VSCode SecretStorage，不落工作区）。**口令丢失后已加密的历史无法恢复。**

## 命令

| 命令 | 快捷键 |
| --- | --- |
| Local History: 显示文件历史 | `Ctrl+Shift+H` / `Cmd+Shift+H` |
| Local History: 显示最近变更 | `Ctrl+Alt+Shift+H` / `Cmd+Alt+Shift+H` |
| Local History: 把选中的历史内容恢复到当前文件 | `Ctrl+Alt+R` / `Cmd+Alt+R`（在历史版本编辑器中） |
| Local History: 为当前文件创建快照 | — |
| Local History: 为最新版本添加标签 | — |
| Local History: 选择要恢复的变更块 | — |
| Local History: 将工作区回滚到某个时间点 | — |
| Local History: 存储统计与管理 | — |
| Local History: 立即执行清理 | — |
| Local History: 清除当前文件历史 / 清除全部历史 | — |

编辑器右键、编辑器标签右键、资源管理器右键都有 `Local History` 子菜单。

## 配置

见 VSCode 设置里的 `localHistory.*`，主要几项：

| 配置项 | 默认值 |
| --- | --- |
| `localHistory.maxVersionsPerFile` | 100 |
| `localHistory.maxAgeDays` | 30 |
| `localHistory.maxTotalSizeMB` | 500 |
| `localHistory.largeFileThresholdKB` | 1024 |
| `localHistory.debounceSeconds` | 3 |
| `localHistory.mergeWindowSeconds` | 5 |
| `localHistory.exclude` | `node_modules`、`dist`、`build`、`out`、`.git`、`*.log`、`*.tmp` |

排除规则、保留策略都支持工作区级覆盖。

## 开发

```bash
npm install
npm run compile     # 编译到 out/
npm test            # 编译 + 跑单元测试
npm run watch       # 增量编译
```

VSCode 里按 `F5` 启动「扩展开发宿主」调试。

存储层通过 `Vfs` 抽象隔离了文件系统，生产环境用 `vscode.workspace.fs`（因此在 SSH / WSL /
Dev Container 下同样工作），单元测试用内存实现，不需要真实磁盘也不需要 VSCode 运行时。
diff 是自己实现的 Myers 最短编辑脚本，没有任何运行时依赖。

## 与需求文档的差异

- **双栏布局**：Webview 内部无法嵌入 VSCode 原生 diff 编辑器。实现方式是 Webview 时间轴占一栏，
  原生 diff 开在旁边一栏，视觉效果与文档中的布局图一致，同时保留原生 diff 的全部能力。
- **片段级恢复的交互**：VSCode 的 diff 编辑器不提供自定义的「行首恢复箭头」扩展点，因此改为
  变更块多选（QuickPick）+ 选区恢复（`Ctrl+Alt+R`）两条路径，覆盖「单块恢复」和「选中多行批量恢复」两种场景。
- **「还原所选及之后的所有更改」**：对单个文件来说与「还原到此版本」等价，因此合并为一个命令；
  跨文件的版本由「将工作区回滚到某个时间点」提供。
