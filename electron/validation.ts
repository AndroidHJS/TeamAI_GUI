import { existsSync, realpathSync, statSync } from "node:fs";
import type { Agent, InitOptions, Operation, PushOptions, Scope, SshPasswordAuthentication } from "../src/types";

export class ApiError extends Error {
  constructor(public readonly kind: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

const allowedAgents = new Set<Agent>(["claude", "codex", "cursor", "joycode", "codebuddy", "workbuddy", "dsh"]);
const rolePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ownerRepoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const scpRepoPattern = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9_./-]+(?:\.git)?)$/;

export interface SshTarget {
  username: string;
  host: string;
  port: number;
  credentialId: string;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("invalidRequest", `${label} 必须是对象。`);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ApiError("invalidOptions", `${label} 包含未知字段：${unknown.join(", ")}`);
}

export function validateRole(role: unknown): string | undefined {
  if (role === undefined || role === null || role === "") return undefined;
  if (typeof role !== "string" || !rolePattern.test(role)) throw new ApiError("invalidRole", "角色 ID 只能包含字母、数字、下划线和短横线，且最长 64 个字符。");
  return role;
}

export function validateRepository(value: unknown): string {
  if (typeof value !== "string") throw new ApiError("invalidRepository", "仓库地址必须是字符串。");
  const repository = value.trim();
  if (!repository || repository.startsWith("-") || /[\u0000-\u001f\u007f]/.test(repository)) throw new ApiError("invalidRepository", "仓库地址为空或包含不允许的字符。");
  if (ownerRepoPattern.test(repository) || scpRepoPattern.test(repository)) return repository;
  let parsed: URL;
  try { parsed = new URL(repository); } catch { throw new ApiError("invalidRepository", "请输入 HTTPS、SSH、git@host:path 或 owner/repo 格式的仓库地址。"); }
  if (parsed.protocol === "http:") throw new ApiError("insecureRepository", "普通 HTTP 不受支持，请使用 HTTPS 或 SSH 仓库地址。");
  if (!["https:", "ssh:"].includes(parsed.protocol) || !parsed.hostname) throw new ApiError("invalidRepository", "仓库地址仅支持 HTTPS、SSH、git@host:path 或 owner/repo 格式。");
  if (parsed.protocol === "https:" && (parsed.username || parsed.password)) throw new ApiError("embeddedCredential", "请勿在仓库 URL 中嵌入用户名或凭据。");
  if (parsed.protocol === "ssh:" && (!parsed.username || parsed.password)) throw new ApiError("invalidRepository", "SSH 地址必须包含用户名且不能嵌入密码。");
  return repository;
}

export function parseSshRepository(value: unknown): SshTarget | null {
  const repository = validateRepository(value);
  const scp = repository.match(scpRepoPattern);
  if (scp) {
    const [, username, host] = scp;
    return { username, host: host.toLowerCase(), port: 22, credentialId: `${username}@${host.toLowerCase()}:22` };
  }
  if (!repository.startsWith("ssh://")) return null;
  const parsed = new URL(repository);
  const port = parsed.port ? Number(parsed.port) : 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError("invalidRepository", "SSH 端口必须在 1 到 65535 之间。");
  const username = decodeURIComponent(parsed.username);
  const host = parsed.hostname.toLowerCase();
  if (!/^[A-Za-z0-9._-]+$/.test(username) || !/^\/[A-Za-z0-9_./-]+(?:\.git)?$/.test(parsed.pathname) || parsed.search || parsed.hash) {
    throw new ApiError("invalidRepository", "SSH 地址的用户名或仓库路径包含不允许的字符。");
  }
  return { username, host, port, credentialId: `${username}@${host}:${port}` };
}

