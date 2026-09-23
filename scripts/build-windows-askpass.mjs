import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") process.exit(0);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = join(root, ".windows-helper");
const helper = join(outputDirectory, "teamai-askpass.exe");
const blob = join(outputDirectory, "teamai-askpass.blob");
const config = join(outputDirectory, "sea-config.json");
const source = join(root, "electron", "askpass-helper.cjs");
const postject = join(root, "node_modules", "postject", "dist", "cli.js");

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(config, JSON.stringify({
  main: source,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}), "utf8");

const prepare = spawnSync(process.execPath, ["--experimental-sea-config", config], { cwd: root, stdio: "inherit", shell: false });
if (prepare.status !== 0) process.exit(prepare.status ?? 1);
copyFileSync(process.execPath, helper);
const inject = spawnSync(process.execPath, [
  postject,
  helper,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
], { cwd: root, stdio: "inherit", shell: false });
process.exit(inject.status ?? 1);
