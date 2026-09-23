import { _electron as electron, expect, test, type ElectronApplication, type Page } from "playwright/test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workDirectory = join(root, ".e2e-work", "中文 项目");
const fixtureBin = join(root, ".e2e-bin");
const userData = join(root, ".e2e-user-data");
const initializedMarker = join(workDirectory, ".teamai-e2e-initialized");
const slowMarker = join(workDirectory, ".teamai-e2e-slow");
const childPidMarker = join(workDirectory, ".teamai-e2e-child-pid");

function removeFixtureState() {
  for (const file of [initializedMarker, slowMarker, childPidMarker]) rmSync(file, { force: true });
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

    await page.getByPlaceholder("https://github.com/org/team-resources.git").fill("https://github.com/acme/e2e.git");
    await page.getByRole("button", { name: /高级选项/ }).click();
    await page.getByPlaceholder("hai_dev").fill("e2e_role");
    await page.getByText("codex", { exact: true }).click();
    await page.getByText("cursor", { exact: true }).click();
    await page.getByRole("button", { name: "初始化 TeamAI" }).click();
    await expect(page.getByText("Initialized https://github.com/acme/e2e.git", { exact: false })).toBeVisible();
    await expect(page.getByText("已初始化", { exact: true })).toBeVisible();

    const initResult = JSON.parse(readFileSync(initializedMarker, "utf8")) as { args: string[]; cwd: string };
    expect(initResult.cwd).toBe(workDirectory);
    expect(initResult.args).toEqual([
      "init", "https://github.com/acme/e2e.git", "--scope", "project", "--role", "e2e_role", "--agent", "codex,cursor",
    ]);

    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText("diagnostic stream check", { exact: true })).toBeVisible();
    await expect(page.getByText("Pull complete", { exact: true })).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /推送变更/ }).click();
    await expect(page.getByText("Push complete with args: push --all", { exact: true })).toBeVisible();

    writeFileSync(slowMarker, "slow", "utf8");
    rmSync(childPidMarker, { force: true });
    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText(/long pull tick 1/)).toBeVisible();
    const cancelledChildPid = await waitForChildPid();
    await page.getByRole("button", { name: "取消当前任务" }).click();
    await expectProcessStopped(cancelledChildPid);
    await expect(page.getByText("无活动进程", { exact: true })).toBeVisible();

    rmSync(childPidMarker, { force: true });
    await page.getByRole("button", { name: /拉取资源/ }).click();
    await expect(page.getByText(/long pull tick 1/)).toBeVisible();
    const closeCleanupChildPid = await waitForChildPid();
    const exited = new Promise<void>((resolveExit) => app!.process().once("exit", () => resolveExit()));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined);
    await exited;
    await expectProcessStopped(closeCleanupChildPid);
    app = null;
  } finally {
    if (app) await app.close();
    removeFixtureState();
  }
});
