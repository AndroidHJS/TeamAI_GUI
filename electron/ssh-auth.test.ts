import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPasswordBroker } from "./ssh-auth";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function requestPassword(pipe: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipe);
    let value = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${token}\n`));
    socket.on("data", (chunk) => { value += chunk; });
    socket.once("end", () => resolve(value));
    socket.once("error", reject);
  });
}

describe("password broker", () => {
  it("serves repeated authenticated requests without putting the password in environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamai-broker-"));
    roots.push(root);
    const broker = await createPasswordBroker("s3cr3t", root, process.execPath);
    const environmentText = JSON.stringify(broker.environment);
    expect(environmentText).not.toContain("s3cr3t");
    const pipe = broker.environment.TEAMAI_ASKPASS_PIPE!;
    const token = broker.environment.TEAMAI_ASKPASS_TOKEN!;
    expect(await requestPassword(pipe, token)).toBe("s3cr3t\n");
    expect(await requestPassword(pipe, token)).toBe("s3cr3t\n");
    await broker.close();
    await expect(requestPassword(pipe, token)).rejects.toBeTruthy();
  });

  it("refuses an invalid capability token", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamai-broker-"));
    roots.push(root);
    const broker = await createPasswordBroker("s3cr3t", root, process.execPath);
    expect(await requestPassword(broker.environment.TEAMAI_ASKPASS_PIPE!, "wrong")).toBe("");
    await broker.close();
  });

  it("serves the standalone console askpass bridge", async () => {
    const root = mkdtempSync(join(tmpdir(), "teamai-broker-"));
    roots.push(root);
    const broker = await createPasswordBroker("console-secret", root, process.execPath);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, "askpass-helper.cjs"), "Password:"], {
        env: { ...process.env, ...broker.environment },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `helper exited ${code}`)));
    });
    expect(output).toBe("console-secret\n");
    await broker.close();
  });
});
