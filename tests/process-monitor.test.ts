/**
 * Tests for ProcessMonitor.
 *
 * Verifies: completion detection, deduplication, initial scan behavior,
 * recent completion re-processing, cleanup, and running process tracking.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "fs";

import { ProcessMonitor } from "../src/process-monitor";
import type { LongRunStatus } from "../src/process-monitor";

const LONG_RUN_DIR = "/tmp/long-run";

/** Write a status file to /tmp/long-run/ */
function writeStatus(status: LongRunStatus): void {
  mkdirSync(LONG_RUN_DIR, { recursive: true });
  writeFileSync(
    `${LONG_RUN_DIR}/${status.id}.status`,
    JSON.stringify(status)
  );
}

/** Write a dummy log file */
function writeLog(id: string, content: string): void {
  mkdirSync(LONG_RUN_DIR, { recursive: true });
  writeFileSync(`${LONG_RUN_DIR}/${id}.log`, content);
}

/** Clean all files in /tmp/long-run/ */
function cleanupDir(): void {
  if (!existsSync(LONG_RUN_DIR)) return;
  for (const file of readdirSync(LONG_RUN_DIR)) {
    try {
      unlinkSync(`${LONG_RUN_DIR}/${file}`);
    } catch {}
  }
}

/** Create a completed status object */
function makeCompleted(
  id: string,
  overrides: Partial<LongRunStatus> = {}
): LongRunStatus {
  return {
    id,
    command: "test command",
    cwd: "/tmp",
    started_at: new Date(Date.now() - 60000).toISOString(),
    completed_at: new Date().toISOString(),
    pid: 12345,
    status: "completed",
    exit_code: 0,
    ...overrides,
  };
}

/** Create a running status object */
function makeRunning(
  id: string,
  overrides: Partial<LongRunStatus> = {}
): LongRunStatus {
  return {
    id,
    command: "test command",
    cwd: "/tmp",
    started_at: new Date().toISOString(),
    pid: 12345,
    status: "running",
    exit_code: null,
    ...overrides,
  };
}

