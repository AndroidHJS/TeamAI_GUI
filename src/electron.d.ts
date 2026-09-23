import type {
  CancelAck,
  CompletedEvent,
  EnvironmentReport,
  LogEvent,
  RunTeamAiRequest,
  SshCredentialState,
  StartTaskResponse,
  DeleteSshCredentialResult,
} from "./types";

declare global {
  interface Window {
    teamai: {
      checkEnvironment(): Promise<EnvironmentReport>;
      runTeamAi(request: RunTeamAiRequest): Promise<StartTaskResponse>;
      cancelTeamAi(taskId: string): Promise<CancelAck>;
      selectDirectory(): Promise<string | null>;
      getRecentDirectory(): Promise<string | null>;
      getSshCredentialState(repository: string): Promise<SshCredentialState>;
      deleteSshCredential(repository: string): Promise<DeleteSshCredentialResult>;
      onLog(callback: (event: LogEvent) => void): () => void;
      onCompleted(callback: (event: CompletedEvent) => void): () => void;
    };
  }
}

export {};
