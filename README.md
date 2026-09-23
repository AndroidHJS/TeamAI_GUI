# TeamAI Sync GUI

一个面向 Windows 的 Electron + React + TypeScript 桌面同步台。界面负责目录、参数、任务状态与实时日志；实际 Git 同步全部由腾讯开源的 [`teamai-cli`](https://github.com/Tencent/teamai-cli) 完成。

## 功能

- 检查 Node.js、Git、TeamAI CLI 的版本和可用性。
- 选择并记住最近使用的工作目录，不保存 Token 或 Git 凭据。
- 支持 `teamai init`、`status`、`pull` 和经确认后的 `push --all`。
- stdout/stderr 实时逐行显示，安全解析 ANSI SGR 颜色，不注入 HTML。
- 同一时间只运行一个任务，支持取消；Windows 直接调用 `taskkill.exe /T` 终止完整子进程树。
- Electron 主进程不通过 PowerShell、CMD 或 shell 字符串执行 TeamAI。

## 前置条件

开发、运行或打包需要：

- Node.js 20 或更高版本
- npm
- Git
- TeamAI CLI 0.19.0 或更高版本：`npm install -g teamai-cli`

不再需要 Rust、Cargo、MSVC Rust 工具链或单独安装 WebView2。应用不会自动安装系统依赖，也不会代替用户完成 GitHub、GitLab、TGit 等平台认证。

> Windows v1 只保证识别标准 `npm install -g teamai-cli` 全局安装布局。为了避免执行 `.cmd`，主进程校验 `teamai-cli/package.json` 的 bin 入口后，直接运行系统 `node.exe <entry.js>`。

## 开发

```powershell
npm install
npm run dev
```

## 测试与构建

```powershell
npm test
npm run build
```

`npm run build` 会完成 TypeScript 检查，并分别构建 Electron 主进程、受限 preload 和 React renderer。

建议在含中文与空格的临时 Git 仓库中进行人工验证：

1. 未初始化目录的 `status` 能显示“未初始化”并保留原始日志。
2. 使用测试团队仓库完成 `init` 与 `pull`。
3. 创建本地测试资源，确认弹窗后再执行 `push --all`。
4. 在耗时任务中点击取消，确认 Node 与 Git 子进程均被终止。

## 生成 Windows 安装包

```powershell
npm run dist
```

NSIS 安装包输出到 `release/`。最终用户仍需安装 Node.js、Git 与 `teamai-cli`，但不需要 Rust/Cargo。

## 安全边界

- Renderer 开启 `contextIsolation`、`sandbox`，关闭 `nodeIntegration`，只能使用 preload 暴露的固定方法。
- 主进程仅允许 `init/status/pull/push` 四种操作，参数使用独立 argv 且 `shell: false`。
- 仓库地址、角色、Agent、目录及与操作不匹配的选项均在主进程重新校验。
- TeamAI 子进程 stdin 固定为空；不实现嵌入式终端或交互提示。
- 成功仅由退出码 `0` 判定；错误关键字只用于友好提示，原始日志始终保留。
- 外部导航默认拒绝；仅 HTTPS 新窗口请求交由系统浏览器处理。

