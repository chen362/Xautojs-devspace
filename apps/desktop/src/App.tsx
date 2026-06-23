import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_DAEMON_URL,
  cancelOperatorRun,
  dispatchOperatorOnce,
  loadOperatorSnapshot,
  mergeReplayStreamMessage,
  pendingApproval,
  resolveOperatorApproval,
  resumeOperatorRun,
  retryOperatorRun,
  statusLabel,
  streamOperatorReplay,
  type OperatorApproval,
  type OperatorConnectionSnapshot,
  type OperatorConnectionStatus,
  type OperatorHookDecision,
  type OperatorReplayEvent,
  type OperatorRun,
  type OperatorRunStatus,
  type OperatorWorkflowStep,
} from "./operator-client.js";

const DAEMON_URL_STORAGE_KEY = "xautojs.desktop.daemonUrl";

type StreamState = "idle" | "connecting" | "live" | "polling" | "ended" | "error";

const initialSnapshot: OperatorConnectionSnapshot = {
  status: "checking",
  daemonUrl: DEFAULT_DAEMON_URL,
  message: "Checking local operator daemon...",
  runs: [],
};

export default function App() {
  const [daemonUrl, setDaemonUrl] = useState(readStoredDaemonUrl);
  const [token, setToken] = useState("");
  const [snapshot, setSnapshot] = useState<OperatorConnectionSnapshot>(initialSnapshot);
  const [lastCheckedAt, setLastCheckedAt] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [streamError, setStreamError] = useState<string>();
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [workflowId, setWorkflowId] = useState("manual");
  const [automationRunId, setAutomationRunId] = useState("");
  const [approvalMessage, setApprovalMessage] = useState("Approved from Xautojs Desktop");
  const [denyMessage, setDenyMessage] = useState("Denied from Xautojs Desktop");
  const [retryReason, setRetryReason] = useState("Retry from Xautojs Desktop");
  const [cancelReason, setCancelReason] = useState("Cancelled from Xautojs Desktop");

  async function refresh(selectedRunId?: string): Promise<void> {
    const nextDaemonUrl = daemonUrl.trim() || DEFAULT_DAEMON_URL;
    storeDaemonUrl(nextDaemonUrl);
    setSnapshot((current) => ({
      ...current,
      status: "checking",
      daemonUrl: nextDaemonUrl,
      message: "Checking local operator daemon...",
    }));
    const nextSnapshot = await loadOperatorSnapshot({
      daemonUrl: nextDaemonUrl,
      token,
      selectedRunId: selectedRunId ?? snapshot.selectedRunId,
    });
    setSnapshot(nextSnapshot);
    setLastCheckedAt(new Date().toLocaleTimeString());
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (snapshot.status !== "connected" || !snapshot.selectedRunId || !token.trim()) {
      setStreamState("idle");
      setStreamError(undefined);
      return;
    }

    const runId = snapshot.selectedRunId;
    const controller = new AbortController();
    let pollTimer: number | undefined;
    setStreamState("connecting");
    setStreamError(undefined);

    void streamOperatorReplay({
      daemonUrl: snapshot.daemonUrl,
      token,
      agentRunId: runId,
      afterSeq: Math.max(0, (snapshot.replay?.nextSeq ?? 1) - 1),
      pollMs: 1_000,
      signal: controller.signal,
      onMessage: (message) => {
        if (message.event === "heartbeat") {
          setStreamState("live");
          return;
        }
        if (message.event === "error") {
          const streamMessage = streamErrorMessage(message.data);
          setStreamError(streamMessage);
          setStreamState("error");
          return;
        }
        setSnapshot((current) => {
          if (current.selectedRunId !== runId) return current;
          const replay = mergeReplayStreamMessage(current.replay, message);
          if (!replay) return current;
          return {
            ...current,
            replay,
            message: replay.terminal ? "Selected run reached a terminal state." : current.message,
          };
        });
        setStreamState(message.event === "run.terminal" ? "ended" : "live");
      },
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setStreamState("polling");
      setStreamError(error instanceof Error ? error.message : String(error));
      pollTimer = window.setInterval(() => {
        void refresh(runId);
      }, 2_500);
    });

    return () => {
      controller.abort();
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
    };
  }, [snapshot.status, snapshot.daemonUrl, snapshot.selectedRunId, token]);

  const selectedRun = useMemo(
    () => snapshot.runs.find((run) => run.id === snapshot.selectedRunId),
    [snapshot.runs, snapshot.selectedRunId],
  );
  const counts = useMemo(() => summarizeRuns(snapshot.runs), [snapshot.runs]);
  const approval = pendingApproval(snapshot.replay);
  const canOperate = snapshot.status === "connected" && Boolean(token.trim());

  function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void refresh();
  }

  function handleSelectRun(run: OperatorRun) {
    void refresh(run.id);
  }

  function handleRefresh() {
    void refresh(snapshot.selectedRunId);
  }

  async function runAction(action: string, success: string, work: () => Promise<void>): Promise<void> {
    setBusyAction(action);
    setActionError(undefined);
    setNotice(undefined);
    try {
      await work();
      setNotice(success);
      await refresh(snapshot.selectedRunId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  function requireSelectedRun(): string {
    if (!snapshot.selectedRunId) throw new Error("Select a run first.");
    return snapshot.selectedRunId;
  }

  function requireToken(): string {
    const value = token.trim();
    if (!value) throw new Error("Enter the operator token first.");
    return value;
  }

  async function handleDispatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction("dispatch", "Dispatch requested.", async () => {
      await dispatchOperatorOnce({
        daemonUrl: snapshot.daemonUrl,
        token: requireToken(),
        workspaceRoot,
        workflowId,
        automationRunId,
      });
    });
  }

  async function handleResume(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction("resume", "Resume dispatched.", async () => {
      await resumeOperatorRun({
        daemonUrl: snapshot.daemonUrl,
        token: requireToken(),
        agentRunId: requireSelectedRun(),
        workspaceRoot,
      });
    });
  }

  async function handleApprove() {
    if (!approval) return;
    await runAction("approve", "Approval granted.", async () => {
      await resolveOperatorApproval({
        daemonUrl: snapshot.daemonUrl,
        token: requireToken(),
        agentRunId: requireSelectedRun(),
        approvalId: approval.id,
        decision: "approved",
        message: approvalMessage,
      });
    });
  }

  async function handleDeny(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!approval) return;
    await runAction("deny", "Approval denied.", async () => {
      await resolveOperatorApproval({
        daemonUrl: snapshot.daemonUrl,
        token: requireToken(),
        agentRunId: requireSelectedRun(),
        approvalId: approval.id,
        decision: "denied",
        message: denyMessage,
      });
    });
  }

  async function handleRetry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction("retry", "Retry queued.", async () => {
      await retryOperatorRun({
        daemonUrl: snapshot.daemonUrl,
        token: requireToken(),
        agentRunId: requireSelectedRun(),
        reason: retryReason,
      });
    });
  }

  async function handleCancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction("cancel", "Run cancellation requested.", async () => {
      await cancelOperatorRun({
        daemonUrl: snapshot.daemonUrl,
        token: requireToken(),
        agentRunId: requireSelectedRun(),
        reason: cancelReason,
      });
    });
  }

  return (
    <main className="desktop-shell">
      <header className="titlebar">
        <div className="brand-lockup">
          <span className="brand-mark">XO</span>
          <div>
            <h1>Xautojs Desktop</h1>
            <p>Local operator workspace</p>
          </div>
        </div>
        <div className="titlebar-status">
          <span className={`connection-pill ${connectionTone(snapshot.status)}`}>{statusLabel(snapshot.status)}</span>
          <span className={`connection-pill ${streamTone(streamState)}`}>{streamLabel(streamState)}</span>
          <span className="muted">{lastCheckedAt ? `Checked ${lastCheckedAt}` : "Starting up"}</span>
          <button className="ghost-button" type="button" onClick={handleRefresh} disabled={snapshot.status === "checking"}>Refresh</button>
        </div>
      </header>

      <section className="workspace-grid">
        <aside className="left-rail" aria-label="Connection and runs">
          <form className="connection-form" onSubmit={handleConnect}>
            <label>
              <span>Daemon</span>
              <input
                value={daemonUrl}
                onChange={(event) => setDaemonUrl(event.target.value)}
                spellCheck={false}
                placeholder={DEFAULT_DAEMON_URL}
              />
            </label>
            <label>
              <span>Operator token</span>
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                type="password"
                autoComplete="current-password"
                placeholder="DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN"
              />
            </label>
            <button className="primary-button" type="submit" disabled={snapshot.status === "checking"}>
              {snapshot.status === "checking" ? "Checking" : "Connect"}
            </button>
            <p className="form-note">Token stays in memory for this window. Keychain pairing remains a later auth polish step.</p>
          </form>

          <section className="daemon-command" aria-label="Daemon command">
            <span>Start daemon</span>
            <code>node dist/cli.js operator serve</code>
          </section>

          <section className="run-nav" aria-label="Recent runs">
            <div className="section-row">
              <h2>Runs</h2>
              <span>{snapshot.runs.length}</span>
            </div>
            <div className="run-counts" aria-label="Run counts">
              <span>{counts.active} active</span>
              <span>{counts.waiting} waiting</span>
              <span>{counts.failed} failed</span>
            </div>
            <div className="run-list">
              {snapshot.runs.length === 0 ? (
                <div className="inline-empty">No runs loaded.</div>
              ) : (
                snapshot.runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    className={`run-row ${run.id === snapshot.selectedRunId ? "selected" : ""}`}
                    onClick={() => handleSelectRun(run)}
                  >
                    <span>
                      <strong>{compactId(run.id)}</strong>
                      <small>{run.workflowId} · attempt {run.attempt}</small>
                    </span>
                    <em className={`run-status ${runTone(run.status)}`}>{run.status}</em>
                  </button>
                ))
              )}
            </div>
          </section>
        </aside>

        <section className="center-stage" aria-label="Selected run replay">
          {renderNotices(notice, actionError, streamError, streamState)}
          {canOperate ? (
            <DispatchComposer
              workspaceRoot={workspaceRoot}
              workflowId={workflowId}
              automationRunId={automationRunId}
              busy={busyAction === "dispatch"}
              onSubmit={handleDispatch}
              onWorkspaceRootChange={setWorkspaceRoot}
              onWorkflowIdChange={setWorkflowId}
              onAutomationRunIdChange={setAutomationRunId}
            />
          ) : null}
          {renderCenter(snapshot, selectedRun, streamState)}
        </section>

        <aside className="inspector" aria-label="Operator inspector">
          <InspectorHeader snapshot={snapshot} selectedRun={selectedRun} />
          <ApprovalPanel
            approval={approval}
            approvalMessage={approvalMessage}
            denyMessage={denyMessage}
            busyAction={busyAction}
            disabled={!canOperate || !approval}
            onApprovalMessageChange={setApprovalMessage}
            onDenyMessageChange={setDenyMessage}
            onApprove={handleApprove}
            onDeny={handleDeny}
          />
          <RunActionsPanel
            selectedRun={selectedRun}
            workspaceRoot={workspaceRoot}
            retryReason={retryReason}
            cancelReason={cancelReason}
            busyAction={busyAction}
            disabled={!canOperate || !selectedRun}
            onWorkspaceRootChange={setWorkspaceRoot}
            onRetryReasonChange={setRetryReason}
            onCancelReasonChange={setCancelReason}
            onResume={handleResume}
            onRetry={handleRetry}
            onCancel={handleCancel}
          />
          <HookDecisionPanel hooks={snapshot.replay?.summary.hooks.latest ?? []} blocking={snapshot.replay?.summary.hooks.blocking ?? []} />
          <WorkflowStepPanel steps={snapshot.replay?.summary.workflowSteps ?? []} />
        </aside>
      </section>
    </main>
  );
}

