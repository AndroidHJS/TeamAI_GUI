import { existsSync, realpathSync, statSync } from "node:fs";
import type { Agent, InitOptions, Operation, PushOptions, Scope } from "../src/types";

export class ApiError extends Error {
  constructor(public readonly kind: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

const allowedAgents = new Set<Agent>(["claude", "codex", "cursor", "joycode", "codebuddy", "workbuddy", "dsh"]);
const rolePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ownerRepoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const scpRepoPattern = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+(?:\.git)?$/;

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
  if (!["https:", "http:", "ssh:"].includes(parsed.protocol) || !parsed.hostname) throw new ApiError("invalidRepository", "仓库地址仅支持 HTTPS、HTTP 或 SSH 协议并且必须包含主机名。");
  if (["https:", "http:"].includes(parsed.protocol) && (parsed.username || parsed.password)) throw new ApiError("embeddedCredential", "请勿在仓库 URL 中嵌入用户名或凭据。");
  return repository;
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

export function validateAndBuildRequest(value: unknown): { args: string[]; workingDirectory: string; operation: Operation } {
  assertRecord(value, "request");
  assertKeys(value, ["operation", "workingDirectory", "initOptions", "pushOptions"], "request");
  const operation = value.operation;
  if (!( ["init", "status", "pull", "push"] as unknown[]).includes(operation)) throw new ApiError("invalidOperation", "不支持的 TeamAI 操作。");
  if (typeof value.workingDirectory !== "string") throw new ApiError("invalidDirectory", "工作目录必须是字符串。");
  const workingDirectory = canonicalizeDirectory(value.workingDirectory);
  if (operation === "init") {
    if (value.pushOptions !== undefined) throw new ApiError("invalidOptions", "init 操作不能携带 pushOptions。");
    const options = validateInitOptions(value.initOptions);
    const args = ["init", options.repository, "--scope", options.scope];
    if (options.role) args.push("--role", options.role);
    if (options.agents?.length) args.push("--agent", options.agents.join(","));
    if (options.force) args.push("--force");
    return { args, workingDirectory, operation };
  }
  if (operation === "status" || operation === "pull") {
    if (value.initOptions !== undefined || value.pushOptions !== undefined) throw new ApiError("invalidOptions", "status/pull 操作不接受额外选项。");
    return { args: [operation], workingDirectory, operation };
  }
  if (value.initOptions !== undefined) throw new ApiError("invalidOptions", "push 操作不能携带 initOptions。");
  const options = validatePushOptions(value.pushOptions);
  const args = ["push", "--all"];
  if (options.role) args.push("--role", options.role);
  return { args, workingDirectory, operation: "push" };
}

