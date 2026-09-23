import type {
  CancelAck,
  CompletedEvent,
  EnvironmentReport,
  LogEvent,
  RunTeamAiRequest,
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
      onLog(callback: (event: LogEvent) => void): () => void;
      onCompleted(callback: (event: CompletedEvent) => void): () => void;
    };
  }
}

export {};
