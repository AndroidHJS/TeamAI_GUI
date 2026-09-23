import { _electron as electron, expect, test, type ElectronApplication, type Page } from "playwright/test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import ssh2, { type AuthContext, type KeyboardInteractiveAuthContext } from "ssh2";

const { Server } = ssh2;

const root = resolve(import.meta.dirname, "..");
const workDirectory = join(root, ".e2e-work", "中文 项目");
const fixtureBin = join(root, ".e2e-bin");
const userData = join(root, ".e2e-user-data");
const initializedMarker = join(workDirectory, ".teamai-e2e-initialized");
const auditMarker = join(workDirectory, ".teamai-e2e-audit.json");
const slowMarker = join(workDirectory, ".teamai-e2e-slow");
const childPidMarker = join(workDirectory, ".teamai-e2e-child-pid");
const password = "correct horse battery staple";

function packagedExecutable(): string {
  const release = join(root, "release");
  if (process.platform === "win32") return join(release, "win-unpacked", "TeamAI Sync.exe");
  const macDirectory = readdirSync(release, { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.startsWith("mac"))?.name;
  if (!macDirectory) throw new Error("Missing packaged macOS application. Run npm run pack:test first.");
  return join(release, macDirectory, "TeamAI Sync.app", "Contents", "MacOS", "TeamAI Sync");
}

function prepareFixture() {
  rmSync(fixtureBin, { recursive: true, force: true });
  rmSync(join(root, ".e2e-work"), { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
  mkdirSync(workDirectory, { recursive: true });
  mkdirSync(fixtureBin, { recursive: true });
  const source = join(root, "e2e", "fixtures", "teamai-fixture.mjs");
  if (process.platform === "win32") {
    const packageRoot = join(fixtureBin, "node_modules", "teamai-cli");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(fixtureBin, "teamai.cmd"), "@echo off\r\n", "utf8");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "teamai-cli", bin: { teamai: "dist/index.js" } }), "utf8");
    copyFileSync(source, join(packageRoot, "dist", "index.js"));
  } else {
    copyFileSync(source, join(fixtureBin, "teamai"));
    chmodSync(join(fixtureBin, "teamai"), 0o755);
  }
}

function createHostKey(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
}

