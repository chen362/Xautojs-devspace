import "./operator-app.css";
import {
  RUN_STATUS_FILTERS,
  blockingHookCount,
  chooseRunId,
  compactId,
  decisionTone,
  eventDetail,
  eventTitle,
  filterRuns,
  formatDateTime,
  pendingApproval,
  statusTone,
  summarizeRuns,
  timeAgo,
  type OperatorApproval,
  type OperatorReplay,
  type OperatorReplayEvent,
  type OperatorRun,
  type OperatorRunStatus,
  type OperatorWorkflowStep,
} from "./operator-model.js";

declare global {
  interface Window {
    DEVSPACE_OPERATOR_CONFIG?: {
      apiBasePath?: string;
    };
  }
}

type StatusFilter = OperatorRunStatus | "all";

interface OperatorState {
  authenticated: boolean;
  sessionMethod?: string;
  sessionExpiresAt?: string;
  loading: boolean;
  busyAction?: string;
  error?: string;
  notice?: string;
  runs: OperatorRun[];
  selectedRunId?: string;
  replay?: OperatorReplay;
  statusFilter: StatusFilter;
  workspaceRoot: string;
  dispatchWorkflowId: string;
  dispatchAutomationRunId: string;
}

const apiBasePath = window.DEVSPACE_OPERATOR_CONFIG?.apiBasePath ?? "/api/native-agent";
const root = document.querySelector<HTMLElement>("#operator-app");

if (!root) throw new Error("Missing #operator-app root element.");

const state: OperatorState = {
  authenticated: false,
  loading: true,
  runs: [],
  statusFilter: "all",
  workspaceRoot: "",
  dispatchWorkflowId: "manual",
  dispatchAutomationRunId: "",
};

root.addEventListener("click", (event) => {
  const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-action]") : null;
  if (!target) return;
  event.preventDefault();
  void handleAction(target);
});

root.addEventListener("submit", (event) => {
  const form = event.target instanceof HTMLFormElement ? event.target : undefined;
  if (!form) return;
  event.preventDefault();
  void handleSubmit(form);
});

root.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.name === "statusFilter") {
    state.statusFilter = target.value as StatusFilter;
    void refreshRuns();
  }
});

void boot();

async function boot(): Promise<void> {
  render();
  try {
    const session = await api<{ session: { authenticated: boolean; method: string; expiresAt?: string } }>("/operator/session");
    state.authenticated = session.session.authenticated;
    state.sessionMethod = session.session.method;
    state.sessionExpiresAt = session.session.expiresAt;
    await refreshRuns();
  } catch (error) {
    state.authenticated = false;
    state.error = undefined;
  } finally {
    state.loading = false;
    render();
  }
}

async function handleSubmit(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  if (form.id === "operator-login-form") {
    const token = stringFormValue(data.get("token"));
    if (!token) {
      setError("Enter the operator token.");
      return;
    }
    await withBusy("login", async () => {
      const result = await api<{ session: { authenticated: boolean; method: string; expiresAt?: string } }>("/operator/session", {
        method: "POST",
        body: { token },
      });
      state.authenticated = result.session.authenticated;
      state.sessionMethod = result.session.method;
      state.sessionExpiresAt = result.session.expiresAt;
      state.notice = "Operator session started.";
      await refreshRuns();
    });
    return;
  }

  if (form.id === "resume-run-form") {
    const workspaceRoot = stringFormValue(data.get("workspaceRoot"));
    if (!state.selectedRunId) return;
    state.workspaceRoot = workspaceRoot;
    await withBusy("resume", async () => {
      await api(`/runs/${encodeURIComponent(state.selectedRunId!)}/resume`, {
        method: "POST",
        body: workspaceRoot ? { workspaceRoot } : {},
      });
      state.notice = "Resume dispatched.";
      await refreshSelectedReplay();
      await refreshRuns({ keepSelection: true });
    });
    return;
  }

  if (form.id === "dispatch-once-form") {
    const workspaceRoot = stringFormValue(data.get("workspaceRoot"));
    const workflowId = stringFormValue(data.get("workflowId")) || "manual";
    const automationRunId = stringFormValue(data.get("automationRunId"));
    state.workspaceRoot = workspaceRoot;
    state.dispatchWorkflowId = workflowId;
    state.dispatchAutomationRunId = automationRunId;
    await withBusy("dispatch", async () => {
      await api("/dispatch/once", {
        method: "POST",
        body: compactBody({ workspaceRoot, workflowId, automationRunId }),
      });
      state.notice = "Dispatch requested.";
      await refreshRuns();
    });
  }
}

