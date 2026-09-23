import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createAskpassBroker } from "./askpass";

function invokeHelper(pipeName: string): Promise<string> {
  const helper = resolve("resources/askpass/teamai-askpass.cmd");
  return new Promise((resolveOutput, reject) => {
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", `call ${helper} Password:`], {
      env: { ...process.env, TEAMAI_ASKPASS_PIPE: pipeName },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(stderr || `askpass exited ${code}`)));
  });
}

describe.skipIf(process.platform !== "win32")("Windows SSH askpass bridge", () => {
  it("returns the in-memory password repeatedly through the packaged helper protocol", async () => {
    const broker = await createAskpassBroker("temporary-test-secret!");
    try {
      expect(await invokeHelper(broker.pipeName)).toBe("temporary-test-secret!");
      expect(await invokeHelper(broker.pipeName)).toBe("temporary-test-secret!");
    } finally {
      await broker.dispose();
    }
  });
});
