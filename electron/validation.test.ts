import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, validateAndBuildRequest, validateRepository } from "./validation";

const roots: string[] = [];

function chineseDirectory() {
  const root = mkdtempSync(join(tmpdir(), "teamai-gui-"));
  roots.push(root);
  const directory = join(root, "中文 项目");
  mkdirSync(directory);
  return directory;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Electron request validation", () => {
  it("builds an init argv array without shell concatenation", () => {
    const request = validateAndBuildRequest({
      operation: "init",
      workingDirectory: chineseDirectory(),
      initOptions: {
        repository: "https://github.com/acme/team.git",
        scope: "user",
        role: "hai_dev",
        agents: ["claude", "codex"],
        force: true,
      },
    });
    expect(request.args).toEqual(["init", "https://github.com/acme/team.git", "--scope", "user", "--role", "hai_dev", "--agent", "claude,codex", "--force"]);
  });

  it("always makes push non-interactive", () => {
    expect(validateAndBuildRequest({ operation: "push", workingDirectory: chineseDirectory(), pushOptions: { role: "pm" } }).args)
      .toEqual(["push", "--all", "--role", "pm"]);
  });

  it("rejects option injection, embedded credentials, and unknown fields", () => {
    expect(() => validateRepository("--help")).toThrow(ApiError);
    expect(() => validateRepository("https://token@example.com/org/repo")).toThrow(/凭据/);
    expect(() => validateAndBuildRequest({ operation: "status", workingDirectory: chineseDirectory(), unexpected: true })).toThrow(/未知字段/);
  });

  it("rejects options that do not belong to an operation", () => {
    expect(() => validateAndBuildRequest({ operation: "pull", workingDirectory: chineseDirectory(), pushOptions: {} })).toThrow(/不接受额外选项/);
  });
});

