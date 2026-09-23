export type Operation = "init" | "status" | "pull" | "push";
export type TaskStatus = "running" | "succeeded" | "failed" | "cancelled";
export type Stream = "stdout" | "stderr";
export type Scope = "project" | "user";

export const AGENTS = [
  "claude",
  "codex",
  "cursor",
  "joycode",
  "codebuddy",
  "workbuddy",
  "dsh",
] as const;

export type Agent = (typeof AGENTS)[number];

export interface DependencyStatus {
  name: string;
  available: boolean;
  compatible: boolean;
  version: string | null;
  path: string | null;
  message: string;
}

export interface EnvironmentReport {
  ready: boolean;
  checkedAt: string;
  node: DependencyStatus;
  git: DependencyStatus;
  teamai: DependencyStatus;
}

export interface InitOptions {
  repository: string;
  scope: Scope;
  role?: string;
  agents?: Agent[];
  force: boolean;
}

export interface SshPasswordAuthentication {
  type: "sshPassword";
  password?: string;
  remember: boolean;
}

export interface PushOptions {
  role?: string;
}

export interface RunTeamAiRequest {
  operation: Operation;
  workingDirectory: string;
  initOptions?: InitOptions;
  pushOptions?: PushOptions;
  authentication?: SshPasswordAuthentication;
}

export interface SshCredentialStateRequest {
  workingDirectory: string;
  repository?: string;
}

export interface SshCredentialState {
  configured: boolean;
  username: string | null;
  host: string | null;
  port: number | null;
}

export interface StartTaskResponse {
  taskId: string;
}

export interface CancelAck {
  accepted: boolean;
  alreadyRequested: boolean;
}

export interface LogEvent {
  taskId: string;
  stream: Stream;
  line: string;
  timestamp: string;
  sequence: number;
}

export interface TaskError {
  kind: string;
  message: string;
}

export interface CompletedEvent {
  taskId: string;
  exitCode: number | null;
  durationMs: number;
  status: Exclude<TaskStatus, "running">;
  error?: TaskError | null;
}