function DispatchComposer(props: {
  workspaceRoot: string;
  workflowId: string;
  automationRunId: string;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onWorkspaceRootChange: (value: string) => void;
  onWorkflowIdChange: (value: string) => void;
  onAutomationRunIdChange: (value: string) => void;
}) {
  return (
    <form className="dispatch-composer" onSubmit={props.onSubmit}>
      <div>
        <span className="eyebrow">Dispatch once</span>
        <h2>Start a local operator run</h2>
      </div>
      <label>
        <span>Workspace root</span>
        <input value={props.workspaceRoot} onChange={(event) => props.onWorkspaceRootChange(event.target.value)} placeholder="/path/to/workspace" />
      </label>
      <label>
        <span>Workflow</span>
        <input value={props.workflowId} onChange={(event) => props.onWorkflowIdChange(event.target.value)} placeholder="manual" />
      </label>
      <label>
        <span>Automation run id</span>
        <input value={props.automationRunId} onChange={(event) => props.onAutomationRunIdChange(event.target.value)} placeholder="optional" />
      </label>
      <button className="primary-button" type="submit" disabled={props.busy}>{props.busy ? "Dispatching" : "Dispatch"}</button>
    </form>
  );
}

function renderCenter(snapshot: OperatorConnectionSnapshot, selectedRun: OperatorRun | undefined, streamState: StreamState) {
  if (snapshot.status === "checking") {
    return <StatePanel title="Checking local daemon" message="Looking for the operator daemon on loopback." tone="active" />;
  }
  if (snapshot.status === "daemon_unavailable") {
    return <StatePanel title="Daemon is not reachable" message={snapshot.message} tone="danger" detail="Start `node dist/cli.js operator serve` with Postgres ready, then connect again." />;
  }
  if (snapshot.status === "not_ready") {
    return <StatePanel title="Postgres schema is not ready" message={snapshot.message} tone="warning" detail="Run database migrations before starting a desktop operator session." />;
  }
  if (snapshot.status === "token_missing" || snapshot.status === "unauthorized") {
    return <StatePanel title={snapshot.status === "token_missing" ? "Operator token required" : "Operator token rejected"} message={snapshot.message} tone={snapshot.status === "token_missing" ? "warning" : "danger"} detail="Use the same token configured as DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN for the local daemon." />;
  }
  if (snapshot.status === "error") {
    return <StatePanel title="Connection needs attention" message={snapshot.message} tone="danger" />;
  }
  if (snapshot.runs.length === 0) {
    return <StatePanel title="Connected, no runs yet" message="The daemon is ready. Dispatch a native agent run from the composer above." tone="success" />;
  }
  if (!snapshot.replay || !selectedRun) {
    return <StatePanel title="Select a run" message="Choose a run from the left rail to inspect replay state." tone="active" />;
  }

  return (
    <div className="replay-workspace">
      <div className="stage-header">
        <div>
          <span className="eyebrow">Replay · {streamLabel(streamState)}</span>
          <h2>{selectedRun.workflowId}</h2>
          <p>{selectedRun.id}</p>
        </div>
        <span className={`run-status large ${runTone(snapshot.replay.summary.status)}`}>{snapshot.replay.summary.status}</span>
      </div>

      <div className="summary-band">
        <SummaryMetric label="Approvals" value={snapshot.replay.summary.approvals.pending} note={`${snapshot.replay.summary.approvals.approved} approved · ${snapshot.replay.summary.approvals.denied} denied`} />
        <SummaryMetric label="Hooks" value={snapshot.replay.summary.hooks.total} note={`${snapshot.replay.summary.hooks.blocking.length} blocking`} />
        <SummaryMetric label="Steps" value={snapshot.replay.summary.workflowSteps.length} note="workflow" />
        <SummaryMetric label="Retries" value={snapshot.replay.summary.retries.retryAgentRunIds.length} note={snapshot.replay.summary.retries.retryOfAgentRunId ? "retry child" : "children"} />
      </div>

      <ol className="timeline">
        {snapshot.replay.events.length === 0 ? (
          <li className="inline-empty">No replay events recorded yet.</li>
        ) : (
          snapshot.replay.events.map((event) => <TimelineEvent key={event.seq} event={event} />)
        )}
      </ol>
    </div>
  );
}