async function startSshServer(expectedPassword: () => string, hostKey: string, requestedPort = 0, authenticationMode: "keyboard-interactive" | "password" = "keyboard-interactive") {
  const clients = new Set<{ end(): void }>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("error", () => undefined);
    client.on("close", () => clients.delete(client));
    client.on("authentication", (context: AuthContext) => {
      if (context.method === "password" && authenticationMode === "password") {
        if (context.password === expectedPassword()) context.accept(); else context.reject();
      } else if (context.method === "keyboard-interactive" && authenticationMode === "keyboard-interactive") {
        const interactive = context as KeyboardInteractiveAuthContext;
        interactive.prompt([{ prompt: "Password: ", echo: false }], (answers) => {
          if (answers[0] === expectedPassword()) interactive.accept(); else interactive.reject();
        });
      } else {
        context.reject(["keyboard-interactive", "password"]);
      }
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(`executed ${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => resolveListen());
  });
  server.on("error", () => undefined);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SSH test server did not bind TCP.");
  return {
    port: address.port,
    close: () => new Promise<void>((resolveClose) => {
      for (const client of clients) client.end();
      server.close();
      setTimeout(resolveClose, 100);
    }),
  };
}

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: packagedExecutable(),
    cwd: root,
    env: {
      ...process.env,
      PATH: `${fixtureBin}${delimiter}${process.env.PATH ?? ""}`,
      TEAMAI_E2E_USER_DATA: userData,
    },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, selectedDirectory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedDirectory] });
  }, workDirectory);
  return { app, page };
}

async function selectWorkingDirectory(page: Page) {
  await page.getByRole("button", { name: "选择", exact: true }).click();
  await expect(page.getByTitle(workDirectory)).toBeVisible();
}

async function waitForChildPid(): Promise<number> {
  await expect.poll(() => existsSync(childPidMarker)).toBe(true);
  return Number(readFileSync(childPidMarker, "utf8"));
}

async function expectProcessStopped(pid: number) {
  await expect.poll(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }).toBe(true);
}

test.beforeEach(() => prepareFixture());

test("打包态 Electron 完成 SSH 密码存储、同步、主机密钥保护和进程清理", async () => {
  const firstKey = createHostKey();
  let acceptedPassword = password;
  let ssh = await startSshServer(() => acceptedPassword, firstKey);
  const repository = `ssh://git@127.0.0.1:${ssh.port}/androidai/team.git`;
  let app: ElectronApplication | null = null;
  try {
    let launched = await launchApp();
    app = launched.app;
    let page = launched.page;
    await expect(page.getByText("环境就绪")).toBeVisible();
    await selectWorkingDirectory(page);
    await expect(page.getByText("未初始化", { exact: true })).toBeVisible();

    await page.getByPlaceholder("https://github.com/org/team-resources.git").fill(repository);
    await expect(page.getByTestId("ssh-credential-card")).toBeVisible();
    await page.getByRole("textbox", { name: "SSH 密码", exact: true }).fill(password);
    await page.getByRole("button", { name: "初始化 TeamAI" }).click();
    await expect(page.getByText(`Initialized ${repository}`, { exact: true })).toBeVisible();
    await expect(page.getByText("已初始化", { exact: true })).toBeVisible();

    expect(readFileSync(auditMarker, "utf8")).not.toContain(password);
    expect(readFileSync(join(userData, "settings.json"), "utf8")).not.toContain(password);

    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText("Pull complete", { exact: true })).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /推送变更/ }).click();
    await expect(page.getByText("Push complete with args: push --all", { exact: true })).toBeVisible();

    const storedBeforeFailure = readFileSync(join(userData, "settings.json"), "utf8");
    await page.getByRole("textbox", { name: "SSH 密码", exact: true }).fill("wrong password");
    await page.getByRole("button", { name: "初始化 TeamAI" }).click();
    await expect(page.getByText(/SSH 认证失败/)).toBeVisible();
    expect(readFileSync(join(userData, "settings.json"), "utf8")).toBe(storedBeforeFailure);

    acceptedPassword = "updated password";
    await page.getByRole("textbox", { name: "SSH 密码", exact: true }).fill(acceptedPassword);
    const initLog = page.getByText(`Initialized ${repository}`, { exact: true });
    const initLogCount = await initLog.count();
    await page.getByRole("button", { name: "初始化 TeamAI" }).click();
    await expect.poll(() => initLog.count()).toBe(initLogCount + 1);
    expect(readFileSync(join(userData, "settings.json"), "utf8")).not.toBe(storedBeforeFailure);

    await app.close();
    app = null;
    launched = await launchApp();
    app = launched.app;
    page = launched.page;
    await expect(page.getByText("环境就绪")).toBeVisible();
    await selectWorkingDirectory(page);
    await expect(page.getByText("已初始化", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText("Pull complete", { exact: true })).toBeVisible();

    await page.getByPlaceholder("https://github.com/org/team-resources.git").fill(repository);
    await expect(page.getByText("已保存", { exact: true })).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "删除密码" }).click();
    await expect(page.getByText("未保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText(/SSH 认证失败/)).toBeVisible();

    await page.getByRole("textbox", { name: "SSH 密码", exact: true }).fill(acceptedPassword);
    const restartedInitLog = page.getByText(`Initialized ${repository}`, { exact: true });
    const reinitLogCount = await restartedInitLog.count();
    await page.getByRole("button", { name: "初始化 TeamAI" }).click();
    await expect.poll(() => restartedInitLog.count()).toBe(reinitLogCount + 1);

    await ssh.close();
    ssh = await startSshServer(() => acceptedPassword, createHostKey(), ssh.port);
    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText(/主机密钥校验失败/)).toBeVisible();

    writeFileSync(slowMarker, "slow", "utf8");
    rmSync(childPidMarker, { force: true });
    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText(/long pull tick/).first()).toBeVisible();
    const cancelledChildPid = await waitForChildPid();
    await page.getByRole("button", { name: "取消当前任务" }).click();
    await expectProcessStopped(cancelledChildPid);
    await expect(page.getByText("无活动进程", { exact: true })).toBeVisible();

    rmSync(childPidMarker, { force: true });
    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText(/long pull tick/).first()).toBeVisible();
    const closeCleanupChildPid = await waitForChildPid();
    const closingAppPid = app.process().pid;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined);
    await expectProcessStopped(closeCleanupChildPid);
    await expectProcessStopped(closingAppPid);
    await app.close().catch(() => undefined);
    app = null;
  } finally {
    if (app) await app.close();
    await ssh.close().catch(() => undefined);
  }
});

test("未勾选记住时密码认证凭据仅在当前应用会话有效", async () => {
  const ssh = await startSshServer(() => password, createHostKey(), 0, "password");
  const repository = `ssh://git@127.0.0.1:${ssh.port}/androidai/team.git`;
  let app: ElectronApplication | null = null;
  try {
    let launched = await launchApp();
    app = launched.app;
    let page = launched.page;
    await expect(page.getByText("环境就绪")).toBeVisible();
    await selectWorkingDirectory(page);
    await page.getByPlaceholder("https://github.com/org/team-resources.git").fill(repository);
    await page.getByRole("textbox", { name: "SSH 密码", exact: true }).fill(password);
    await page.getByRole("checkbox", { name: "使用系统安全存储记住密码" }).uncheck();
    await page.getByRole("button", { name: "初始化 TeamAI" }).click();
    await expect(page.getByText("初始化完成", { exact: true })).toBeVisible();
    const sessionSettings = JSON.parse(readFileSync(join(userData, "settings.json"), "utf8")) as { sshCredentials: Record<string, string> };
    expect(sessionSettings.sshCredentials).toEqual({});
    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText("Pull complete", { exact: true })).toBeVisible();

    await app.close();
    app = null;
    launched = await launchApp();
    app = launched.app;
    page = launched.page;
    await expect(page.getByText("环境就绪")).toBeVisible();
    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText(/SSH 认证失败/)).toBeVisible();
  } finally {
    if (app) await app.close();
    await ssh.close();
  }
});
