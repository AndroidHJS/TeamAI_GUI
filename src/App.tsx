import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Clipboard,
  Eye,
  EyeOff,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  TerminalSquare,
  Trash2,
  KeyRound,
  X,
} from "lucide-react";
import {
  cancelTeamAi,
  checkEnvironment,
  deleteSshCredential,
  getRecentDirectory,
  getSshCredentialState,
  onTeamAiCompleted,
  onTeamAiLog,
  runTeamAi,
  selectDirectory,
} from "./api";
import { parseAnsi } from "./ansi";
import type {
  Agent,
  CompletedEvent,
  DependencyStatus,
  EnvironmentReport,
  LogEvent,
  Operation,
  RunTeamAiRequest,
  Scope,
  SshCredentialState,
  TaskStatus,
} from "./types";
import { AGENTS } from "./types";

type ProjectState = "unchecked" | "checking" | "initialized" | "uninitialized" | "error";

interface TaskView {
  id: string | null;
  operation: Operation;
  status: TaskStatus;
  message?: string;
}

const operationLabels: Record<Operation, string> = {
  init: "初始化",
  status: "检查状态",
  pull: "拉取资源",
  push: "推送变更",
};

function hasExplicitSshUsername(repository: string): boolean {
  const value = repository.trim();
  if (/^[A-Za-z0-9._-]+@[^:]+:.+/.test(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "ssh:" && Boolean(parsed.username);
  } catch {
    return false;
  }
}

function DependencyRow({ dependency }: { dependency: DependencyStatus }) {
  const ok = dependency.available && dependency.compatible;
  return (
    <div className="dependency-row">
      <div className={`dependency-icon ${ok ? "is-ok" : "is-error"}`}>
        {ok ? <Check size={14} /> : <X size={14} />}
      </div>
      <div className="dependency-copy">
        <span>{dependency.name}</span>
        <small title={dependency.path ?? undefined}>{dependency.version ?? dependency.message}</small>
      </div>
      <span className={`dependency-state ${ok ? "is-ok" : "is-error"}`}>
        {ok ? "可用" : "需处理"}
      </span>
    </div>
  );
}

function LogLine({ event }: { event: LogEvent }) {
  const time = new Date(event.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
  return (
    <div className={`log-line stream-${event.stream}`} data-testid="log-line">
      <span className="log-time">{time}</span>
      <span className="log-stream">{event.stream === "stderr" ? "ERR" : "OUT"}</span>
      <span className="log-text">
        {parseAnsi(event.line).map((segment, index) => (
          <span
            key={`${event.sequence}-${index}`}
            className={[segment.className, segment.bold ? "ansi-bold" : ""].filter(Boolean).join(" ")}
          >
            {segment.text}
          </span>
        ))}
      </span>
    </div>
  );
}

function statusLabel(state: ProjectState) {
  switch (state) {
    case "checking":
      return "检查中";
    case "initialized":
      return "已初始化";
    case "uninitialized":
      return "未初始化";
    case "error":
      return "状态未知";
    default:
      return "未检查";
  }
}

export default function App() {
  const [environment, setEnvironment] = useState<EnvironmentReport | null>(null);
  const [environmentLoading, setEnvironmentLoading] = useState(true);
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [projectState, setProjectState] = useState<ProjectState>("unchecked");
  const [repository, setRepository] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const [showSshPassword, setShowSshPassword] = useState(false);
  const [rememberSshPassword, setRememberSshPassword] = useState(true);
  const [sshCredentialState, setSshCredentialState] = useState<SshCredentialState | null>(null);
  const [sshCredentialLoading, setSshCredentialLoading] = useState(false);
  const [sshCredentialMessage, setSshCredentialMessage] = useState("");
  const [scope, setScope] = useState<Scope>("project");
  const [role, setRole] = useState("");
  const [pushRole, setPushRole] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [force, setForce] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [task, setTask] = useState<TaskView | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const launchingOperationRef = useRef<Operation | null>(null);
  const completedIdsRef = useRef(new Set<string>());
  const operationByIdRef = useRef(new Map<string, Operation>());
  const autoCheckedDirectoryRef = useRef("");
  const autoRefreshedTaskRef = useRef("");

  const running = task?.status === "running";
  const ready = environment?.ready === true;
  const sshPasswordVisible = hasExplicitSshUsername(repository);

  const refreshSshCredentialState = useCallback(async (value: string) => {
    if (!hasExplicitSshUsername(value)) {
      setSshCredentialState(null);
      setSshCredentialMessage("");
      return;
    }
    setSshCredentialLoading(true);
    setSshCredentialMessage("");
    try {
      setSshCredentialState(await getSshCredentialState(value.trim()));
    } catch (error) {
      setSshCredentialState(null);
      setSshCredentialMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSshCredentialLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshSshCredentialState(repository), 250);
    return () => window.clearTimeout(timer);
  }, [refreshSshCredentialState, repository]);

  const refreshEnvironment = useCallback(async () => {
    setEnvironmentLoading(true);
    try {
      setEnvironment(await checkEnvironment());
    } catch (error) {
      setEnvironment(null);
      setTask({
        id: null,
        operation: "status",
        status: "failed",
        message: `环境检查失败：${String(error)}`,
      });
    } finally {
      setEnvironmentLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshEnvironment();
    void getRecentDirectory()
      .then((recent) => {
        if (recent) setWorkingDirectory(recent);
      })
      .catch(() => undefined);
  }, [refreshEnvironment]);

  const applyCompletion = useCallback((event: CompletedEvent, operation: Operation) => {
    completedIdsRef.current.add(event.taskId);
    setTask({
      id: event.taskId,
      operation,
      status: event.status,
      message: event.error?.message,
    });

    if (operation === "status") {
      if (event.status === "succeeded") setProjectState("initialized");
      else if (event.error?.kind === "notInitialized") setProjectState("uninitialized");
      else if (event.status !== "cancelled") setProjectState("error");
    } else if (operation === "init" && event.status === "succeeded") {
      setProjectState("initialized");
    }
    if (operation === "init") {
      setSshPassword("");
      setShowSshPassword(false);
      if (hasExplicitSshUsername(repository)) void refreshSshCredentialState(repository);
    }
  }, [refreshSshCredentialState, repository]);

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];

    cleanups.push(onTeamAiLog((payload) => {
      if (!disposed) setLogs((current) => [...current, payload]);
    }));

    cleanups.push(onTeamAiCompleted((payload) => {
      if (disposed) return;
      const operation = operationByIdRef.current.get(payload.taskId) ?? launchingOperationRef.current;
      if (operation) applyCompletion(payload, operation);
      launchingOperationRef.current = null;
    }));

    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [applyCompletion]);

  useEffect(() => {
    if (autoScroll) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, autoScroll]);

  const makeRequest = useCallback(
    (operation: Operation, directory = workingDirectory): RunTeamAiRequest => {
      const base: RunTeamAiRequest = { operation, workingDirectory: directory };
      if (operation === "init") {
        base.initOptions = {
          repository: repository.trim(),
          scope,
          role: role.trim() || undefined,
          agents: agents.length ? agents : undefined,
          force,
        };
        if (sshPasswordVisible && (sshPassword || sshCredentialState?.configured)) {
          base.authentication = {
            type: "sshPassword",
            password: sshPassword || undefined,
            remember: rememberSshPassword,
          };
        }
      } else if (operation === "push") {
        base.pushOptions = { role: pushRole.trim() || undefined };
      }
      return base;
    },
    [agents, force, pushRole, rememberSshPassword, repository, role, scope, sshCredentialState?.configured, sshPassword, sshPasswordVisible, workingDirectory],
  );

  const startOperation = useCallback(
    async (operation: Operation, directory = workingDirectory) => {
      if (!directory || running) return;
      if (operation !== "status" && !ready) {
        setTask({ id: null, operation, status: "failed", message: "请先补齐运行环境依赖。" });
        return;
      }
      if (operation === "init" && !repository.trim()) {
        setTask({ id: null, operation, status: "failed", message: "请输入团队仓库地址。" });
        return;
      }
      if (
        operation === "push" &&
        !window.confirm("将执行 teamai push --all，推送所有检测到的变更。确认继续吗？")
      ) {
        return;
      }

      launchingOperationRef.current = operation;
      if (operation === "status") setProjectState("checking");
      setTask({ id: null, operation, status: "running" });
      setLogs((current) => [
        ...current,
        {
          taskId: "local",
          stream: "stdout",
          line: `── ${operationLabels[operation]} ──`,
          timestamp: new Date().toISOString(),
          sequence: Number.MAX_SAFE_INTEGER - 1,
        },
      ]);

      try {
        const response = await runTeamAi(makeRequest(operation, directory));
        operationByIdRef.current.set(response.taskId, operation);
        if (!completedIdsRef.current.has(response.taskId)) {
          setTask({ id: response.taskId, operation, status: "running" });
        }
      } catch (error) {
        launchingOperationRef.current = null;
        if (operation === "status") setProjectState("error");
        const message =
          typeof error === "object" && error && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error);
        setTask({ id: null, operation, status: "failed", message });
      }
    },
    [makeRequest, ready, repository, running, workingDirectory],
  );

  useEffect(() => {
    if (!ready || !workingDirectory || running || autoCheckedDirectoryRef.current === workingDirectory) return;
    autoCheckedDirectoryRef.current = workingDirectory;
    void startOperation("status", workingDirectory);
  }, [ready, running, startOperation, workingDirectory]);

  useEffect(() => {
    if (!task?.id || task.status !== "succeeded" || task.operation === "status" || !ready || !workingDirectory) return;
    if (autoRefreshedTaskRef.current === task.id) return;
    autoRefreshedTaskRef.current = task.id;
    const timer = window.setTimeout(() => void startOperation("status", workingDirectory), 150);
    return () => window.clearTimeout(timer);
  }, [ready, startOperation, task, workingDirectory]);

  const chooseDirectory = async () => {
    const selected = await selectDirectory();
    if (typeof selected !== "string") return;
    const unchanged = selected === workingDirectory;
    setWorkingDirectory(selected);
    autoCheckedDirectoryRef.current = "";
    setProjectState("unchecked");
    if (unchanged) void startOperation("status", selected);
  };

  const cancel = async () => {
    if (!task?.id) return;
    try {
      await cancelTeamAi(task.id);
    } catch (error) {
      setTask((current) =>
        current ? { ...current, message: `取消失败：${String(error)}` } : current,
      );
    }
  };

  const toggleAgent = (agent: Agent) => {
    setAgents((current) =>
      current.includes(agent) ? current.filter((item) => item !== agent) : [...current, agent],
    );
  };

  const removeSshCredential = async () => {
    if (!sshCredentialState?.configured || running) return;
    if (!window.confirm(`删除 ${sshCredentialState.username}@${sshCredentialState.host}:${sshCredentialState.port} 的已保存密码？`)) return;
    try {
      await deleteSshCredential(repository.trim());
      setSshPassword("");
      setSshCredentialMessage("已删除保存的 SSH 密码。");
      await refreshSshCredentialState(repository);
    } catch (error) {
      setSshCredentialMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const taskSummary = useMemo(() => {
    if (!task) return "等待操作";
    if (task.status === "running") return `${operationLabels[task.operation]}运行中`;
    const suffix = { succeeded: "完成", failed: "失败", cancelled: "已取消" }[task.status];
    return `${operationLabels[task.operation]}${suffix}`;
  }, [task]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark"><GitBranch size={20} /></div>
        <div>
          <h1>TeamAI Sync</h1>
          <p>团队资源同步控制台</p>
        </div>
        <div className={`overall-status ${running ? "is-running" : ready ? "is-ready" : "is-warning"}`}>
          {running ? <LoaderCircle size={14} className="spin" /> : ready ? <Check size={14} /> : <AlertTriangle size={14} />}
          {running ? taskSummary : ready ? "环境就绪" : "需要配置"}
        </div>
      </header>

      <div className="workspace-grid">
        <section className="left-column">
          <article className="panel environment-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">01 · 环境</span>
                <h2>运行环境</h2>
              </div>
              <button className="icon-button" onClick={() => void refreshEnvironment()} disabled={environmentLoading || running} aria-label="重新检查环境">
                <RefreshCw size={16} className={environmentLoading ? "spin" : ""} />
              </button>
            </div>
            {environment ? (
              <div className="dependency-list">
                <DependencyRow dependency={environment.node} />
                <DependencyRow dependency={environment.git} />
                <DependencyRow dependency={environment.teamai} />
              </div>
            ) : (
              <div className="empty-inline"><LoaderCircle size={16} className="spin" /> 正在检查依赖…</div>
            )}
            {environment && !environment.ready && (
              <p className="callout warning">安装缺失组件后点击重新检查。应用不会自动安装系统依赖。</p>
            )}
          </article>

          <article className="panel directory-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">02 · 项目</span>
                <h2>工作目录</h2>
              </div>
              <span className={`project-badge state-${projectState}`}>{statusLabel(projectState)}</span>
            </div>
            <div className="directory-picker">
              <FolderOpen size={18} />
              <span title={workingDirectory}>{workingDirectory || "尚未选择目录"}</span>
              <button onClick={() => void chooseDirectory()} disabled={running}>选择</button>
            </div>
            <button className="secondary-button full" onClick={() => void startOperation("status")} disabled={!workingDirectory || running}>
              <RefreshCw size={15} /> 检查 TeamAI 状态
            </button>
          </article>

          <article className="panel init-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">03 · 初始化</span>
                <h2>连接团队仓库</h2>
              </div>
            </div>
            <label className="field">
              <span>仓库地址</span>
              <input value={repository} onChange={(event) => setRepository(event.target.value)} disabled={running} placeholder="https://github.com/org/team-resources.git" />
            </label>
            {sshPasswordVisible && (
              <div className="ssh-credential-card" data-testid="ssh-credential-card">
                <div className="ssh-credential-heading">
                  <span><KeyRound size={15} /> SSH 密码认证</span>
                  {sshCredentialLoading ? <small>检查中…</small> : sshCredentialState?.configured ? <small className="credential-saved">已保存</small> : <small>未保存</small>}
                </div>
                {sshCredentialState && (
                  <p className="ssh-endpoint">{sshCredentialState.username}@{sshCredentialState.host}:{sshCredentialState.port}</p>
                )}
                <label className="field">
                  <span>{sshCredentialState?.configured ? "新密码（留空使用已保存密码）" : "SSH 密码（可选，留空使用密钥认证）"}</span>
                  <span className="password-input">
                    <input
                      type={showSshPassword ? "text" : "password"}
                      value={sshPassword}
                      onChange={(event) => setSshPassword(event.target.value)}
                      disabled={running}
                      maxLength={1024}
                      autoComplete="new-password"
                      aria-label="SSH 密码"
                    />
                    <button type="button" onClick={() => setShowSshPassword((value) => !value)} disabled={running} aria-label={showSshPassword ? "隐藏 SSH 密码" : "显示 SSH 密码"}>
                      {showSshPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </span>
                </label>
                <div className="ssh-credential-actions">
                  <label className="check-row">
                    <input type="checkbox" checked={rememberSshPassword} onChange={(event) => setRememberSshPassword(event.target.checked)} disabled={running} />
                    <span>使用系统安全存储记住密码</span>
                  </label>
                  {sshCredentialState?.configured && <button type="button" className="link-danger" onClick={() => void removeSshCredential()} disabled={running}>删除密码</button>}
                </div>
                {sshPassword && sshCredentialState?.configured && <small className="credential-update-hint">初始化成功后才会更新已保存密码。</small>}
                {sshCredentialMessage && <p className="credential-message">{sshCredentialMessage}</p>}
              </div>
            )}
            <div className="field">
              <span>安装范围</span>
              <div className="segmented">
                <button className={scope === "project" ? "active" : ""} onClick={() => setScope("project")} disabled={running}>项目级</button>
                <button className={scope === "user" ? "active" : ""} onClick={() => setScope("user")} disabled={running}>用户级</button>
              </div>
              <small>{scope === "project" ? "资源写入当前项目目录" : "资源写入用户主目录，所选目录仅作为命令工作目录"}</small>
            </div>
            <button className="advanced-toggle" onClick={() => setAdvancedOpen((value) => !value)} disabled={running}>
              高级选项 {advancedOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
            {advancedOpen && (
              <div className="advanced-fields">
                <label className="field">
                  <span>角色 ID（可选）</span>
                  <input value={role} onChange={(event) => setRole(event.target.value)} disabled={running} placeholder="hai_dev" />
                </label>
                <div className="field">
                  <span>目标 Agent（可选）</span>
                  <div className="agent-grid">
                    {AGENTS.map((agent) => (
                      <label key={agent} className={agents.includes(agent) ? "selected" : ""}>
                        <input type="checkbox" checked={agents.includes(agent)} onChange={() => toggleAgent(agent)} disabled={running} />
                        {agent}
                      </label>
                    ))}
                  </div>
                </div>
                <label className="check-row">
                  <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} disabled={running} />
                  <span>重新初始化并覆盖已有配置（--force）</span>
                </label>
              </div>
            )}
            <button className="primary-button full" onClick={() => void startOperation("init")} disabled={!workingDirectory || !repository.trim() || !ready || running}>
              <Play size={15} fill="currentColor" /> {force ? "重新初始化" : "初始化 TeamAI"}
            </button>
          </article>
        </section>

        <section className="right-column">
          <article className="panel sync-panel">
            <div className="panel-heading sync-heading">
              <div>
                <span className="eyebrow">04 · 同步</span>
                <h2>同步操作</h2>
              </div>
              <span className={`task-pill status-${task?.status ?? "idle"}`}>{taskSummary}</span>
            </div>
            <div className="sync-actions">
              <button className="action-card" onClick={() => void startOperation("pull")} disabled={!workingDirectory || !ready || running}>
                <span className="action-icon pull"><ChevronDown size={22} /></span>
                <span><strong>拉取资源</strong><small>从团队仓库获取最新内容</small></span>
              </button>
              <button className="action-card" onClick={() => void startOperation("push")} disabled={!workingDirectory || !ready || running}>
                <span className="action-icon push"><ChevronUp size={22} /></span>
                <span><strong>推送变更</strong><small>推送所有本地检测到的变更</small></span>
              </button>
            </div>
            <label className="field compact-field">
              <span>推送角色（可选）</span>
              <input value={pushRole} onChange={(event) => setPushRole(event.target.value)} disabled={running} placeholder="使用已配置的主角色" />
            </label>
            {running && (
              <button className="danger-button" onClick={() => void cancel()} disabled={!task?.id}>
                <CircleStop size={16} /> 取消当前任务
              </button>
            )}
            {task?.message && <p className="callout error">{task.message}</p>}
          </article>

          <article className="panel log-panel">
            <div className="panel-heading log-heading">
              <div className="log-title">
                <TerminalSquare size={17} />
                <h2>实时日志</h2>
                <span>{logs.length}</span>
              </div>
              <div className="log-tools">
                <label><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} /> 自动滚动</label>
                <button className="icon-button" onClick={() => void navigator.clipboard.writeText(logs.map((item) => item.line).join("\n"))} disabled={!logs.length} aria-label="复制日志"><Clipboard size={15} /></button>
                <button className="icon-button" onClick={() => setLogs([])} disabled={!logs.length} aria-label="清空日志"><Trash2 size={15} /></button>
              </div>
            </div>
            <div className="terminal" role="log" aria-live="polite">
              {logs.length ? logs.map((event, index) => <LogLine key={`${event.taskId}-${event.sequence}-${index}`} event={event} />) : (
                <div className="terminal-empty"><TerminalSquare size={28} /><span>任务输出将在这里实时显示</span></div>
              )}
              <div ref={logEndRef} />
            </div>
            <footer className="terminal-footer">
              <span><i className={running ? "pulse" : ""} /> {running ? "进程运行中" : "无活动进程"}</span>
              <span>仅文本安全渲染</span>
            </footer>
          </article>
        </section>
      </div>

      <footer className="app-footer">
        <span>TeamAI Sync GUI · v0.1.0</span>
        <span><RotateCcw size={12} /> 非交互模式</span>
      </footer>
    </main>
  );
}
