import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import Store from "electron-store";
import * as semver from "semver";
import type {
  CancelAck,
  CompletedEvent,
  DependencyStatus,
  EnvironmentReport,
  LogEvent,
  StartTaskResponse,
  Stream,
  TaskError,
} from "../src/types";
import { CredentialManager } from "./credentials";
import { redactSecrets } from "./redaction";
import { createPasswordBroker, runSshAuxiliaryMode, type PasswordBroker } from "./ssh-auth";
import { ApiError, canonicalizeDirectory, parseSshRepository, validateAndBuildRequest, type SshEndpoint } from "./validation";

interface SettingsSchema {
  recentWorkingDirectory: string;
  sshCredentials: Record<string, string>;
  workspaceCredentialBindings: Record<string, string>;
}

interface ExecutableSpec {
  program: string;
  prefixArgs: string[];
  displayPath: string;
}

interface ActiveTask {
  id: string;
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
  cancelRequested: boolean;
  passwordBroker?: PasswordBroker;
}

let store: Store<SettingsSchema>;
let credentialManager: CredentialManager;
let mainWindow: BrowserWindow | null = null;
let activeTask: ActiveTask | null = null;
let lastCancelledTaskId: string | null = null;
let closing = false;
const currentDirectory = dirname(fileURLToPath(import.meta.url));

function diagnosticLog(message: string) {
  const directory = process.env.TEAMAI_E2E_USER_DATA;
  if (!directory) return;
  try {
    appendFileSync(join(resolve(directory), "e2e.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Diagnostics must never affect normal startup.
  }
}

function errorForIpc(error: unknown) {
  const value = error instanceof ApiError ? error : new ApiError("internal", error instanceof Error ? error.message : String(error));
  const wrapped = new Error(value.message);
  wrapped.name = value.kind;
  return wrapped;
}

function findExactOnPath(fileName: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory.replace(/^"|"$/g, ""), fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findProgram(name: string): string | null {
  const candidates = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const candidate of candidates) {
    const found = findExactOnPath(candidate);
    if (found) return found;
  }
  return null;
}

function resolveNode(): string {
  const value = findProgram("node");
  if (!value || (process.platform === "win32" && !value.toLowerCase().endsWith(".exe"))) throw new ApiError("nodeNotFound", "未在 PATH 中找到 node.exe。");
  return value;
}

function resolveGit(): string {
  const value = findProgram("git");
  if (!value) throw new ApiError("gitNotFound", "未在 PATH 中找到 Git。");
  return value;
}

function resolveSsh(): string {
  const value = findProgram("ssh");
  if (!value || (process.platform === "win32" && !value.toLowerCase().endsWith(".exe"))) {
    throw new ApiError("sshNotFound", "未在 PATH 中找到 OpenSSH ssh.exe 客户端。");
  }
  return value;
}

function safePackageEntry(packageRoot: string, relativeEntry: string): string {
  if (!relativeEntry || isAbsolute(relativeEntry)) throw new ApiError("teamaiInvalid", "TeamAI bin 入口无效。");
  const canonicalRoot = realpathSync.native(packageRoot);
  const canonicalEntry = realpathSync.native(resolve(packageRoot, relativeEntry));
  const pathFromRoot = relative(canonicalRoot, canonicalEntry);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot) || !statSync(canonicalEntry).isFile()) {
    throw new ApiError("teamaiInvalid", "TeamAI bin 入口越出了已校验的 npm 包目录。");
  }
  return canonicalEntry;
}

function resolveTeamAi(node: string): ExecutableSpec {
  if (process.platform !== "win32") {
    const executable = findProgram("teamai");
    if (!executable) throw new ApiError("teamaiNotFound", "未在 PATH 中找到 teamai。");
    return { program: executable, prefixArgs: [], displayPath: executable };
  }
  const shim = findExactOnPath("teamai.cmd");
  if (!shim) throw new ApiError("teamaiNotFound", "未找到 teamai.cmd，请运行 npm install -g teamai-cli。");
  const packageRoot = join(dirname(shim), "node_modules", "teamai-cli");
  const manifestPath = join(packageRoot, "package.json");
  let manifest: { name?: string; bin?: string | Record<string, string> };
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { throw new ApiError("teamaiInvalid", "TeamAI 不是标准 npm 全局安装；请运行 npm install -g teamai-cli。"); }
  if (manifest.name !== "teamai-cli") throw new ApiError("teamaiInvalid", "检测到的 npm 包不是 teamai-cli。");
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.teamai;
  if (!entry) throw new ApiError("teamaiInvalid", "teamai-cli 未声明 teamai bin 入口。");
  const verifiedEntry = safePackageEntry(packageRoot, entry);
  return { program: node, prefixArgs: [verifiedEntry], displayPath: verifiedEntry };
}

