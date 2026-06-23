import assert from "node:assert/strict";
import { NativeProcessManager, type NativeProcessStatus } from "./native-agent-process.js";

{
  const manager = new NativeProcessManager();
  try {
    manager.start({
      processId: "proc_smoke",
      argv: [process.execPath, "-e", "console.log('native-agent-ok')"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });

    const output = await readUntilExit(manager, "proc_smoke");
    assert.equal(output.status, "exited");
    assert.equal(output.exitCode, 0);
    assert.match(output.text, /native-agent-ok/);
  } finally {
    manager.close();
  }
}

{
  const manager = new NativeProcessManager();
  try {
    manager.start({
      processId: "proc_stdin",
      argv: [
        process.execPath,
        "-e",
        "process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => process.stdout.write(chunk.toUpperCase()));",
      ],
      cwd: process.cwd(),
      pipeStdin: true,
      timeoutMs: 5_000,
    });

    assert.deepEqual(manager.write({ processId: "proc_stdin", inputId: "input-1", text: "hello\n" }), { status: "accepted" });
    assert.deepEqual(manager.write({ processId: "proc_stdin", inputId: "input-1", text: "again\n" }), { status: "duplicate" });

    const first = await manager.read({ processId: "proc_stdin", afterSeq: 0, waitMs: 250, maxBytes: 1024 });
    assert.match(first.chunks.map((chunk) => chunk.text).join(""), /HELLO/);
    assert.equal(manager.cancel("proc_stdin"), true);

    const cancelled = await readUntilExit(manager, "proc_stdin");
    assert.equal(cancelled.status, "cancelled");
  } finally {
    manager.close();
  }
}

{
  const manager = new NativeProcessManager();
  try {
    manager.start({
      processId: "proc_timeout",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
      cwd: process.cwd(),
      timeoutMs: 25,
    });

    const timedOut = await readUntilExit(manager, "proc_timeout");
    assert.equal(timedOut.status, "timed_out");
    assert.match(timedOut.failure ?? "", /timed out/i);
  } finally {
    manager.close();
  }
}

async function readUntilExit(
  manager: NativeProcessManager,
  processId: string,
): Promise<{ text: string; status: NativeProcessStatus; exitCode?: number; failure?: string }> {
  let afterSeq = 0;
  let text = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const read = await manager.read({ processId, afterSeq, waitMs: 50, maxBytes: 64 * 1024 });
    for (const chunk of read.chunks) {
      afterSeq = Math.max(afterSeq, chunk.seq);
      text += chunk.text;
    }
    if (read.exited) return { text, status: read.status, exitCode: read.exitCode, failure: read.failure };
  }
  throw new Error(`Process did not exit: ${processId}`);
}
