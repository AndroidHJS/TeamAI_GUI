import type {
  CancelAck,
  EnvironmentReport,
  RunTeamAiRequest,
  StartTaskResponse,
} from "./types";

export const checkEnvironment = () =>
  window.teamai.checkEnvironment();

export const runTeamAi = (request: RunTeamAiRequest) =>
  window.teamai.runTeamAi(request);

export const cancelTeamAi = (taskId: string) =>
  window.teamai.cancelTeamAi(taskId);

export const selectDirectory = () => window.teamai.selectDirectory();
export const getRecentDirectory = () => window.teamai.getRecentDirectory();
export const onTeamAiLog = (callback: (event: import("./types").LogEvent) => void) =>
  window.teamai.onLog(callback);
export const onTeamAiCompleted = (callback: (event: import("./types").CompletedEvent) => void) =>
  window.teamai.onCompleted(callback);
