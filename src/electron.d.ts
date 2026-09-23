import type {
  CancelAck,
  CompletedEvent,
  EnvironmentReport,
  LogEvent,
  RunTeamAiRequest,
  SshCredentialState,
  SshCredentialStateRequest,
  StartTaskResponse,
} from "./types";

declare global {
  interface Window {
    teamai: {
      checkEnvironment(): Promise<EnvironmentReport>;
      runTeamAi(request: RunTeamAiRequest): Promise<StartTaskResponse>;
      cancelTeamAi(taskId: string): Promise<CancelAck>;
      selectDirectory(): Promise<string | null>;
      getRecentDirectory(): Promise<string | null>;
      getSshCredentialState(request: SshCredentialStateRequest): Promise<SshCredentialState>;
      deleteSshCredential(request: SshCredentialStateRequest): Promise<SshCredentialState>;
      onLog(callback: (event: LogEvent) => void): () => void;
      onCompleted(callback: (event: CompletedEvent) => void): () => void;
    };
  }
}

export {};