function collectProcess(program: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new ApiError("versionTimeout", "版本检查超时。")); }, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(new ApiError("versionFailed", `无法启动版本检查：${error.message}`)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise((stdout.trim() || stderr.trim()));
      else reject(new ApiError("versionFailed", stderr.trim() || `版本命令退出码：${code}`));
    });
  });
}

function missingStatus(name: string, error: unknown): DependencyStatus {
  return { name, available: false, compatible: false, version: null, path: null, message: error instanceof Error ? error.message : String(error) };
}

async function dependencyStatus(name: string, path: string, program: string, args: string[], minimum?: string): Promise<DependencyStatus> {
  try {
    const version = await collectProcess(program, args);
    const parsed = semver.coerce(version);
    const compatible = minimum ? Boolean(parsed && semver.gte(parsed, minimum)) : true;
    return { name, available: true, compatible, version, path, message: compatible ? "可用" : `版本过低，需要 >=${minimum}` };
  } catch (error) { return missingStatus(name, error); }
}

async function checkEnvironment(): Promise<EnvironmentReport> {
  let nodePath: string | null = null;
  let gitPath: string | null = null;
  try { nodePath = resolveNode(); } catch { /* reported below */ }
  try { gitPath = resolveGit(); } catch { /* reported below */ }
  const node = nodePath ? await dependencyStatus("Node.js", nodePath, nodePath, ["--version"], "20.0.0") : missingStatus("Node.js", new Error("未在 PATH 中找到 Node.js。"));
  const git = gitPath ? await dependencyStatus("Git", gitPath, gitPath, ["--version"]) : missingStatus("Git", new Error("未在 PATH 中找到 Git。"));
  let teamai: DependencyStatus;
  try {
    if (!nodePath) throw new ApiError("nodeNotFound", "需要先安装 Node.js。");
    const executable = resolveTeamAi(nodePath);
    teamai = await dependencyStatus("TeamAI CLI", executable.displayPath, executable.program, [...executable.prefixArgs, "--version"], "0.19.0");
  } catch (error) { teamai = missingStatus("TeamAI CLI", error); }
  return { ready: node.compatible && git.compatible && teamai.compatible, checkedAt: new Date().toISOString(), node, git, teamai };
}

function classifyError(output: string): TaskError {
  const lower = output.toLowerCase();
  if (lower.includes("not initialized") || lower.includes("run teamai init") || lower.includes("尚未初始化")) return { kind: "notInitialized", message: "当前目录尚未初始化 TeamAI。" };
  if (["remote host identification has changed", "host key verification failed"].some((value) => lower.includes(value))) return { kind: "hostKeyChanged", message: "SSH 主机密钥校验失败；服务器指纹可能已发生变化。为保护连接，应用不会自动覆盖已记录的密钥。" };
  if (["authentication failed", "permission denied", "not authenticated", "unauthorized", "too many authentication failures"].some((value) => lower.includes(value))) return { kind: "authentication", message: "SSH 认证失败，请检查用户名、密码及服务器授权。" };
  if (["could not resolve host", "network", "timed out", "connection refused"].some((value) => lower.includes(value))) return { kind: "network", message: "网络连接失败，请检查网络、代理和仓库地址。" };
  if (lower.includes("conflict")) return { kind: "conflict", message: "检测到 Git 冲突，请查看原始日志并手动处理。" };
  return { kind: "processFailed", message: "TeamAI 命令执行失败，请查看原始日志。" };
}

function emit(channel: "teamai:log" | "teamai:completed", payload: LogEvent | CompletedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function streamLines(taskId: string, stream: Stream, source: NodeJS.ReadableStream, onText: (value: string) => void, nextSequence: () => number, secrets: readonly string[]) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const flush = (final: boolean) => {
    const parts = pending.split(/\r?\n/);
    const tail = parts.pop() ?? "";
    pending = final ? "" : tail;
    for (const line of parts) {
      const safeLine = redactSecrets(line, secrets);
      onText(`${safeLine}\n`);
      emit("teamai:log", { taskId, stream, line: safeLine, timestamp: new Date().toISOString(), sequence: nextSequence() });
    }
    if (final && tail) {
      const safeTail = redactSecrets(tail, secrets);
      onText(safeTail);
      emit("teamai:log", { taskId, stream, line: safeTail, timestamp: new Date().toISOString(), sequence: nextSequence() });
    }
  };
  source.on("data", (chunk: Buffer) => { pending += decoder.write(chunk); flush(false); });
  source.on("end", () => { pending += decoder.end(); flush(true); });
}