function InspectorHeader({ snapshot, selectedRun }: { snapshot: OperatorConnectionSnapshot; selectedRun?: OperatorRun }) {
  return (
    <section>
      <div className="section-row">
        <h2>Inspector</h2>
        <span>{selectedRun ? compactId(selectedRun.id) : "No run"}</span>
      </div>
      <dl className="facts-list">
        <div><dt>Daemon</dt><dd>{snapshot.daemonUrl}</dd></div>
        <div><dt>Health</dt><dd>{snapshot.health?.status ?? "unknown"}</dd></div>
        <div><dt>Readiness</dt><dd>{snapshot.readiness?.status ?? "unknown"}</dd></div>
        <div><dt>Status</dt><dd>{statusLabel(snapshot.status)}</dd></div>
      </dl>
    </section>
  );
}

function ApprovalPanel(props: {
  approval?: OperatorApproval;
  approvalMessage: string;
  denyMessage: string;
  busyAction?: string;
  disabled: boolean;
  onApprovalMessageChange: (value: string) => void;
  onDenyMessageChange: (value: string) => void;
  onApprove: () => void;
  onDeny: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section>
      <h3>Approval</h3>
      {props.approval ? (
        <div className="approval-focus">
          <div className="approval-title-row">
            <strong>{props.approval.title}</strong>
            <span className={`risk-pill ${props.approval.risk}`}>{props.approval.risk}</span>
          </div>
          <p>{props.approval.message}</p>
          <details>
            <summary>Request payload</summary>
            <pre>{formatJson(props.approval.request)}</pre>
          </details>
          <label>
            <span>Approval note</span>
            <textarea value={props.approvalMessage} onChange={(event) => props.onApprovalMessageChange(event.target.value)} rows={2} />
          </label>
          <button className="primary-button" type="button" disabled={props.disabled || props.busyAction === "approve"} onClick={props.onApprove}>
            {props.busyAction === "approve" ? "Approving" : "Approve"}
          </button>
          <form className="stacked-form" onSubmit={props.onDeny}>
            <label>
              <span>Denial reason</span>
              <textarea value={props.denyMessage} onChange={(event) => props.onDenyMessageChange(event.target.value)} rows={2} />
            </label>
            <button className="danger-button" type="submit" disabled={props.disabled || props.busyAction === "deny"}>
              {props.busyAction === "deny" ? "Denying" : "Deny"}
            </button>
          </form>
        </div>
      ) : (
        <p className="muted">No pending approval.</p>
      )}
    </section>
  );
}