function validateAuthentication(value: unknown): SshPasswordAuthentication | undefined {
  if (value === undefined || value === null) return undefined;
  assertRecord(value, "authentication");
  assertKeys(value, ["type", "password", "remember"], "authentication");
  if (value.type !== "sshPassword") throw new ApiError("invalidAuthentication", "仅支持 SSH 密码认证。");
  if (typeof value.remember !== "boolean") throw new ApiError("invalidAuthentication", "remember 必须是布尔值。");
  if (value.password !== undefined && (typeof value.password !== "string" || !value.password || /[\u0000-\u001f\u007f]/.test(value.password))) {
    throw new ApiError("invalidAuthentication", "SSH 密码不能为空或包含控制字符。");
  }
  return { type: "sshPassword", password: value.password as string | undefined, remember: value.remember };
}

function validateAgents(value: unknown): Agent[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((agent) => typeof agent !== "string" || !allowedAgents.has(agent as Agent))) throw new ApiError("invalidAgent", "Agent 列表包含不支持的值。");
  return [...new Set(value as Agent[])];
}

function validateInitOptions(value: unknown): InitOptions {
  assertRecord(value, "initOptions");
  assertKeys(value, ["repository", "scope", "role", "agents", "force"], "initOptions");
  if (value.scope !== "project" && value.scope !== "user") throw new ApiError("invalidScope", "scope 必须是 project 或 user。");
  if (typeof value.force !== "boolean") throw new ApiError("invalidOptions", "force 必须是布尔值。");
  return { repository: validateRepository(value.repository), scope: value.scope as Scope, role: validateRole(value.role), agents: validateAgents(value.agents), force: value.force };
}

function validatePushOptions(value: unknown): PushOptions {
  if (value === undefined || value === null) return {};
  assertRecord(value, "pushOptions");
  assertKeys(value, ["role"], "pushOptions");
  return { role: validateRole(value.role) };
}

export function canonicalizeDirectory(value: string): string {
  if (!value || !existsSync(value)) throw new ApiError("invalidDirectory", "所选工作目录不存在。");
  let canonical: string;
  try { canonical = realpathSync.native(value); } catch (error) { throw new ApiError("invalidDirectory", `无法解析工作目录：${String(error)}`); }
  if (!statSync(canonical).isDirectory()) throw new ApiError("invalidDirectory", "所选路径不是目录。");
  return canonical;
}

export function validateAndBuildRequest(value: unknown): { args: string[]; workingDirectory: string; operation: Operation; authentication?: SshPasswordAuthentication; sshTarget?: SshTarget } {
  assertRecord(value, "request");
  assertKeys(value, ["operation", "workingDirectory", "initOptions", "pushOptions", "authentication"], "request");
  const operation = value.operation;
  if (!( ["init", "status", "pull", "push"] as unknown[]).includes(operation)) throw new ApiError("invalidOperation", "不支持的 TeamAI 操作。");
  if (typeof value.workingDirectory !== "string") throw new ApiError("invalidDirectory", "工作目录必须是字符串。");
  const workingDirectory = canonicalizeDirectory(value.workingDirectory);
  const authentication = validateAuthentication(value.authentication);
  if (operation === "init") {
    if (value.pushOptions !== undefined) throw new ApiError("invalidOptions", "init 操作不能携带 pushOptions。");
    const options = validateInitOptions(value.initOptions);
    const sshTarget = parseSshRepository(options.repository) ?? undefined;
    if (authentication && !sshTarget) throw new ApiError("invalidAuthentication", "SSH 密码只能用于 SSH 仓库地址。");
    const args = ["init", options.repository, "--scope", options.scope];
    if (options.role) args.push("--role", options.role);
    if (options.agents?.length) args.push("--agent", options.agents.join(","));
    if (options.force) args.push("--force");
    return { args, workingDirectory, operation, authentication, sshTarget };
  }
  if (operation === "status" || operation === "pull") {
    if (value.initOptions !== undefined || value.pushOptions !== undefined) throw new ApiError("invalidOptions", "status/pull 操作不接受额外选项。");
    return { args: [operation], workingDirectory, operation, authentication };
  }
  if (value.initOptions !== undefined) throw new ApiError("invalidOptions", "push 操作不能携带 initOptions。");
  const options = validatePushOptions(value.pushOptions);
  const args = ["push", "--all"];
  if (options.role) args.push("--role", options.role);
  return { args, workingDirectory, operation: "push", authentication };
}
