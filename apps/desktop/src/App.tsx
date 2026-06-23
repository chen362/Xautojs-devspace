import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_DAEMON_URL,
  loadOperatorSnapshot,
  statusLabel,
  type OperatorConnectionSnapshot,
  type OperatorConnectionStatus,
  type OperatorReplayEvent,
  type OperatorRun,
  type OperatorRunStatus,
} from "./operator-client.js";

const DAEMON_URL_STORAGE_KEY = "xautojs.desktop.daemonUrl";

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

  const connect = useCallback(async (selectedRunId?: string) => {
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
  }, [daemonUrl, snapshot.selectedRunId, token]);

  useEffect(() => {
    void connect();
  }, []);

  const selectedRun = useMemo(
    () => snapshot.runs.find((run) => run.id === snapshot.selectedRunId),
    [snapshot.runs, snapshot.selectedRunId],
  );

  const counts = useMemo(() => summarizeRuns(snapshot.runs), [snapshot.runs]);

  function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void connect();
  }

  function handleSelectRun(run: OperatorRun) {
    void connect(run.id);
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
          <span className="muted">{lastCheckedAt ? `Checked ${lastCheckedAt}` : "Starting up"}</span>
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
            <p className="form-note">Token stays in memory for this window. Keychain pairing lands after the scaffold.</p>
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
          {renderCenter(snapshot, selectedRun)}
        </section>

        <aside className="inspector" aria-label="Operator inspector">
          {renderInspector(snapshot, selectedRun)}
        </aside>
      </section>
    </main>
  );
}

function renderCenter(snapshot: OperatorConnectionSnapshot, selectedRun?: OperatorRun) {
  if (snapshot.status === "checking") {
    return <StatePanel title="Checking local daemon" message="Looking for the operator daemon on loopback." tone="active" />;
  }
  if (snapshot.status === "daemon_unavailable") {
    return (
      <StatePanel
        title="Daemon is not reachable"
        message={snapshot.message}
        tone="danger"
        detail="Start `node dist/cli.js operator serve` with Postgres ready, then connect again."
      />
    );
  }
  if (snapshot.status === "not_ready") {
    return (
      <StatePanel
        title="Postgres schema is not ready"
        message={snapshot.message}
        tone="warning"
        detail="Run database migrations before starting a desktop operator session."
      />
    );
  }
  if (snapshot.status === "token_missing" || snapshot.status === "unauthorized") {
    return (
      <StatePanel
        title={snapshot.status === "token_missing" ? "Operator token required" : "Operator token rejected"}
        message={snapshot.message}
        tone={snapshot.status === "token_missing" ? "warning" : "danger"}
        detail="Use the same token configured as DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN for the local daemon."
      />
    );
  }
  if (snapshot.status === "error") {
    return <StatePanel title="Connection needs attention" message={snapshot.message} tone="danger" />;
  }
  if (snapshot.runs.length === 0) {
    return (
      <StatePanel
        title="Connected, no runs yet"
        message="The daemon is ready. Dispatch or resume a native agent run to populate this workspace."
        tone="success"
        detail="PR41 will add desktop dispatch, approval, resume, retry, and cancel actions."
      />
    );
  }
  if (!snapshot.replay || !selectedRun) {
    return <StatePanel title="Select a run" message="Choose a run from the left rail to inspect replay state." tone="active" />;
  }

  return (
    <div className="replay-workspace">
      <div className="stage-header">
        <div>
          <span className="eyebrow">Replay</span>
          <h2>{selectedRun.workflowId}</h2>
          <p>{selectedRun.id}</p>
        </div>
        <span className={`run-status large ${runTone(snapshot.replay.summary.status)}`}>{snapshot.replay.summary.status}</span>
      </div>

      <div className="summary-band">
        <SummaryMetric label="Approvals" value={snapshot.replay.summary.approvals.pending} note="pending" />
        <SummaryMetric label="Hooks" value={snapshot.replay.summary.hooks.total} note={`${snapshot.replay.summary.hooks.blocking.length} blocking`} />
        <SummaryMetric label="Steps" value={snapshot.replay.summary.workflowSteps.length} note="workflow" />
        <SummaryMetric label="Retries" value={snapshot.replay.summary.retries.retryAgentRunIds.length} note="children" />
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

function renderInspector(snapshot: OperatorConnectionSnapshot, selectedRun?: OperatorRun) {
  const summary = snapshot.replay?.summary;
  return (
    <div className="inspector-stack">
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

      <section>
        <h3>Approval</h3>
        {summary?.approvals.latestPending ? (
          <div className="approval-focus">
            <strong>{summary.approvals.latestPending.title}</strong>
            <p>{summary.approvals.latestPending.message}</p>
            <span>{summary.approvals.latestPending.risk} risk</span>
          </div>
        ) : (
          <p className="muted">No pending approval.</p>
        )}
      </section>

      <section>
        <h3>Hook decisions</h3>
        {summary && summary.hooks.latest.length > 0 ? (
          <ul className="compact-list">
            {summary.hooks.latest.slice(0, 5).map((hook, index) => (
              <li key={index}>{String(hook.eventName ?? "hook")} · {String(hook.decision ?? "decision")}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">No hook decisions loaded.</p>
        )}
      </section>

      <section>
        <h3>Workflow steps</h3>
        {summary && summary.workflowSteps.length > 0 ? (
          <ul className="compact-list">
            {summary.workflowSteps.slice(0, 6).map((step) => (
              <li key={`${step.seq}-${step.id}`}>{step.title ?? step.id} · {step.status}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">No workflow steps loaded.</p>
        )}
      </section>
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
        <strong>{event.type}</strong>
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

function runTone(status: OperatorRunStatus): string {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out") return "danger";
  if (status === "waiting_input") return "warning";
  if (status === "cancelled") return "muted";
  return "active";
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

function eventDetail(event: OperatorReplayEvent): string {
  const title = stringValue(event.payload.title) ?? stringValue(event.payload.message) ?? stringValue(event.payload.decision);
  if (title) return title;
  return JSON.stringify(event.payload);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