async function killProcessTree(task: ActiveTask): Promise<void> {
  if (task.child.exitCode !== null || task.child.pid === undefined) return;
  if (process.platform === "win32") {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    await new Promise<void>((resolvePromise) => {
      const killer = spawn(taskkill, ["/PID", String(task.child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
      const timer = setTimeout(() => { killer.kill(); task.child.kill(); resolvePromise(); }, 2500);
      killer.once("error", () => { clearTimeout(timer); task.child.kill(); resolvePromise(); });
      killer.once("close", () => { clearTimeout(timer); resolvePromise(); });
    });
  } else {
    try { process.kill(-task.child.pid, "SIGTERM"); } catch { task.child.kill("SIGTERM"); }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    if (task.child.exitCode === null) { try { process.kill(-task.child.pid, "SIGKILL"); } catch { task.child.kill("SIGKILL"); } }
  }
}

async function runTeamAi(rawRequest: unknown): Promise<StartTaskResponse> {
  if (activeTask) throw new ApiError("taskAlreadyRunning", "已有 TeamAI 任务正在运行。");
  const { args, workingDirectory, operation, authentication, sshEndpoint } = validateAndBuildRequest(rawRequest);
  const node = resolveNode();
  const executable = resolveTeamAi(node);
  let password: string | null = null;
  let credentialEndpoint: SshEndpoint | undefined = sshEndpoint;
  if (operation === "init" && credentialEndpoint) {
    password = credentialManager.resolveForInit(credentialEndpoint, authentication?.password);
    if (authentication && !password) throw new ApiError("sshPasswordMissing", "请输入 SSH 密码，或先保存该 SSH 端点的凭据。");
    if (authentication?.remember && authentication.password && !safeStorage.isEncryptionAvailable()) {
      throw new ApiError("secureStorageUnavailable", "当前系统安全存储不可用，无法记住 SSH 密码。");
    }
  } else if (operation !== "init") {
    password = credentialManager.resolveForWorkspace(workingDirectory);
  }
  let passwordBroker: PasswordBroker | undefined;
  if (password) passwordBroker = await createPasswordBroker(password, app.getPath("userData"), resolveSsh());
  const taskId = randomUUID();
  const startedAt = Date.now();
  const child = spawn(executable.program, [...executable.prefixArgs, ...args], {
    cwd: workingDirectory,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: passwordBroker ? { ...process.env, ...passwordBroker.environment } : process.env,
  });
  const task: ActiveTask = { id: taskId, child, cancelled: false, cancelRequested: false, passwordBroker };
  activeTask = task;
  let spawned = false;
  let sequence = 0;
  let captured = "";
  const capture = (value: string) => { if (captured.length < 256 * 1024) captured += value; };
  const nextSequence = () => sequence++;
  const secrets = password ? [password] : [];
  streamLines(taskId, "stdout", child.stdout, capture, nextSequence, secrets);
  streamLines(taskId, "stderr", child.stderr, capture, nextSequence, secrets);

  child.once("close", async (code) => {
    if (activeTask?.id === taskId) activeTask = null;
    await passwordBroker?.close();
    if (!spawned) return;
    let status: "cancelled" | "succeeded" | "failed" = task.cancelled ? "cancelled" : code === 0 ? "succeeded" : "failed";
    let error = status === "cancelled" ? { kind: "cancelled", message: "任务已取消。" } : status === "failed" ? classifyError(captured) : null;
    if (status === "succeeded" && operation === "init" && credentialEndpoint && password) {
      try {
        credentialManager.commitSuccessfulInit(credentialEndpoint, workingDirectory, authentication?.password, authentication?.remember ?? true);
      } catch (credentialError) {
        status = "failed";
        error = { kind: "credentialStorage", message: credentialError instanceof Error ? credentialError.message : String(credentialError) };
      }
    }
    emit("teamai:completed", { taskId, exitCode: code, durationMs: Date.now() - startedAt, status, error });
  });

  await new Promise<void>((resolvePromise, reject) => {
    child.once("spawn", () => { spawned = true; resolvePromise(); });
    child.once("error", (error) => {
      if (activeTask?.id === taskId) activeTask = null;
      void passwordBroker?.close();
      reject(new ApiError("processStartFailed", `无法启动 TeamAI：${error.message}`));
    });
  });
  return { taskId };
}

async function cancelTeamAi(taskId: unknown): Promise<CancelAck> {
  if (typeof taskId !== "string") throw new ApiError("taskNotFound", "任务 ID 无效。");
  if ((!activeTask || activeTask.id !== taskId) && lastCancelledTaskId === taskId) return { accepted: true, alreadyRequested: true };
  if (!activeTask || activeTask.id !== taskId) throw new ApiError("taskNotFound", "任务 ID 与当前运行任务不匹配。");
  if (activeTask.cancelRequested) return { accepted: true, alreadyRequested: true };
  activeTask.cancelRequested = true;
  activeTask.cancelled = true;
  lastCancelledTaskId = taskId;
  await killProcessTree(activeTask);
  return { accepted: true, alreadyRequested: false };
}

function registerIpc() {
  ipcMain.handle("teamai:check-environment", () => checkEnvironment().catch((error) => { throw errorForIpc(error); }));
  ipcMain.handle("teamai:run", (_event, request) => runTeamAi(request).catch((error) => { throw errorForIpc(error); }));
  ipcMain.handle("teamai:cancel", (_event, taskId) => cancelTeamAi(taskId).catch((error) => { throw errorForIpc(error); }));
  ipcMain.handle("teamai:get-recent-directory", () => store.get("recentWorkingDirectory") || null);
  ipcMain.handle("teamai:get-ssh-credential-state", (_event, repository) => {
    const endpoint = parseSshRepository(repository, true);
    if (!endpoint) throw errorForIpc(new ApiError("invalidRepository", "请输入包含用户名的 SSH 仓库地址。"));
    return credentialManager.state(endpoint);
  });
  ipcMain.handle("teamai:delete-ssh-credential", (_event, repository) => {
    if (activeTask) throw errorForIpc(new ApiError("taskAlreadyRunning", "任务运行期间不能删除 SSH 凭据。"));
    const endpoint = parseSshRepository(repository, true);
    if (!endpoint) throw errorForIpc(new ApiError("invalidRepository", "请输入包含用户名的 SSH 仓库地址。"));
    return { deleted: credentialManager.delete(endpoint) };
  });
  ipcMain.handle("teamai:select-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: "选择 TeamAI 工作目录", properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = canonicalizeDirectory(result.filePaths[0]);
    store.set("recentWorkingDirectory", selected);
    return selected;
  });
}

function createWindow() {
  diagnosticLog(`createWindow packaged=${app.isPackaged} renderer=${process.env.ELECTRON_RENDERER_URL ?? "file"}`);
  mainWindow = new BrowserWindow({
    title: "TeamAI Sync",
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: "#090b0e",
    show: false,
    webPreferences: {
      preload: join(currentDirectory, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    const allowed = app.isPackaged ? url.startsWith("file:") : Boolean(developmentUrl && url.startsWith(developmentUrl));
    if (!allowed) event.preventDefault();
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    diagnosticLog(`did-fail-load code=${code} description=${description} url=${url}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    diagnosticLog(`render-process-gone reason=${details.reason} code=${details.exitCode}`);
  });
  mainWindow.on("close", (event) => {
    if (closing) { event.preventDefault(); return; }
    if (!activeTask) return;
    event.preventDefault();
    closing = true;
    activeTask.cancelled = true;
    void killProcessTree(activeTask).finally(() => {
      void activeTask?.passwordBroker?.close();
      const window = mainWindow;
      activeTask = null;
      window?.destroy();
    });
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  const load = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    : mainWindow.loadFile(join(currentDirectory, "../renderer/index.html"));
  void load
    .then(() => {
      diagnosticLog("renderer load completed; showing window");
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    })
    .catch((error) => {
      diagnosticLog(`renderer load rejected: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      dialog.showErrorBox("TeamAI Sync 启动失败", error instanceof Error ? error.message : String(error));
    });
}

async function bootstrap() {
  if (await runSshAuxiliaryMode()) return;
  if (process.env.TEAMAI_E2E_USER_DATA) app.setPath("userData", resolve(process.env.TEAMAI_E2E_USER_DATA));
  await app.whenReady();
  store = new Store<SettingsSchema>({
    name: "settings",
    defaults: { recentWorkingDirectory: "", sshCredentials: {}, workspaceCredentialBindings: {} },
  });
  credentialManager = new CredentialManager(store, {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (password) => safeStorage.encryptString(password),
    decrypt: (encrypted) => safeStorage.decryptString(encrypted),
  });
  diagnosticLog("app ready");
  registerIpc();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}

void bootstrap();

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || process.env.TEAMAI_E2E_USER_DATA) app.quit();
});
