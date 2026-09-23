import { describe, expect, it } from "vitest";
import { CredentialManager, type CredentialSettings } from "./credentials";

const endpoint = { username: "git", host: "example.com", port: 22, key: "ssh-password:v1:git@example.com:22" };

function fixture(encryptionAvailable = true) {
  const data: CredentialSettings = { sshCredentials: {}, workspaceCredentialBindings: {} };
  const manager = new CredentialManager(
    { get: (key) => data[key], set: (key, value) => { data[key] = value; } },
    {
      isEncryptionAvailable: () => encryptionAvailable,
      encrypt: (value) => Buffer.from(`encrypted:${value}`),
      decrypt: (value) => value.toString().replace(/^encrypted:/, ""),
    },
  );
  return { data, manager };
}

describe("CredentialManager", () => {
  it("stores only encrypted credentials and binds successful init", () => {
    const { data, manager } = fixture();
    manager.commitSuccessfulInit(endpoint, "/work", "secret", true);
    expect(JSON.stringify(data)).not.toContain('"secret"');
    expect(manager.resolveForWorkspace("/work")).toBe("secret");
    expect(manager.state(endpoint).configured).toBe(true);
  });

  it("keeps non-remembered credentials in memory", () => {
    const { data, manager } = fixture();
    manager.commitSuccessfulInit(endpoint, "/work", "session-only", false);
    expect(data.sshCredentials).toEqual({});
    expect(manager.resolveForWorkspace("/work")).toBe("session-only");
    manager.clearSession();
    expect(manager.resolveForWorkspace("/work")).toBeNull();
  });

  it("does not replace a stored password until commit", () => {
    const { manager } = fixture();
    manager.commitSuccessfulInit(endpoint, "/work", "old", true);
    expect(manager.resolveForInit(endpoint, "wrong")).toBe("wrong");
    expect(manager.resolveForWorkspace("/work")).toBe("old");
  });

  it("deletes credentials and all bindings", () => {
    const { data, manager } = fixture();
    manager.commitSuccessfulInit(endpoint, "/one", "secret", true);
    manager.commitSuccessfulInit(endpoint, "/two", undefined, true);
    expect(manager.delete(endpoint)).toBe(true);
    expect(data.sshCredentials).toEqual({});
    expect(data.workspaceCredentialBindings).toEqual({});
  });

  it("rejects persistent storage when encryption is unavailable", () => {
    const { manager } = fixture(false);
    expect(() => manager.commitSuccessfulInit(endpoint, "/work", "secret", true)).toThrow(/安全存储不可用/);
    manager.commitSuccessfulInit(endpoint, "/work", "secret", false);
    expect(manager.resolveForWorkspace("/work")).toBe("secret");
  });
});
