import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const release = join(root, "release");
const installRoot = join(root, ".e2e-install");
const userData = join(installRoot, "user data");
rmSync(installRoot, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });

function artifact(extension) {
  const file = readdirSync(release).find((name) => name.endsWith(extension));
  if (!file) throw new Error(`No ${extension} artifact found in release/`);
  return join(release, file);
}

let executable;
let mounted = false;
const mountPoint = join(installRoot, "mounted image");
try {
  if (process.platform === "win32") {
    const installer = artifact(".exe");
    const destination = join(installRoot, "Installed TeamAI Sync");
    const install = spawnSync(installer, ["/S", `/D=${destination}`], { stdio: "inherit", windowsHide: true });
    if (install.status !== 0) throw new Error(`NSIS silent install failed with ${install.status}`);
    executable = join(destination, "TeamAI Sync.exe");
  } else if (process.platform === "darwin") {
    const dmg = artifact(".dmg");
    mkdirSync(mountPoint, { recursive: true });
    const attach = spawnSync("hdiutil", ["attach", dmg, "-nobrowse", "-mountpoint", mountPoint], { stdio: "inherit" });
    if (attach.status !== 0) throw new Error(`DMG mount failed with ${attach.status}`);
    mounted = true;
    const installedApp = join(installRoot, "Applications", "TeamAI Sync.app");
    mkdirSync(join(installRoot, "Applications"), { recursive: true });
    const copy = spawnSync("ditto", [join(mountPoint, "TeamAI Sync.app"), installedApp], { stdio: "inherit" });
    if (copy.status !== 0) throw new Error(`Application copy failed with ${copy.status}`);
    executable = join(installedApp, "Contents", "MacOS", "TeamAI Sync");
  } else {
    throw new Error(`Unsupported smoke-test platform: ${process.platform}`);
  }

  if (!existsSync(executable)) throw new Error(`Installed executable not found: ${executable}`);
  const child = spawn(executable, [], {
    cwd: root,
    env: { ...process.env, TEAMAI_E2E_USER_DATA: userData },
    stdio: "ignore",
    windowsHide: true,
  });
  let childExited = false;
  child.once("close", () => { childExited = true; });
  const log = join(userData, "e2e.log");
  const deadline = Date.now() + 20_000;
  let started = false;
  while (Date.now() < deadline) {
    if (existsSync(log) && readFileSync(log, "utf8").includes("renderer load completed")) {
      started = true;
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  child.kill();
  const exitDeadline = Date.now() + 5_000;
  while (!childExited && Date.now() < exitDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  if (!childExited && process.platform === "win32" && child.pid) {
    spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  if (!started) throw new Error("Installed application did not complete renderer startup within 20 seconds.");
  console.log(`Installed application smoke test passed: ${executable}`);
} finally {
  if (mounted) spawnSync("hdiutil", ["detach", mountPoint, "-force"], { stdio: "inherit" });
}
