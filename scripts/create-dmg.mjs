import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../package.json" with { type: "json" };

if (process.platform !== "darwin") throw new Error("DMG creation must run on macOS.");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const release = join(root, "release");
const appDirectory = readdirSync(release, { withFileTypes: true })
  .find((entry) => entry.isDirectory() && entry.name.startsWith("mac"))?.name;
if (!appDirectory) throw new Error("Packaged macOS application directory was not found.");
const source = join(release, appDirectory, "TeamAI Sync.app");
if (!existsSync(source)) throw new Error(`Packaged application was not found: ${source}`);
const destination = join(release, `TeamAI Sync-${manifest.version}-${process.arch}.dmg`);
rmSync(destination, { force: true });
const result = spawnSync("hdiutil", [
  "create",
  "-volname", "TeamAI Sync",
  "-srcfolder", source,
  "-ov",
  "-format", "UDZO",
  destination,
], { stdio: "inherit" });
if (result.status !== 0) throw new Error(`hdiutil failed with exit code ${result.status}`);
console.log(`Created ${destination}`);
