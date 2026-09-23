import { _electron as electron, expect, test, type ElectronApplication, type Page } from "playwright/test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runId = `${process.pid}-${Date.now()}`;
const workDirectory = join(root, ".e2e-work", `中文 项目-${runId}`);
const fixtureBin = join(root, "e2e", "fixtures", "teamai-bin");
const userData = join(root, ".e2e-user-data", runId);
const initializedMarker = join(workDirectory, ".teamai-e2e-initialized");
const slowMarker = join(workDirectory, ".teamai-e2e-slow");
const childPidMarker = join(workDirectory, ".teamai-e2e-child-pid");
const passwordMarker = join(workDirectory, ".teamai-e2e-expected-password");
const changedHostMarker = join(workDirectory, ".teamai-e2e-host-changed");
const correctPassword = "e2e-password-with-symbols!";
const updatedPassword = "updated-e2e-password!";

function removeFixtureState() {
  mkdirSync(workDirectory, { recursive: true });
  for (const file of [initializedMarker, slowMarker, childPidMarker, passwordMarker, changedHostMarker]) rmSync(file, { force: true });
}

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ["."],
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
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }).toBe(true);
}

test("真实 Electron 窗口完成初始化、同步、取消和关闭清理", async () => {
  removeFixtureState();
  rmSync(userData, { recursive: true, force: true });
  writeFileSync(passwordMarker, correctPassword, "utf8");
  let app: ElectronApplication | null = null;
  try {
    const launched = await launchApp();
    app = launched.app;
    const page = launched.page;
    await expect(page.getByText("环境就绪")).toBeVisible();
    await expect(page.getByText("0.21.0", { exact: true })).toBeVisible();

    await selectWorkingDirectory(page);
    await expect(page.getByText("未初始化", { exact: true })).toBeVisible();
    await expect(page.getByText("Not initialized. Run teamai init first.")).toBeVisible();

    const repository = "git@example.test:acme/e2e.git";
    await page.getByPlaceholder("https://github.com/org/team-resources.git").fill(repository);
    const passwordInput = page.getByPlaceholder("请输入 SSH 密码");
    await expect(passwordInput).toHaveAttribute("type", "password");
    await passwordInput.fill("wrong-e2e-password");
    await page.getByRole("button", { name: "初始化 TeamAI" }).click();
    await expect(page.getByText("认证失败，请检查 Git 平台登录或凭据配置。")).toBeVisible();
    await expect(page.getByText("初始化失败", { exact: true })).toBeVisible();
    const failedSettings = readFileSync(join(userData, "settings.json"), "utf8");
    expect(failedSettings).not.toContain("wrong-e2e-password");

    await passwordInput.fill(correctPassword);
    await page.getByRole("button", { name: /高级选项/ }).click();
    await page.getByPlaceholder("hai_dev").fill("e2e_role");
    await page.getByText("codex", { exact: true }).click();
    await page.getByText("cursor", { exact: true }).click();
    await page.getByRole("button", { name: "初始化 TeamAI" }).click();
    await expect(page.getByText(`Initialized ${repository}`, { exact: false })).toBeVisible();
    await expect(page.getByText("已初始化", { exact: true })).toBeVisible();
    await expect(page.getByText("已安全保存", { exact: true })).toBeVisible();
    await expect(page.getByText("── 检查状态 ──", { exact: true })).toHaveCount(2);

    const initResult = JSON.parse(readFileSync(initializedMarker, "utf8")) as { args: string[]; cwd: string };
    expect(initResult.cwd).toBe(workDirectory);
    expect(initResult.args).toEqual([
      "init", repository, "--scope", "project", "--role", "e2e_role", "--agent", "codex,cursor",
    ]);
    expect(initResult).toMatchObject({ hasAskpassPipe: true });
    expect((initResult as { gitSshCommand: string }).gitSshCommand).toContain("StrictHostKeyChecking=accept-new");
    expect((initResult as { gitSshCommand: string }).gitSshCommand).toContain("UserKnownHostsFile=");
    expect(readFileSync(join(userData, "settings.json"), "utf8")).not.toContain(correctPassword);

    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText("diagnostic stream check", { exact: true })).toBeVisible();
    await expect(page.getByText("Pull complete", { exact: true })).toBeVisible();
    await expect(page.getByText("── 检查状态 ──", { exact: true })).toHaveCount(3);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /推送变更/ }).click();
    await expect(page.getByText("Push complete with args: push --all", { exact: true })).toBeVisible();
    await expect(page.getByText("── 检查状态 ──", { exact: true })).toHaveCount(4);

    await page.getByRole("button", { name: "删除已保存密码" }).click();
    await expect(page.getByText("已安全保存", { exact: true })).not.toBeVisible();
    writeFileSync(passwordMarker, updatedPassword, "utf8");
    await page.getByPlaceholder("请输入 SSH 密码").fill(updatedPassword);
    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText("Pull complete", { exact: true })).toHaveCount(2);
    await expect(page.getByText("── 检查状态 ──", { exact: true })).toHaveCount(5);
    await expect(page.getByText("已安全保存", { exact: true })).toBeVisible();
    expect(readFileSync(join(userData, "settings.json"), "utf8")).not.toContain(updatedPassword);

    writeFileSync(changedHostMarker, "changed", "utf8");
    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText("SSH 主机指纹已变化，为保护连接已拒绝访问。")).toBeVisible();
    writeFileSync(changedHostMarker, "accepted", "utf8");

    writeFileSync(slowMarker, "slow", "utf8");
    const previousChildPid = existsSync(childPidMarker) ? readFileSync(childPidMarker, "utf8") : "";
    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText(/long pull tick 1/)).toBeVisible();
    await expect.poll(() => readFileSync(childPidMarker, "utf8")).not.toBe(previousChildPid);
    const cancelledChildPid = await waitForChildPid();
    await page.getByRole("button", { name: "取消当前任务" }).click();
    await expectProcessStopped(cancelledChildPid);
    await expect(page.getByText("无活动进程", { exact: true })).toBeVisible();

    const firstChildPid = readFileSync(childPidMarker, "utf8");
    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText(/long pull tick 1/)).toBeVisible();
    await expect.poll(() => readFileSync(childPidMarker, "utf8")).not.toBe(firstChildPid);
    const closeCleanupChildPid = await waitForChildPid();
    const exited = new Promise<void>((resolveExit) => app!.process().once("exit", () => resolveExit()));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined);
    await exited;
    await expectProcessStopped(closeCleanupChildPid);
    app = null;
  } finally {
    if (app) await app.close();
    removeFixtureState();
    rmSync(userData, { recursive: true, force: true });
  }
});