function RunActionsPanel(props: {
  selectedRun?: OperatorRun;
  workspaceRoot: string;
  retryReason: string;
  cancelReason: string;
  busyAction?: string;
  disabled: boolean;
  onWorkspaceRootChange: (value: string) => void;
  onRetryReasonChange: (value: string) => void;
  onCancelReasonChange: (value: string) => void;
  onResume: (event: FormEvent<HTMLFormElement>) => void;
  onRetry: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section>
      <h3>Run actions</h3>
      <form className="stacked-form" onSubmit={props.onResume}>
        <label>
          <span>Workspace root for resume</span>
          <input value={props.workspaceRoot} onChange={(event) => props.onWorkspaceRootChange(event.target.value)} placeholder="/path/to/workspace" />
        </label>
        <button className="primary-button" type="submit" disabled={props.disabled || props.busyAction === "resume"}>
          {props.busyAction === "resume" ? "Resuming" : "Resume"}
        </button>
      </form>
      <form className="stacked-form" onSubmit={props.onRetry}>
        <label>
          <span>Retry reason</span>
          <input value={props.retryReason} onChange={(event) => props.onRetryReasonChange(event.target.value)} />
        </label>
        <button className="ghost-button" type="submit" disabled={props.disabled || props.busyAction === "retry"}>
          {props.busyAction === "retry" ? "Retrying" : "Retry"}
        </button>
      </form>
      <form className="stacked-form" onSubmit={props.onCancel}>
        <label>
          <span>Cancel reason</span>
          <input value={props.cancelReason} onChange={(event) => props.onCancelReasonChange(event.target.value)} />
        </label>
        <button className="danger-button" type="submit" disabled={props.disabled || props.busyAction === "cancel"}>
          {props.busyAction === "cancel" ? "Cancelling" : "Cancel"}
        </button>
      </form>
    </section>
  );
}