async function handleAction(target: HTMLElement): Promise<void> {
  const action = target.dataset.action;
  if (!action) return;

  if (action === "refresh") {
    await refreshRuns({ keepSelection: true });
    return;
  }

  if (action === "logout") {
    await withBusy("logout", async () => {
      await api("/operator/session", { method: "DELETE" });
      state.authenticated = false;
      state.sessionMethod = undefined;
      state.sessionExpiresAt = undefined;
      state.runs = [];
      state.replay = undefined;
      state.selectedRunId = undefined;
      state.notice = "Operator session ended.";
    });
    return;
  }

  if (action === "select-run") {
    const runId = target.dataset.runId;
    if (!runId) return;
    state.selectedRunId = runId;
    await refreshSelectedReplay();
    render();
    return;
  }

  if (!state.selectedRunId) return;

  if (action === "approve" || action === "deny") {
    const approvalId = target.dataset.approvalId;
    if (!approvalId) return;
    const decision = action === "approve" ? "approved" : "denied";
    const message = action === "deny" ? window.prompt("Reason for denial", "Denied from operator console") : "Approved from operator console";
    if (message === null) return;
    await withBusy(action, async () => {
      await api(`/runs/${encodeURIComponent(state.selectedRunId!)}/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        body: { decision, resolvedBy: "operator-console", message },
      });
      state.notice = decision === "approved" ? "Approval granted." : "Approval denied.";
      await refreshSelectedReplay();
      await refreshRuns({ keepSelection: true });
    });
    return;
  }

  if (action === "retry") {
    const reason = window.prompt("Retry reason", "Retry from operator console");
    if (reason === null) return;
    await withBusy("retry", async () => {
      await api(`/runs/${encodeURIComponent(state.selectedRunId!)}/retry`, {
        method: "POST",
        body: { reason },
      });
      state.notice = "Retry queued.";
      await refreshSelectedReplay();
      await refreshRuns({ keepSelection: true });
    });
    return;
  }

  if (action === "cancel") {
    const reason = window.prompt("Cancel reason", "Cancelled from operator console");
    if (reason === null) return;
    await withBusy("cancel", async () => {
      await api(`/runs/${encodeURIComponent(state.selectedRunId!)}/cancel`, {
        method: "POST",
        body: { reason },
      });
      state.notice = "Run cancelled.";
      await refreshSelectedReplay();
      await refreshRuns({ keepSelection: true });
    });
  }
}

async function refreshRuns(options: { keepSelection?: boolean } = {}): Promise<void> {
  if (!state.authenticated) return;
  state.loading = true;
  state.error = undefined;
  render();
  try {
    const query = new URLSearchParams({ limit: "100" });
    if (state.statusFilter !== "all") query.set("status", state.statusFilter);
    const result = await api<{ runs: OperatorRun[] }>(`/runs?${query.toString()}`);
    state.runs = result.runs;
    state.selectedRunId = chooseRunId(result.runs, options.keepSelection ? state.selectedRunId : undefined);
    await refreshSelectedReplay();
  } catch (error) {
    setError(errorMessage(error));
  } finally {
    state.loading = false;
    render();
  }
}

async function refreshSelectedReplay(): Promise<void> {
  if (!state.selectedRunId) {
    state.replay = undefined;
    return;
  }
  const result = await api<{ replay: OperatorReplay }>(`/runs/${encodeURIComponent(state.selectedRunId)}/replay`);
  state.replay = result.replay;
}

async function withBusy(action: string, work: () => Promise<void>): Promise<void> {
  state.busyAction = action;
  state.error = undefined;
  render();
  try {
    await work();
  } catch (error) {
    setError(errorMessage(error));
  } finally {
    state.busyAction = undefined;
    render();
  }
}

async function api<T = unknown>(path: string, options: { method?: string; body?: Record<string, unknown> } = {}): Promise<T> {
  const response = await fetch(`${apiBasePath}${path}`, {
    method: options.method ?? "GET",
    credentials: "include",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as T & { error?: { message?: string; code?: string } } : undefined;
  if (!response.ok) {
    if (response.status === 401) state.authenticated = false;
    const message = body?.error?.message ?? body?.error?.code ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function render(): void {
  if (state.loading && !state.authenticated) {
    root.innerHTML = `<section class="operator-loading">Loading operator console...</section>`;
    return;
  }
  if (!state.authenticated) {
    renderLogin();
    return;
  }

  const counts = summarizeRuns(state.runs);
  root.innerHTML = `
    <header class="operator-topbar">
      <div class="brand-block">
        <span class="brand-mark">XO</span>
        <div>
          <h1>Xautojs Operator</h1>
          <p>Native agent runs, approvals, hooks, and replay.</p>
        </div>
      </div>
      <div class="topbar-actions">
        <span class="session-pill">${escapeHtml(state.sessionMethod ?? "session")}${state.sessionExpiresAt ? ` until ${escapeHtml(formatDateTime(state.sessionExpiresAt))}` : ""}</span>
        <button class="ghost-button" type="button" data-action="refresh">Refresh</button>
        <button class="ghost-button" type="button" data-action="logout">Sign out</button>
      </div>
    </header>
    ${renderNotice()}
    <section class="metrics-row" aria-label="Run summary">
      ${metric("Runs", counts.total)}
      ${metric("Active", counts.active)}
      ${metric("Waiting", counts.waiting)}
      ${metric("Failed", counts.failed)}
      ${metric("Terminal", counts.terminal)}
    </section>
    <section class="operator-layout">
      ${renderRunColumn()}
      ${renderReplayColumn()}
      ${renderInspectorColumn()}
    </section>
  `;
}

function renderLogin(): void {
  root.innerHTML = `
    <section class="login-shell">
      <div class="login-panel">
        <div class="brand-block large">
          <span class="brand-mark">XO</span>
          <div>
            <h1>Xautojs Operator Console</h1>
            <p>Sign in with the native agent operator token to manage runs.</p>
          </div>
        </div>
        ${renderNotice()}
        <form id="operator-login-form" class="login-form">
          <label>
            <span>Operator token</span>
            <input name="token" type="password" autocomplete="current-password" placeholder="DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN" autofocus />
          </label>
          <button class="primary-button" type="submit" ${state.busyAction === "login" ? "disabled" : ""}>Start session</button>
        </form>
        <p class="form-note">The token is exchanged for a signed HttpOnly session cookie. API scripts can still use Bearer token auth.</p>
      </div>
    </section>
  `;
}

function renderNotice(): string {
  const error = state.error ? `<div class="notice error">${escapeHtml(state.error)}</div>` : "";
  const notice = state.notice ? `<div class="notice success">${escapeHtml(state.notice)}</div>` : "";
  return `${error}${notice}`;
}

function renderRunColumn(): string {
  const visibleRuns = filterRuns(state.runs, state.statusFilter);
  return `
    <aside class="runs-column" aria-label="Native agent runs">
      <div class="section-header compact">
        <div>
          <h2>Runs</h2>
          <p>${visibleRuns.length} visible</p>
        </div>
        <label class="filter-label">
          <span>Status</span>
          <select name="statusFilter">
            ${RUN_STATUS_FILTERS.map((status) => `<option value="${status}" ${status === state.statusFilter ? "selected" : ""}>${status}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="run-list">
        ${visibleRuns.length > 0 ? visibleRuns.map(renderRunRow).join("") : `<div class="empty-state">No runs match this filter.</div>`}
      </div>
    </aside>
  `;
}

function renderRunRow(run: OperatorRun): string {
  const selected = run.id === state.selectedRunId;
  const tone = statusTone(run.status);
  return `
    <button class="run-row ${selected ? "selected" : ""}" type="button" data-action="select-run" data-run-id="${escapeHtml(run.id)}">
      <span class="run-row-main">
        <span class="run-id">${escapeHtml(compactId(run.id))}</span>
        <span class="run-meta">${escapeHtml(run.workflowId)} · attempt ${run.attempt}</span>
      </span>
      <span class="status-pill ${tone}">${escapeHtml(run.status)}</span>
      <span class="run-updated">${escapeHtml(timeAgo(run.updatedAt))}</span>
    </button>
  `;
}

function renderReplayColumn(): string {
  if (state.loading) {
    return `<main class="replay-column"><div class="empty-state tall">Loading runs...</div></main>`;
  }
  if (!state.selectedRunId) {
    return `<main class="replay-column"><div class="empty-state tall">Select or dispatch a run to inspect replay.</div></main>`;
  }
  if (!state.replay) {
    return `<main class="replay-column"><div class="empty-state tall">Replay is loading.</div></main>`;
  }
  return `
    <main class="replay-column" aria-label="Replay timeline">
      <div class="section-header">
        <div>
          <h2>Replay</h2>
          <p>${escapeHtml(state.replay.summary.workflowId)} · seq ${state.replay.summary.nextSeq}</p>
        </div>
        <span class="status-pill ${statusTone(state.replay.summary.status)}">${escapeHtml(state.replay.summary.status)}</span>
      </div>
      ${renderReplaySummary(state.replay)}
      <ol class="timeline">
        ${state.replay.events.length > 0 ? state.replay.events.map(renderEvent).join("") : `<li class="empty-state">No replay events recorded yet.</li>`}
      </ol>
    </main>
  `;
}

function renderReplaySummary(replay: OperatorReplay): string {
  const summary = replay.summary;
  return `
    <section class="summary-strip">
      <div><span>Approvals</span><strong>${summary.approvals.pending} pending</strong><small>${summary.approvals.approved} approved · ${summary.approvals.denied} denied</small></div>
      <div><span>Hooks</span><strong>${summary.hooks.total}</strong><small>${summary.hooks.blocking.length} blocking · ${summary.hooks.auditOnly} audit</small></div>
      <div><span>Steps</span><strong>${summary.workflowSteps.length}</strong><small>${summary.workflowSteps.filter((step) => step.status === "blocked").length} blocked</small></div>
      <div><span>Retries</span><strong>${summary.retries.retryAgentRunIds.length}</strong><small>${summary.retries.retryOfAgentRunId ? `retry of ${compactId(summary.retries.retryOfAgentRunId)}` : "source run"}</small></div>
    </section>
  `;
}

function renderEvent(event: OperatorReplayEvent): string {
  const isHook = event.type === "run.hook.decision";
  const tone = isHook ? decisionTone(String(event.payload.decision ?? "")) : "muted";
  return `
    <li class="timeline-event ${isHook ? `decision-${tone}` : ""}">
      <div class="timeline-seq">${event.seq}</div>
      <div class="timeline-body">
        <div class="timeline-title-row">
          <strong>${escapeHtml(eventTitle(event))}</strong>
          <time>${escapeHtml(formatDateTime(event.createdAt))}</time>
        </div>
        <p>${escapeHtml(eventDetail(event))}</p>
        <details>
          <summary>Payload</summary>
          <pre>${escapeHtml(formatJson(event.payload))}</pre>
        </details>
      </div>
    </li>
  `;
}

function renderInspectorColumn(): string {
  const replay = state.replay;
  const approval = pendingApproval(replay);
  return `
    <aside class="inspector-column" aria-label="Operator actions">
      <div class="section-header">
        <div>
          <h2>Inspector</h2>
          <p>${state.selectedRunId ? escapeHtml(compactId(state.selectedRunId)) : "No run selected"}</p>
        </div>
      </div>
      ${replay ? renderInspectorSummary(replay) : `<div class="empty-state">No replay selected.</div>`}
      ${approval ? renderPendingApproval(approval) : `<section class="inspector-section"><h3>Approval</h3><p class="muted-text">No pending approval.</p></section>`}
      ${replay ? renderWorkflowSteps(replay.summary.workflowSteps) : ""}
      ${renderRunActions()}
      ${renderDispatchForm()}
    </aside>
  `;
}

function renderInspectorSummary(replay: OperatorReplay): string {
  const summary = replay.summary;
  return `
    <section class="inspector-section">
      <h3>Run summary</h3>
      <dl class="details-list">
        <div><dt>Status</dt><dd><span class="status-pill ${statusTone(summary.status)}">${escapeHtml(summary.status)}</span></dd></div>
        <div><dt>Workflow</dt><dd>${escapeHtml(summary.workflowId)}</dd></div>
        <div><dt>Attempt</dt><dd>${summary.attempt}</dd></div>
        <div><dt>Permission</dt><dd>${escapeHtml(summary.permissionProfile)}</dd></div>
        <div><dt>Blocking hooks</dt><dd>${blockingHookCount(replay)}</dd></div>
      </dl>
    </section>
  `;
}

function renderPendingApproval(approval: OperatorApproval): string {
  return `
    <section class="inspector-section approval-focus">
      <h3>Pending approval</h3>
      <p class="approval-title">${escapeHtml(approval.title)}</p>
      <p>${escapeHtml(approval.message)}</p>
      <div class="approval-meta">
        <span class="risk-pill ${approval.risk}">${escapeHtml(approval.risk)}</span>
        <span>${escapeHtml(timeAgo(approval.requestedAt))}</span>
      </div>
      <pre>${escapeHtml(formatJson(approval.request))}</pre>
      <div class="button-row">
        <button class="primary-button" type="button" data-action="approve" data-approval-id="${escapeHtml(approval.id)}" ${state.busyAction === "approve" ? "disabled" : ""}>Approve</button>
        <button class="danger-button" type="button" data-action="deny" data-approval-id="${escapeHtml(approval.id)}" ${state.busyAction === "deny" ? "disabled" : ""}>Deny</button>
      </div>
    </section>
  `;
}

function renderWorkflowSteps(steps: OperatorWorkflowStep[]): string {
  if (steps.length === 0) return "";
  return `
    <section class="inspector-section">
      <h3>Workflow steps</h3>
      <ol class="step-list">
        ${steps.map((step) => `
          <li class="step-row ${step.status}">
            <span>${escapeHtml(step.title ?? step.id)}</span>
            <small>${escapeHtml(step.phase ?? "step")} · ${escapeHtml(step.status)}${step.hookDecision ? ` · ${escapeHtml(step.hookDecision)}` : ""}</small>
          </li>
        `).join("")}
      </ol>
    </section>
  `;
}

function renderRunActions(): string {
  return `
    <section class="inspector-section">
      <h3>Run actions</h3>
      <form id="resume-run-form" class="stacked-form">
        <label>
          <span>Workspace root for resume</span>
          <input name="workspaceRoot" value="${escapeHtml(state.workspaceRoot)}" placeholder="/path/to/workspace" />
        </label>
        <button class="primary-button" type="submit" ${!state.selectedRunId || state.busyAction === "resume" ? "disabled" : ""}>Resume</button>
      </form>
      <div class="button-row split">
        <button class="ghost-button" type="button" data-action="retry" ${!state.selectedRunId || state.busyAction === "retry" ? "disabled" : ""}>Retry</button>
        <button class="danger-button" type="button" data-action="cancel" ${!state.selectedRunId || state.busyAction === "cancel" ? "disabled" : ""}>Cancel</button>
      </div>
    </section>
  `;
}

function renderDispatchForm(): string {
  return `
    <section class="inspector-section">
      <h3>Dispatch once</h3>
      <form id="dispatch-once-form" class="stacked-form">
        <label>
          <span>Workspace root</span>
          <input name="workspaceRoot" value="${escapeHtml(state.workspaceRoot)}" placeholder="/path/to/workspace" />
        </label>
        <label>
          <span>Workflow</span>
          <input name="workflowId" value="${escapeHtml(state.dispatchWorkflowId)}" placeholder="manual" />
        </label>
        <label>
          <span>Automation run id</span>
          <input name="automationRunId" value="${escapeHtml(state.dispatchAutomationRunId)}" placeholder="optional" />
        </label>
        <button class="primary-button" type="submit" ${state.busyAction === "dispatch" ? "disabled" : ""}>Dispatch</button>
      </form>
    </section>
  `;
}

function metric(label: string, value: number): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;
}

function setError(message: string): void {
  state.error = message;
  state.notice = undefined;
  state.loading = false;
  render();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactBody(body: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value.trim().length > 0));
}

function stringFormValue(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
