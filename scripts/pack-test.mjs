import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.platform === "win32" ? "--win" : process.platform === "darwin" ? "--mac" : "--linux";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(root, "node_modules", "electron-builder", "cli.js");
if (process.platform === "win32") {
  const helper = spawnSync(process.execPath, [join(root, "scripts", "build-windows-askpass.mjs")], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (helper.status !== 0) process.exit(helper.status ?? 1);
}
const result = spawnSync(process.execPath, [cli, "--dir", target, "--publish", "never"], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
