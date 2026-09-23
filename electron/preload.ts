import { contextBridge, ipcRenderer } from "electron";
import type { CompletedEvent, LogEvent, RunTeamAiRequest, SshCredentialStateRequest } from "../src/types";

const api = {
  checkEnvironment: () => ipcRenderer.invoke("teamai:check-environment"),
  runTeamAi: (request: RunTeamAiRequest) => ipcRenderer.invoke("teamai:run", request),
  cancelTeamAi: (taskId: string) => ipcRenderer.invoke("teamai:cancel", taskId),
  selectDirectory: () => ipcRenderer.invoke("teamai:select-directory"),
  getRecentDirectory: () => ipcRenderer.invoke("teamai:get-recent-directory"),
  getSshCredentialState: (request: SshCredentialStateRequest) => ipcRenderer.invoke("teamai:get-ssh-credential-state", request),
  deleteSshCredential: (request: SshCredentialStateRequest) => ipcRenderer.invoke("teamai:delete-ssh-credential", request),
  onLog: (callback: (event: LogEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: LogEvent) => callback(payload);
    ipcRenderer.on("teamai:log", listener);
    return () => ipcRenderer.removeListener("teamai:log", listener);
  },
  onCompleted: (callback: (event: CompletedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: CompletedEvent) => callback(payload);
    ipcRenderer.on("teamai:completed", listener);
    return () => ipcRenderer.removeListener("teamai:completed", listener);
  },
};

contextBridge.exposeInMainWorld("teamai", Object.freeze(api));
