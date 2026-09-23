import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { CompletedEvent, LogEvent } from "./types";

const callbacks = new Map<string, (event: { payload: unknown }) => void>();
const api = vi.hoisted(() => ({
  checkEnvironment: vi.fn(),
  runTeamAi: vi.fn(),
  cancelTeamAi: vi.fn(),
  selectDirectory: vi.fn(),
  getRecentDirectory: vi.fn(),
  onTeamAiLog: vi.fn(),
  onTeamAiCompleted: vi.fn(),
}));

vi.mock("./api", () => api);

const environment = {
  ready: true,
  checkedAt: "2026-09-22T00:00:00.000Z",
  node: { name: "Node.js", available: true, compatible: true, version: "v24.11.1", path: "node.exe", message: "可用" },
  git: { name: "Git", available: true, compatible: true, version: "git version 2.50.1", path: "git.exe", message: "可用" },
  teamai: { name: "TeamAI CLI", available: true, compatible: true, version: "0.21.0", path: "index.js", message: "可用" },
};

async function chooseDirectory() {
  fireEvent.click(await screen.findByRole("button", { name: "选择" }));
  await screen.findByText("C:\\测试 项目");
}

describe("App", () => {
  beforeEach(() => {
    callbacks.clear();
    api.checkEnvironment.mockResolvedValue(environment);
    api.runTeamAi.mockResolvedValue({ taskId: "task-1" });
    api.cancelTeamAi.mockResolvedValue({ accepted: true, alreadyRequested: false });
    api.selectDirectory.mockResolvedValue("C:\\测试 项目");
    api.getRecentDirectory.mockResolvedValue(null);
    api.onTeamAiLog.mockImplementation((callback: (event: unknown) => void) => {
      callbacks.set("teamai://log", ({ payload }) => callback(payload));
      return () => callbacks.delete("teamai://log");
    });
    api.onTeamAiCompleted.mockImplementation((callback: (event: unknown) => void) => {
      callbacks.set("teamai://completed", ({ payload }) => callback(payload));
      return () => callbacks.delete("teamai://completed");
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("shows checked dependencies", async () => {
    render(<App />);
    expect(await screen.findByText("v24.11.1")).toBeInTheDocument();
    expect(screen.getByText("0.21.0")).toBeInTheDocument();
  });

  it("disables competing actions while a task is running", async () => {
    render(<App />);
    await screen.findByText("环境就绪");
    await chooseDirectory();
    await waitFor(() => expect(api.runTeamAi).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /拉取资源/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /取消当前任务/ })).toBeEnabled();
  });

  it("appends logs as text and maps an uninitialized status", async () => {
    render(<App />);
    await screen.findByText("环境就绪");
    await waitFor(() => expect(callbacks.has("teamai://log")).toBe(true));
    const log: LogEvent = { taskId: "task-1", stream: "stderr", line: "\u001b[31mfailed\u001b[0m", timestamp: new Date().toISOString(), sequence: 1 };
    await act(async () => callbacks.get("teamai://log")?.({ payload: log }));
    expect(screen.getByText("failed")).toHaveClass("ansi-red");

    await chooseDirectory();
    await waitFor(() => expect(api.runTeamAi).toHaveBeenCalled());
    const completed: CompletedEvent = { taskId: "task-1", exitCode: 1, durationMs: 20, status: "failed", error: { kind: "notInitialized", message: "未初始化" } };
    await act(async () => callbacks.get("teamai://completed")?.({ payload: completed }));
    expect((await screen.findAllByText("未初始化")).length).toBeGreaterThan(0);
  });

  it("requires confirmation before push --all", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<App />);
    await screen.findByText("环境就绪");
    await chooseDirectory();
    await waitFor(() => expect(api.runTeamAi).toHaveBeenCalled());
    const completed: CompletedEvent = { taskId: "task-1", exitCode: 0, durationMs: 10, status: "succeeded", error: null };
    await act(async () => callbacks.get("teamai://completed")?.({ payload: completed }));
    await waitFor(() => expect(screen.getByRole("button", { name: /推送变更/ })).toBeEnabled());
    api.runTeamAi.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /推送变更/ }));
    expect(window.confirm).toHaveBeenCalled();
    expect(api.runTeamAi).not.toHaveBeenCalled();
  });
});
