import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export type NativeProcessOutputStream = "stdout" | "stderr";
export type NativeProcessStatus = "running" | "exited" | "cancelled" | "timed_out" | "failed";
export type NativeProcessWriteStatus = "accepted" | "duplicate" | "unknown_process" | "stdin_closed" | "not_running";

export interface NativeProcessStartInput {
  processId?: string;
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  pipeStdin?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface NativeProcessStartResult {
  processId: string;
}

export interface NativeProcessOutputChunk {
  seq: number;
  stream: NativeProcessOutputStream;
  text: string;
  createdAt: string;
}

export interface NativeProcessReadInput {
  processId: string;
  afterSeq?: number;
  maxBytes?: number;
  waitMs?: number;
}

export interface NativeProcessReadResult {
  processId: string;
  chunks: NativeProcessOutputChunk[];
  nextSeq: number;
  status: NativeProcessStatus;
  exited: boolean;
  exitCode?: number;
  closed: boolean;
  failure?: string;
}

export interface NativeProcessWriteInput {
  processId: string;
  inputId: string;
  text: string;
}

export interface NativeProcessWriteResult {
  status: NativeProcessWriteStatus;
}

interface NativeProcessState {
  processId: string;
  child: ChildProcessWithoutNullStreams;
  status: NativeProcessStatus;
  chunks: NativeProcessOutputChunk[];
  nextSeq: number;
  outputBytes: number;
  maxOutputBytes: number;
  truncated: boolean;
  pipeStdin: boolean;
  writes: Set<string>;
  waiters: Set<() => void>;
  timeout?: NodeJS.Timeout;
  exitCode?: number;
  failure?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export class NativeProcessManager {
  private readonly processes = new Map<string, NativeProcessState>();

  start(input: NativeProcessStartInput): NativeProcessStartResult {
    if (input.argv.length === 0 || !input.argv[0]) {
      throw new Error("Native process argv must not be empty.");
    }

    const processId = input.processId ?? `proc_${randomUUID()}`;
    if (this.processes.has(processId)) {
      throw new Error(`Native process already exists: ${processId}`);
    }

    const child = spawn(input.argv[0], input.argv.slice(1), {
      cwd: input.cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: "pipe",
    });
    const state: NativeProcessState = {
      processId,
      child,
      status: "running",
      chunks: [],
      nextSeq: 1,
      outputBytes: 0,
      maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      truncated: false,
      pipeStdin: input.pipeStdin ?? false,
      writes: new Set(),
      waiters: new Set(),
    };
    this.processes.set(processId, state);

    child.stdout.on("data", (chunk: Buffer) => this.pushOutput(state, "stdout", chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => this.pushOutput(state, "stderr", chunk.toString("utf8")));
    child.on("error", (error) => {
      state.status = "failed";
      state.failure = error.message;
      this.wake(state);
    });
    child.on("close", (code) => {
      if (state.status === "running") state.status = "exited";
      state.exitCode = code ?? undefined;
      if (state.timeout) clearTimeout(state.timeout);
      this.wake(state);
    });

    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (timeoutMs > 0) {
      state.timeout = setTimeout(() => {
        if (state.status !== "running") return;
        state.status = "timed_out";
        state.failure = `Process timed out after ${timeoutMs}ms.`;
        child.kill("SIGTERM");
        this.wake(state);
      }, timeoutMs);
      state.timeout.unref();
    }

    return { processId };
  }

  async read(input: NativeProcessReadInput): Promise<NativeProcessReadResult> {
    const state = this.processes.get(input.processId);
    if (!state) {
      return {
        processId: input.processId,
        chunks: [],
        nextSeq: input.afterSeq ?? 0,
        status: "failed",
        exited: true,
        closed: true,
        failure: "Unknown native process.",
      };
    }

    if (state.status === "running" && this.chunksAfter(state, input.afterSeq ?? 0).length === 0 && (input.waitMs ?? 0) > 0) {
      await this.waitForOutput(state, input.waitMs ?? 0);
    }

    const chunks = this.applyByteLimit(this.chunksAfter(state, input.afterSeq ?? 0), input.maxBytes ?? 64 * 1024);
    const nextSeq = chunks.length > 0 ? chunks[chunks.length - 1]!.seq + 1 : state.nextSeq;
    return {
      processId: state.processId,
      chunks,
      nextSeq,
      status: state.status,
      exited: state.status !== "running",
      exitCode: state.exitCode,
      closed: state.status !== "running",
      failure: state.failure,
    };
  }

  write(input: NativeProcessWriteInput): NativeProcessWriteResult {
    const state = this.processes.get(input.processId);
    if (!state) return { status: "unknown_process" };
    if (state.writes.has(input.inputId)) return { status: "duplicate" };
    if (state.status !== "running") return { status: "not_running" };
    if (!state.pipeStdin || state.child.stdin.destroyed || !state.child.stdin.writable) return { status: "stdin_closed" };

    state.writes.add(input.inputId);
    state.child.stdin.write(input.text);
    return { status: "accepted" };
  }

  cancel(processId: string): boolean {
    const state = this.processes.get(processId);
    if (!state || state.status !== "running") return false;
    state.status = "cancelled";
    state.failure = "Process cancelled.";
    state.child.kill("SIGTERM");
    this.wake(state);
    return true;
  }

  close(): void {
    for (const state of this.processes.values()) {
      if (state.status === "running") {
        state.status = "cancelled";
        state.child.kill("SIGTERM");
      }
      if (state.timeout) clearTimeout(state.timeout);
      this.wake(state);
    }
  }

  private pushOutput(state: NativeProcessState, stream: NativeProcessOutputStream, text: string): void {
    const bytes = Buffer.byteLength(text);
    if (state.outputBytes + bytes > state.maxOutputBytes) {
      if (!state.truncated) {
        state.truncated = true;
        this.pushOutput(state, stream, "\n[devspace native process output truncated]\n");
      }
      return;
    }

    state.outputBytes += bytes;
    state.chunks.push({
      seq: state.nextSeq++,
      stream,
      text,
      createdAt: new Date().toISOString(),
    });
    this.wake(state);
  }

  private chunksAfter(state: NativeProcessState, afterSeq: number): NativeProcessOutputChunk[] {
    return state.chunks.filter((chunk) => chunk.seq > afterSeq);
  }

  private applyByteLimit(chunks: NativeProcessOutputChunk[], maxBytes: number): NativeProcessOutputChunk[] {
    const selected: NativeProcessOutputChunk[] = [];
    let used = 0;
    for (const chunk of chunks) {
      const bytes = Buffer.byteLength(chunk.text);
      if (selected.length > 0 && used + bytes > maxBytes) break;
      selected.push(chunk);
      used += bytes;
      if (used >= maxBytes) break;
    }
    return selected;
  }

  private waitForOutput(state: NativeProcessState, waitMs: number): Promise<void> {
    const emitter = new EventEmitter();
    const done = () => emitter.emit("done");
    state.waiters.add(done);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.waiters.delete(done);
        resolve();
      }, waitMs);
      timer.unref();
      emitter.once("done", () => {
        clearTimeout(timer);
        state.waiters.delete(done);
        resolve();
      });
    });
  }

  private wake(state: NativeProcessState): void {
    for (const waiter of state.waiters) waiter();
    state.waiters.clear();
  }
}
