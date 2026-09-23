import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync, writeSync } from "node:fs";
import { createServer, createConnection, type Server } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const AUX_MODE = "TEAMAI_SSH_AUX_MODE";
const PIPE = "TEAMAI_ASKPASS_PIPE";
const TOKEN = "TEAMAI_ASKPASS_TOKEN";
const SSH_EXECUTABLE = "TEAMAI_SSH_EXECUTABLE";
const KNOWN_HOSTS = "TEAMAI_SSH_KNOWN_HOSTS";
const MAX_ASKPASS_REQUESTS = 6;

function auxiliaryDiagnostic(message: string): void {
  const directory = process.env.TEAMAI_E2E_USER_DATA;
  if (!directory) return;
  try {
    appendFileSync(join(directory, "e2e.log"), `${new Date().toISOString()} ssh-helper ${message}\n`, "utf8");
  } catch {
    // Test-only diagnostics must never affect authentication.
  }
}

export interface PasswordBroker {
  environment: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

function auxiliaryArguments(): string[] {
  return process.argv.slice(1);
}

async function runAskpass(): Promise<number> {
  const pipe = process.env[PIPE];
  const token = process.env[TOKEN];
  auxiliaryDiagnostic("askpass started");
  if (!pipe || !token) {
    auxiliaryDiagnostic("askpass missing capability");
    return 2;
  }
  return new Promise<number>((resolve) => {
    const socket = createConnection(pipe);
    let response = "";
    const timeout = setTimeout(() => { auxiliaryDiagnostic("askpass timeout"); socket.destroy(); resolve(3); }, 10_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => { auxiliaryDiagnostic("askpass connected"); socket.write(`${token}\n`); });
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("error", () => { auxiliaryDiagnostic("askpass connection error"); clearTimeout(timeout); resolve(3); });
    socket.on("end", () => {
      clearTimeout(timeout);
      if (!response.endsWith("\n")) {
        auxiliaryDiagnostic("askpass empty response");
        return resolve(3);
      }
      try {
        writeSync(1, response);
        auxiliaryDiagnostic("askpass response written");
        resolve(0);
      } catch {
        auxiliaryDiagnostic("askpass stdout error");
        resolve(4);
      }
    });
  });
}

async function runSshWrapper(): Promise<number> {
  auxiliaryDiagnostic("wrapper started");
  const ssh = process.env[SSH_EXECUTABLE];
  const knownHosts = process.env[KNOWN_HOSTS];
  if (!ssh || !knownHosts || !existsSync(ssh)) return 2;
  const askpass = process.platform === "win32" ? join(process.resourcesPath, "teamai-askpass.exe") : process.execPath;
  if (!existsSync(askpass)) return 2;
  mkdirSync(dirname(knownHosts), { recursive: true });
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const fixedArgs = [
    "-F", nullDevice,
    "-o", "BatchMode=no",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", `GlobalKnownHostsFile=${nullDevice}`,
    "-o", "PubkeyAuthentication=no",
    "-o", "PasswordAuthentication=yes",
    "-o", "KbdInteractiveAuthentication=yes",
    "-o", "PreferredAuthentications=keyboard-interactive,password",
    "-o", "NumberOfPasswordPrompts=3",
  ];
  return new Promise<number>((resolve) => {
    const child = spawn(ssh, [...fixedArgs, ...auxiliaryArguments()], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        [AUX_MODE]: "askpass",
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: process.env.DISPLAY || "teamai-askpass",
      },
    });
    child.once("error", () => resolve(126));
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export async function runSshAuxiliaryMode(): Promise<boolean> {
  const mode = process.env[AUX_MODE];
  if (mode !== "wrapper" && mode !== "askpass") return false;
  const code = mode === "wrapper" ? await runSshWrapper() : await runAskpass();
  process.exit(code);
  return true;
}

export async function createPasswordBroker(password: string, userDataDirectory: string, sshExecutable: string): Promise<PasswordBroker> {
  const token = randomBytes(32).toString("hex");
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\teamai-askpass-${randomUUID()}`
    : join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), `teamai-${randomUUID().slice(0, 12)}.sock`);
  if (process.platform !== "win32") rmSync(endpoint, { force: true });
  let requests = 0;
  let closed = false;
  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    let received = "";
    let handled = false;
    const timer = setTimeout(() => socket.destroy(), 5_000);
    socket.on("data", (chunk) => {
      if (handled) return;
      received += chunk;
      if (!received.includes("\n")) return;
      handled = true;
      clearTimeout(timer);
      const candidate = received.slice(0, received.indexOf("\n"));
      const left = Buffer.from(candidate);
      const right = Buffer.from(token);
      const authenticated = left.length === right.length && timingSafeEqual(left, right);
      requests += 1;
      if (!authenticated || requests > MAX_ASKPASS_REQUESTS || closed) {
        socket.end();
        return;
      }
      socket.end(`${password}\n`);
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve());
  });
  if (process.platform !== "win32") chmodSync(endpoint, 0o600);
  const timeout = setTimeout(() => void close(), 15 * 60_000);
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") rmSync(endpoint, { force: true });
  };
  const knownHosts = join(userDataDirectory, "ssh", "known_hosts");
  mkdirSync(dirname(knownHosts), { recursive: true });
  return {
    environment: {
      GIT_SSH: process.execPath,
      GIT_SSH_VARIANT: "ssh",
      GIT_TERMINAL_PROMPT: "0",
      [AUX_MODE]: "wrapper",
      [PIPE]: endpoint,
      [TOKEN]: token,
      [SSH_EXECUTABLE]: sshExecutable,
      [KNOWN_HOSTS]: knownHosts,
    },
    close,
  };
}