describe("ProcessMonitor", () => {
  let monitor: ProcessMonitor;

  beforeEach(() => {
    cleanupDir();
    monitor = new ProcessMonitor();
  });

  afterEach(() => {
    monitor.stop();
    cleanupDir();
  });

  describe("completion detection", () => {
    test("calls callback when process completes", async () => {
      const completions: LongRunStatus[] = [];

      monitor.start(async (status) => {
        completions.push(status);
      });

      // Write a running process
      const running = makeRunning("test-001");
      writeStatus(running);

      // Wait a poll cycle
      await new Promise((r) => setTimeout(r, 200));
      expect(completions).toHaveLength(0);

      // Now mark it completed
      const completed = makeCompleted("test-001");
      writeStatus(completed);

      // Wait for poll to detect it
      await new Promise((r) => setTimeout(r, 6000));

      expect(completions).toHaveLength(1);
      expect(completions[0]!.id).toBe("test-001");
      expect(completions[0]!.status).toBe("completed");
      expect(completions[0]!.exit_code).toBe(0);
    }, 10000);

    test("fires callback only once per completion (dedup)", async () => {
      const completions: LongRunStatus[] = [];

      monitor.start(async (status) => {
        completions.push(status);
      });

      // Write completed process
      writeStatus(makeCompleted("test-002"));

      // Wait for multiple poll cycles
      await new Promise((r) => setTimeout(r, 12000));

      expect(completions).toHaveLength(1);
    }, 15000);

    test("handles non-zero exit codes", async () => {
      const completions: LongRunStatus[] = [];

      monitor.start(async (status) => {
        completions.push(status);
      });

      writeStatus(makeCompleted("test-003", { exit_code: 1 }));

      await new Promise((r) => setTimeout(r, 6000));

      expect(completions).toHaveLength(1);
      expect(completions[0]!.exit_code).toBe(1);
    }, 10000);
  });

  describe("initial scan", () => {
    test("old completions are NOT re-processed on startup", async () => {
      const completions: LongRunStatus[] = [];

      // Write a completion from 10 minutes ago
      writeStatus(
        makeCompleted("old-001", {
          completed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        })
      );

      monitor.start(async (status) => {
        completions.push(status);
      });

      // Wait for poll cycles
      await new Promise((r) => setTimeout(r, 7000));

      // Should NOT trigger callback (too old)
      expect(completions).toHaveLength(0);
    }, 10000);

    test("recent completions (< 5 min) ARE re-processed on startup", async () => {
      const completions: LongRunStatus[] = [];

      // Write a completion from 2 minutes ago
      writeStatus(
        makeCompleted("recent-001", {
          completed_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        })
      );

      monitor.start(async (status) => {
        completions.push(status);
      });

      // Wait for poll to pick it up
      await new Promise((r) => setTimeout(r, 6000));

      expect(completions).toHaveLength(1);
      expect(completions[0]!.id).toBe("recent-001");
    }, 10000);
  });

  describe("getRunningProcesses", () => {
    test("returns running and starting processes", () => {
      writeStatus(makeRunning("run-001"));
      writeStatus({
        ...makeRunning("start-001"),
        status: "starting",
      });
      writeStatus(makeCompleted("done-001"));

      // Need to call start to enable reading, then check
      const m = new ProcessMonitor();
      m.start(async () => {});

      const running = m.getRunningProcesses();
      m.stop();

      expect(running).toHaveLength(2);
      const ids = running.map((r) => r.id).sort();
      expect(ids).toContain("run-001");
      expect(ids).toContain("start-001");
    });
  });

  describe("error resilience", () => {
    test("skips bad JSON in status files", async () => {
      const completions: LongRunStatus[] = [];

      mkdirSync(LONG_RUN_DIR, { recursive: true });
      writeFileSync(`${LONG_RUN_DIR}/bad-json.status`, "not json{{{");
      writeStatus(makeCompleted("good-001"));

      monitor.start(async (status) => {
        completions.push(status);
      });

      await new Promise((r) => setTimeout(r, 6000));

      // Should process the good one and skip the bad one
      expect(completions).toHaveLength(1);
      expect(completions[0]!.id).toBe("good-001");
    }, 10000);

    test("handles missing /tmp/long-run directory", () => {
      // Remove the directory entirely
      cleanupDir();
      try {
        const { rmdirSync } = require("fs");
        rmdirSync(LONG_RUN_DIR);
      } catch {}

      // Should not throw
      const m = new ProcessMonitor();
      m.start(async () => {});
      const running = m.getRunningProcesses();
      m.stop();

      expect(running).toHaveLength(0);
    });

    test("callback errors don't crash the monitor", async () => {
      let callCount = 0;

      monitor.start(async (status) => {
        callCount++;
        if (status.id === "crash-001") {
          throw new Error("Callback exploded");
        }
      });

      // Write two completions - first throws, second should still work
      writeStatus(makeCompleted("crash-001"));

      await new Promise((r) => setTimeout(r, 6000));

      // The callback was called (even though it threw)
      expect(callCount).toBe(1);

      // Write another one - monitor should still be running
      writeStatus(makeCompleted("ok-001"));
      await new Promise((r) => setTimeout(r, 6000));

      expect(callCount).toBe(2);
    }, 15000);
  });

  describe("cleanup", () => {
    test("removes files older than 24 hours on startup", () => {
      // Write an old completed process (started 25 hours ago)
      const oldStatus = makeCompleted("old-cleanup-001", {
        started_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        completed_at: new Date(
          Date.now() - 25 * 60 * 60 * 1000 + 1000
        ).toISOString(),
      });
      writeStatus(oldStatus);
      writeLog("old-cleanup-001", "old log output");

      // Write a recent process
      writeStatus(makeCompleted("new-001"));
      writeLog("new-001", "recent log output");

      // Start monitor (triggers initial scan + cleanup)
      const m = new ProcessMonitor();
      m.start(async () => {});
      m.stop();

      // Old files should be cleaned up
      expect(existsSync(`${LONG_RUN_DIR}/old-cleanup-001.status`)).toBe(false);
      expect(existsSync(`${LONG_RUN_DIR}/old-cleanup-001.log`)).toBe(false);

      // New files should still exist
      expect(existsSync(`${LONG_RUN_DIR}/new-001.status`)).toBe(true);
      expect(existsSync(`${LONG_RUN_DIR}/new-001.log`)).toBe(true);
    });
  });

  describe("stop", () => {
    test("stop() prevents further polling", async () => {
      const completions: LongRunStatus[] = [];

      monitor.start(async (status) => {
        completions.push(status);
      });

      monitor.stop();

      // Write a completion after stopping
      writeStatus(makeCompleted("after-stop-001"));

      await new Promise((r) => setTimeout(r, 7000));

      // Should NOT be detected
      expect(completions).toHaveLength(0);
    }, 10000);
  });
});
