/**
 * Tests for the scripts/long-run shell script.
 *
 * Verifies: instant return, status file transitions, log capture,
 * exit code propagation, and JSON structure.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, readdirSync, unlinkSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const LONG_RUN_DIR = "/tmp/long-run";
const SCRIPTS_DIR = resolve(dirname(import.meta.dir), "scripts");
const LONG_RUN_BIN = `${SCRIPTS_DIR}/long-run`;

/** Clean up all test status/log files */
function cleanupLongRunFiles(): void {
  if (!existsSync(LONG_RUN_DIR)) return;
  for (const file of readdirSync(LONG_RUN_DIR)) {
    try {
      unlinkSync(`${LONG_RUN_DIR}/${file}`);
    } catch {}
  }
}

/** Run long-run and capture output */
async function runLongRun(
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([LONG_RUN_BIN, ...args], {
    cwd: cwd || "/tmp",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Extract process ID from long-run stdout */
function extractId(stdout: string): string {
  const match = stdout.match(/Started background process: (.+)/);
  if (!match) throw new Error(`Could not extract ID from: ${stdout}`);
  return match[1]!.trim();
}

/** Read and parse status file */
function readStatus(id: string): any {
  const content = readFileSync(`${LONG_RUN_DIR}/${id}.status`, "utf-8");
  return JSON.parse(content);
}

/** Wait for status to reach a given value */
async function waitForStatus(
  id: string,
  targetStatus: string,
  timeoutMs: number = 10000
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = readStatus(id);
      if (status.status === targetStatus) return status;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out waiting for status "${targetStatus}" on process ${id}`
  );
}

describe("scripts/long-run", () => {
  beforeEach(() => {
    cleanupLongRunFiles();
  });

  afterEach(() => {
    cleanupLongRunFiles();
  });

  test("exits immediately (does not block)", async () => {
    const start = Date.now();
    const result = await runLongRun(["sleep", "10"]);
    const elapsed = Date.now() - start;

    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeLessThan(3000); // Should return in <3s, not 10s
    expect(result.stdout).toContain("Started background process:");
    expect(result.stdout).toContain("Status:");
    expect(result.stdout).toContain("Log:");

    // Clean up the background sleep
    const id = extractId(result.stdout);
    const status = readStatus(id);
    if (status.pid) {
      try {
        process.kill(status.pid, "SIGTERM");
      } catch {}
    }
  });

  test("creates status file with correct JSON structure", async () => {
    const result = await runLongRun(["echo", "hello"]);
    const id = extractId(result.stdout);

    // Wait for completion
    const status = await waitForStatus(id, "completed");

    expect(status.id).toBe(id);
    expect(status.command).toBeDefined();
    expect(status.cwd).toBe("/tmp");
    expect(status.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(status.pid).toBeGreaterThan(0);
    expect(status.status).toBe("completed");
    expect(status.exit_code).toBe(0);
  });

  test("transitions from starting → running → completed", async () => {
    // Use sleep 2 so we can catch the running state
    const result = await runLongRun(["sleep", "2"]);
    const id = extractId(result.stdout);

    // Should be running within 1 second
    const running = await waitForStatus(id, "running", 2000);
    expect(running.status).toBe("running");
    expect(running.pid).toBeGreaterThan(0);
    expect(running.exit_code).toBeNull();

    // Should complete within 5 seconds
    const completed = await waitForStatus(id, "completed", 5000);
    expect(completed.status).toBe("completed");
    expect(completed.exit_code).toBe(0);
    expect(completed.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("captures stdout to log file", async () => {
    const result = await runLongRun(["echo", "hello world"]);
    const id = extractId(result.stdout);

    await waitForStatus(id, "completed");

    const logFile = `${LONG_RUN_DIR}/${id}.log`;
    expect(existsSync(logFile)).toBe(true);

    const logContent = readFileSync(logFile, "utf-8");
    expect(logContent).toContain("hello world");
  });

  test("captures stderr to log file", async () => {
    const result = await runLongRun([
      "bash",
      "-c",
      "echo 'stdout line' && echo 'stderr line' >&2",
    ]);
    const id = extractId(result.stdout);

    await waitForStatus(id, "completed");

    const logContent = readFileSync(`${LONG_RUN_DIR}/${id}.log`, "utf-8");
    expect(logContent).toContain("stdout line");
    expect(logContent).toContain("stderr line");
  });

  test("propagates non-zero exit code", async () => {
    const result = await runLongRun(["bash", "-c", "exit 42"]);
    const id = extractId(result.stdout);

    const status = await waitForStatus(id, "completed");
    expect(status.exit_code).toBe(42);
  });

  test("records correct cwd", async () => {
    const result = await runLongRun(["echo", "test"], "/home/ubuntu");
    const id = extractId(result.stdout);

    const status = await waitForStatus(id, "completed");
    expect(status.cwd).toBe("/home/ubuntu");
  });

  test("generates unique IDs", async () => {
    const result1 = await runLongRun(["true"]);
    const result2 = await runLongRun(["true"]);

    const id1 = extractId(result1.stdout);
    const id2 = extractId(result2.stdout);

    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^\d{8}-\d{6}-[0-9a-f]+$/);
    expect(id2).toMatch(/^\d{8}-\d{6}-[0-9a-f]+$/);
  });

  test("fails with usage message when no args given", async () => {
    const result = await runLongRun([]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Usage: long-run");
  });

  test("JSON-encodes command string safely", async () => {
    const result = await runLongRun([
      "echo",
      'quotes "and" special $chars',
    ]);
    const id = extractId(result.stdout);

    const status = await waitForStatus(id, "completed");
    // The command field should be valid JSON string containing the args
    expect(status.command).toContain("quotes");
    expect(status.command).toContain("special");
  });
});
