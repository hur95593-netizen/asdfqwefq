# 发布产物

| 版本 | 文件 | 大小 | SHA-256 |
| --- | --- | --- | --- |
| 1.0.0 | `vscode-local-history-1.0.0.vsix` | 60.3 KB | `3c054c3b7ef6c737d13d97851225f5d9597d61075c9fa1b96e126da14d470fc9` |

## 安装

命令行：

```bash
code --install-extension vscode-local-history-1.0.0.vsix
```

或者在 VSCode 里：扩展面板右上角 `···` → `Install from VSIX...` → 选择该文件。

卸载：

```bash
code --uninstall-extension hur95593.vscode-local-history
```

## 校验

```bash
shasum -a 256 vscode-local-history-1.0.0.vsix
```

## 重新构建

```bash
cd ..
npm install
npm test
npx @vscode/vsce package --no-dependencies --out release/vscode-local-history-<版本号>.vsix
```

包内只含运行时需要的文件（`out/src`、`media`、`resources`、`package.json`、`README`、`CHANGELOG`），
源码、测试、sourcemap 和本目录都由 `.vscodeignore` 排除在外。

## 提示

想试用但不想装进自己的 VSCode，在插件目录按 `F5` 启动「扩展开发宿主」即可 ——
它会开一个独立窗口临时加载插件，不写入扩展目录。
