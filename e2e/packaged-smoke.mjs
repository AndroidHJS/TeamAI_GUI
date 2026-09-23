import { _electron as electron } from "playwright";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const executable = join(root, "release", "win-unpacked", "TeamAI Sync.exe");
if (!existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);

const app = await electron.launch({
  executablePath: executable,
  env: {
    ...process.env,
    PATH: `${join(root, "e2e", "fixtures", "teamai-bin")};${process.env.PATH ?? ""}`,
    TEAMAI_E2E_USER_DATA: join(root, ".e2e-user-data", `packaged-${process.pid}`),
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector("h1");
  const title = await page.locator("h1").textContent();
  if (title !== "TeamAI Sync") throw new Error(`Unexpected packaged app title: ${title}`);
  console.log("Packaged Electron startup smoke test passed.");
} finally {
  await app.close();
}
