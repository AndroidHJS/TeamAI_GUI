#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const command = args[0];
const cwd = process.cwd();
const initializedMarker = join(cwd, ".teamai-e2e-initialized");
const endpointMarker = join(cwd, ".teamai-e2e-endpoint.json");
const auditMarker = join(cwd, ".teamai-e2e-audit.json");
const slowMarker = join(cwd, ".teamai-e2e-slow");
const childPidMarker = join(cwd, ".teamai-e2e-child-pid");

if (args.includes("--version")) {
  console.log("0.22.0");
  process.exit(0);
}

function parseEndpoint(repository) {
  const parsed = new URL(repository);
  return { username: decodeURIComponent(parsed.username), host: parsed.hostname, port: Number(parsed.port || "22") };
}

function audit() {
  writeFileSync(auditMarker, JSON.stringify({
    args,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(GIT_|SSH_|TEAMAI_)/.test(key))),
  }), "utf8");
}

async function authenticate(endpoint) {
  audit();
  const wrapper = process.env.GIT_SSH;
  if (!wrapper) {
    console.error("Permission denied (password,keyboard-interactive).");
    return false;
  }
  return new Promise((resolve) => {
    const child = spawn(wrapper, ["-p", String(endpoint.port), `${endpoint.username}@${endpoint.host}`, "teamai-e2e"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.once("error", (error) => { console.error(error.message); resolve(false); });
    child.once("close", (code) => resolve(code === 0));
  });
}

async function main() {
  if (command === "status") {
    if (!existsSync(initializedMarker)) {
      console.error("Not initialized. Run teamai init first.");
      process.exit(1);
    }
    console.log("Project initialized");
    return;
  }

  if (command === "init") {
    const repository = args[1];
    const endpoint = parseEndpoint(repository);
    if (!await authenticate(endpoint)) process.exit(1);
    writeFileSync(endpointMarker, JSON.stringify(endpoint), "utf8");
    writeFileSync(initializedMarker, JSON.stringify({ args, cwd }), "utf8");
    console.log(`Initialized ${repository}`);
    return;
  }

  if (command === "pull" || command === "push") {
    if (!existsSync(endpointMarker)) {
      console.error("Not initialized. Run teamai init first.");
      process.exit(1);
    }
    const endpoint = JSON.parse(readFileSync(endpointMarker, "utf8"));
    if (command === "pull" && existsSync(slowMarker)) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => console.log('long pull tick'), 250)"], { stdio: ["ignore", "pipe", "pipe"] });
      writeFileSync(childPidMarker, String(child.pid), "utf8");
      child.stdout.pipe(process.stdout);
      await new Promise(() => undefined);
      return;
    }
    if (!await authenticate(endpoint)) process.exit(1);
    if (command === "pull") {
      console.error("diagnostic stream check");
      console.log("Pull complete");
    } else {
      console.log(`Push complete with args: ${args.join(" ")}`);
    }
    return;
  }

  console.error(`Unsupported fixture command: ${command}`);
  process.exit(2);
}

await main();
