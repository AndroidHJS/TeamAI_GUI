import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, parseSshRepository, validateAndBuildRequest, validateRepository } from "./validation";

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

  it("normalizes SCP and SSH URL endpoints", () => {
    expect(parseSshRepository("git@Example.COM:androidai/team.git")).toEqual({
      username: "git", host: "example.com", port: 22, key: "ssh-password:v1:git@example.com:22",
    });
    expect(parseSshRepository("ssh://builder@Example.COM:2222/androidai/team.git")).toEqual({
      username: "builder", host: "example.com", port: 2222, key: "ssh-password:v1:builder@example.com:2222",
    });
  });

  it("rejects insecure HTTP and malformed SSH endpoints", () => {
    expect(() => validateRepository("http://example.com/acme/team.git")).toThrow(/不安全/);
    expect(() => validateRepository("ssh://git@example.com:70000/acme/team.git")).toThrow(ApiError);
    expect(() => parseSshRepository("ssh://example.com/acme/team.git")).toThrow(/用户名/);
    expect(() => parseSshRepository("ssh://bad%ZZ@example.com/acme/team.git")).toThrow(/编码/);
  });

  it("strictly validates SSH password authentication", () => {
    const directory = chineseDirectory();
    const valid = validateAndBuildRequest({
      operation: "init",
      workingDirectory: directory,
      initOptions: { repository: "git@example.com:acme/team.git", scope: "project", force: false },
      authentication: { type: "sshPassword", password: "s p@ss!", remember: true },
    });
    expect(valid.authentication).toEqual({ type: "sshPassword", password: "s p@ss!", remember: true });
    expect(valid.sshEndpoint?.host).toBe("example.com");
    expect(() => validateAndBuildRequest({
      operation: "init", workingDirectory: directory,
      initOptions: { repository: "git@example.com:acme/team.git", scope: "project", force: false },
      authentication: { type: "sshPassword", password: "bad\npassword", remember: false },
    })).toThrow(/控制字符/);
    expect(() => validateAndBuildRequest({
      operation: "pull", workingDirectory: directory,
      authentication: { type: "sshPassword", password: "secret", remember: false },
    })).toThrow(/不能携带/);
  });
});