function HookDecisionPanel({ hooks, blocking }: { hooks: OperatorHookDecision[]; blocking: OperatorHookDecision[] }) {
  const visible = blocking.length > 0 ? blocking : hooks.slice(0, 6);
  return (
    <section>
      <div className="section-row">
        <h3>Hook decisions</h3>
        <span>{blocking.length} blocking</span>
      </div>
      {visible.length > 0 ? (
        <ul className="decision-list">
          {visible.map((hook) => (
            <li key={`${hook.seq}-${hook.eventName}`} className={`decision-card ${decisionTone(hook.decision)}`}>
              <div>
                <strong>{hook.eventName}</strong>
                <span>{hook.decision}</span>
              </div>
              <p>{hook.reason ?? hook.ruleId ?? hook.stage ?? "No reason recorded."}</p>
              <small>{hook.stepId ? `step ${hook.stepId}` : hook.toolName ?? "runtime"}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No hook decisions loaded.</p>
      )}
    </section>
  );
}

function WorkflowStepPanel({ steps }: { steps: OperatorWorkflowStep[] }) {
  return (
    <section>
      <div className="section-row">
        <h3>Workflow steps</h3>
        <span>{steps.length}</span>
      </div>
      {steps.length > 0 ? (
        <ol className="step-list">
          {steps.map((step) => (
            <li key={`${step.seq}-${step.id}`} className={step.status}>
              <div>
                <strong>{step.title ?? step.id}</strong>
                <span>{step.phase ?? "step"} · {step.status}</span>
              </div>
              {step.hookDecision ? <em>{step.hookDecision}</em> : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No workflow steps loaded.</p>
      )}
    </section>
  );
}

function renderNotices(notice: string | undefined, actionError: string | undefined, streamError: string | undefined, streamState: StreamState) {
  return (
    <div className="notice-stack">
      {notice ? <div className="notice success">{notice}</div> : null}
      {actionError ? <div className="notice error">{actionError}</div> : null}
      {streamError && streamState !== "polling" ? <div className="notice error">{streamError}</div> : null}
      {streamError && streamState === "polling" ? <div className="notice warning">Live stream unavailable. Polling replay as fallback. {streamError}</div> : null}
    </div>
  );
}

function StatePanel(props: { title: string; message: string; detail?: string; tone: "active" | "success" | "warning" | "danger" }) {
  return (
    <div className={`state-panel ${props.tone}`}>
      <span>{props.tone}</span>
      <h2>{props.title}</h2>
      <p>{props.message}</p>
      {props.detail ? <small>{props.detail}</small> : null}
    </div>
  );
}

function SummaryMetric(props: { label: string; value: number; note: string }) {
  return (
    <div className="summary-metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <small>{props.note}</small>
    </div>
  );
}

function TimelineEvent({ event }: { event: OperatorReplayEvent }) {
  return (
    <li className="timeline-event">
      <span>{event.seq}</span>
      <div>
        <strong>{eventTitle(event)}</strong>
        <p>{eventDetail(event)}</p>
      </div>
      <time>{formatTime(event.createdAt)}</time>
    </li>
  );
}

function summarizeRuns(runs: OperatorRun[]) {
  return {
    active: runs.filter((run) => ["queued", "claiming", "running", "waiting_input"].includes(run.status)).length,
    waiting: runs.filter((run) => run.status === "waiting_input").length,
    failed: runs.filter((run) => run.status === "failed" || run.status === "timed_out").length,
  };
}

function connectionTone(status: OperatorConnectionStatus): string {
  if (status === "connected") return "success";
  if (status === "checking") return "active";
  if (status === "token_missing" || status === "not_ready") return "warning";
  return "danger";
}

function streamTone(status: StreamState): string {
  if (status === "live") return "success";
  if (status === "connecting") return "active";
  if (status === "ended" || status === "idle") return "muted";
  if (status === "polling") return "warning";
  return "danger";
}

function streamLabel(status: StreamState): string {
  switch (status) {
    case "idle":
      return "Stream idle";
    case "connecting":
      return "Stream connecting";
    case "live":
      return "Live replay";
    case "polling":
      return "Polling replay";
    case "ended":
      return "Replay ended";
    case "error":
      return "Stream error";
  }
}

function runTone(status: OperatorRunStatus): string {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out") return "danger";
  if (status === "waiting_input") return "warning";
  if (status === "cancelled") return "muted";
  return "active";
}

function decisionTone(decision: string): string {
  if (decision === "allow" || decision === "audit_only") return "success";
  if (decision === "ask") return "warning";
  if (decision === "block" || decision === "deny") return "danger";
  return "muted";
}

function compactId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 10)}...${id.slice(-6)}`;
}

function formatTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(time);
}

function eventTitle(event: OperatorReplayEvent): string {
  switch (event.type) {
    case "run.approval.requested":
      return "Approval requested";
    case "run.approval.resolved":
      return "Approval resolved";
    case "run.hook.decision":
      return "Hook decision";
    case "run.loop.step":
      return "Workflow step";
    default:
      return event.type.replace(/^run\./, "Run ").replace(/[._-]/g, " ");
  }
}

function eventDetail(event: OperatorReplayEvent): string {
  const title = stringValue(event.payload.title) ?? stringValue(event.payload.message) ?? stringValue(event.payload.reason) ?? stringValue(event.payload.decision);
  if (title) return title;
  return JSON.stringify(event.payload);
}

function streamErrorMessage(data: unknown): string {
  if (!data || typeof data !== "object") return "Replay stream failed.";
  const error = (data as { error?: { message?: string; code?: string } }).error;
  return error?.message ?? error?.code ?? "Replay stream failed.";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function readStoredDaemonUrl(): string {
  try {
    return window.localStorage.getItem(DAEMON_URL_STORAGE_KEY) ?? DEFAULT_DAEMON_URL;
  } catch {
    return DEFAULT_DAEMON_URL;
  }
}

function storeDaemonUrl(value: string): void {
  try {
    window.localStorage.setItem(DAEMON_URL_STORAGE_KEY, value);
  } catch {
    // Best-effort preference only; the operator token is intentionally not stored here.
  }
}
