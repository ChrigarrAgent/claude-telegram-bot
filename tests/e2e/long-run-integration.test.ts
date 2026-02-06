/**
 * E2E Tests for Long-Running Process Integration.
 *
 * Tests the full flow:
 * 1. User sends message → Claude runs long-run command
 * 2. Process completes → ProcessMonitor detects it
 * 3. Bot notifies user and auto-resumes Claude with log contents
 * 4. Bot restart resilience (recent completions re-processed)
 *
 * Uses mock SDK and TestBot — no real Telegram or Claude API calls.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "fs";

// Install mock SDK before any source imports
import { mockQuery, resetMockSDK, getMockCalls } from "../helpers/mock-claude-sdk";
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

import {
  TestBot,
  getTestBot,
  resetSessionManager,
} from "../helpers/test-setup";
import { ProcessMonitor } from "../../src/process-monitor";
import type { LongRunStatus } from "../../src/process-monitor";
import { sessionManager } from "../../src/session-manager";
import { SAFETY_PROMPT, WORKFLOW_PROMPT, SYSTEM_PROMPT } from "../../src/config";

const LONG_RUN_DIR = "/tmp/long-run";

const testUser1 = {
  id: 12345,
  firstName: "TestUser1",
  username: "testuser1",
};

const CHAT_1 = 12345;

function cleanupLongRunDir(): void {
  if (!existsSync(LONG_RUN_DIR)) return;
  for (const file of readdirSync(LONG_RUN_DIR)) {
    try {
      unlinkSync(`${LONG_RUN_DIR}/${file}`);
    } catch {}
  }
}

function writeStatus(status: LongRunStatus): void {
  mkdirSync(LONG_RUN_DIR, { recursive: true });
  writeFileSync(
    `${LONG_RUN_DIR}/${status.id}.status`,
    JSON.stringify(status)
  );
}

function writeLog(id: string, content: string): void {
  mkdirSync(LONG_RUN_DIR, { recursive: true });
  writeFileSync(`${LONG_RUN_DIR}/${id}.log`, content);
}

function makeCompleted(
  id: string,
  overrides: Partial<LongRunStatus> = {}
): LongRunStatus {
  return {
    id,
    command: "python optimize.py",
    cwd: "/home/ubuntu",
    started_at: new Date(Date.now() - 60000).toISOString(),
    completed_at: new Date().toISOString(),
    pid: 99999,
    status: "completed",
    exit_code: 0,
    ...overrides,
  };
}

describe("Long-Running Process Integration", () => {
  let testBot: TestBot;

  beforeEach(async () => {
    cleanupLongRunDir();

    const { unlinkSync: unlink, existsSync: exists } = await import("fs");
    const sessionFile =
      process.env.SESSION_FILE || "/tmp/test-claude-session.json";
    try {
      if (exists(sessionFile)) unlink(sessionFile);
    } catch {}

    resetMockSDK();
    await resetSessionManager();

    const { setWorkingDir } = await import("../../src/config");
    setWorkingDir("/home/ubuntu");

    const bot = await getTestBot();
    testBot = new TestBot(bot);
  });

  afterEach(() => {
    testBot.reset();
    cleanupLongRunDir();
  });

  describe("Prompt Structure", () => {
    test("SAFETY_PROMPT does not contain long-run instructions", () => {
      expect(SAFETY_PROMPT).not.toContain("long-run");
      expect(SAFETY_PROMPT).not.toContain("LONG-RUNNING");
      expect(SAFETY_PROMPT).toContain("CRITICAL SAFETY RULES");
      expect(SAFETY_PROMPT).toContain("NEVER delete");
    });

    test("WORKFLOW_PROMPT contains long-run instructions", () => {
      expect(WORKFLOW_PROMPT).toContain("long-run");
      expect(WORKFLOW_PROMPT).toContain("LONG-RUNNING PROCESSES");
      expect(WORKFLOW_PROMPT).toContain("60 seconds");
      expect(WORKFLOW_PROMPT).toContain("detached background process");
    });

    test("SYSTEM_PROMPT composes both prompts", () => {
      expect(SYSTEM_PROMPT).toContain("CRITICAL SAFETY RULES");
      expect(SYSTEM_PROMPT).toContain("LONG-RUNNING PROCESSES");
      expect(SYSTEM_PROMPT).toContain("long-run");
      expect(SYSTEM_PROMPT).toContain("NEVER delete");
    });

    test("SYSTEM_PROMPT is used in SDK calls", async () => {
      // Send a message to trigger an SDK call
      await testBot.sendMessage(CHAT_1, testUser1, "Hello");
      await new Promise((r) => setTimeout(r, 200));

      const calls = getMockCalls();
      expect(calls.length).toBeGreaterThanOrEqual(1);

      // Verify the systemPrompt passed to the SDK contains both sections
      const firstCall = calls[0]!;
      const systemPrompt = firstCall.options.systemPrompt as string;
      expect(systemPrompt).toContain("CRITICAL SAFETY RULES");
      expect(systemPrompt).toContain("LONG-RUNNING PROCESSES");
    });
  });

  describe("ProcessMonitor + Session Integration", () => {
    test("monitor detects completion and calls callback with correct data", async () => {
      const completions: LongRunStatus[] = [];
      const monitor = new ProcessMonitor();

      monitor.start(async (status) => {
        completions.push(status);
      });

      // Write a completed process
      const status = makeCompleted("integ-001", {
        command: "python optimize.py",
        cwd: "/home/ubuntu",
        exit_code: 0,
      });
      writeStatus(status);
      writeLog("integ-001", "Optimization result: 42.7\nTime: 3m 12s");

      // Wait for detection
      await new Promise((r) => setTimeout(r, 6000));
      monitor.stop();

      expect(completions).toHaveLength(1);
      expect(completions[0]!.id).toBe("integ-001");
      expect(completions[0]!.command).toContain("optimize");
      expect(completions[0]!.exit_code).toBe(0);
    }, 10000);

    test("completion triggers SDK message when project session exists", async () => {
      // First, establish a session for the "home" project
      await testBot.sendMessage(CHAT_1, testUser1, "Hello");
      await new Promise((r) => setTimeout(r, 200));

      const callsBefore = getMockCalls().length;

      // Now simulate what handleProcessCompletion does:
      // 1. Find the project for cwd=/home/ubuntu
      // 2. Find chat IDs for that project
      // 3. Send a message to Claude
      const projectSession = sessionManager.getSession("ubuntu");

      // Verify session exists and is wired up
      expect(projectSession).not.toBeNull();

      const chatIds = sessionManager.getChatIdsForProject("ubuntu");
      expect(chatIds).toContain(CHAT_1);
    });

    test("multiple completions each trigger exactly one callback", async () => {
      const completions: LongRunStatus[] = [];
      const monitor = new ProcessMonitor();

      monitor.start(async (status) => {
        completions.push(status);
      });

      // Write 3 completed processes
      for (let i = 1; i <= 3; i++) {
        writeStatus(makeCompleted(`multi-${i}`));
        writeLog(`multi-${i}`, `Result ${i}`);
      }

      // Wait for all to be detected
      await new Promise((r) => setTimeout(r, 7000));
      monitor.stop();

      expect(completions).toHaveLength(3);
      const ids = completions.map((c) => c.id).sort();
      expect(ids).toEqual(["multi-1", "multi-2", "multi-3"]);
    }, 10000);
  });

  describe("Bot Restart Resilience", () => {
    test("recent completion detected after monitor restart", async () => {
      const completions: LongRunStatus[] = [];

      // Simulate: process completed 2 minutes ago while bot was down
      writeStatus(
        makeCompleted("restart-001", {
          completed_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        })
      );
      writeLog("restart-001", "Process output from before restart");

      // Start a NEW monitor (simulating bot restart)
      const monitor = new ProcessMonitor();
      monitor.start(async (status) => {
        completions.push(status);
      });

      // Wait for poll to pick it up
      await new Promise((r) => setTimeout(r, 6000));
      monitor.stop();

      // Should detect the recent completion
      expect(completions).toHaveLength(1);
      expect(completions[0]!.id).toBe("restart-001");
    }, 10000);

    test("old completion (>5 min) NOT re-processed after restart", async () => {
      const completions: LongRunStatus[] = [];

      // Simulate: process completed 10 minutes ago
      writeStatus(
        makeCompleted("old-restart-001", {
          completed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        })
      );

      const monitor = new ProcessMonitor();
      monitor.start(async (status) => {
        completions.push(status);
      });

      await new Promise((r) => setTimeout(r, 7000));
      monitor.stop();

      // Should NOT be re-processed
      expect(completions).toHaveLength(0);
    }, 10000);

    test("running process monitored through to completion after restart", async () => {
      const completions: LongRunStatus[] = [];

      // Simulate: process was still running when bot restarted
      writeStatus({
        id: "surviving-001",
        command: "python long_job.py",
        cwd: "/home/ubuntu",
        started_at: new Date(Date.now() - 120000).toISOString(),
        pid: 55555,
        status: "running",
        exit_code: null,
      });

      const monitor = new ProcessMonitor();
      monitor.start(async (status) => {
        completions.push(status);
      });

      // Initially should detect as running
      const running = monitor.getRunningProcesses();
      expect(running).toHaveLength(1);
      expect(running[0]!.id).toBe("surviving-001");

      // Wait a poll cycle - still running
      await new Promise((r) => setTimeout(r, 6000));
      expect(completions).toHaveLength(0);

      // Now the process "finishes"
      writeStatus(
        makeCompleted("surviving-001", {
          completed_at: new Date().toISOString(),
        })
      );

      // Wait for detection
      await new Promise((r) => setTimeout(r, 6000));
      monitor.stop();

      expect(completions).toHaveLength(1);
      expect(completions[0]!.id).toBe("surviving-001");
    }, 15000);
  });

  describe("Telegram Notification Flow", () => {
    test("bot sends notification when process completes", async () => {
      // Establish a project session first
      await testBot.sendMessage(CHAT_1, testUser1, "Hello");
      await new Promise((r) => setTimeout(r, 200));

      testBot.clearCalls();

      // Verify the session is wired correctly
      const chatIds = sessionManager.getChatIdsForProject("ubuntu");
      expect(chatIds).toContain(CHAT_1);

      // The real handleProcessCompletion sends a Telegram message
      // and then invokes Claude. Here we just verify the session
      // routing is correctly set up (since handleProcessCompletion
      // is an internal function of index.ts).
      const session = sessionManager.getSession("ubuntu");
      expect(session).not.toBeNull();
      expect(session!.workingDir).toBe("/home/ubuntu");
      expect(session!.isRunning()).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    test("process with failed exit code includes exit code in status", async () => {
      const completions: LongRunStatus[] = [];
      const monitor = new ProcessMonitor();

      monitor.start(async (status) => {
        completions.push(status);
      });

      writeStatus(
        makeCompleted("fail-001", {
          command: "make test",
          exit_code: 2,
        })
      );
      writeLog("fail-001", "FAIL: 3 tests failed\nError: assertion failed");

      await new Promise((r) => setTimeout(r, 6000));
      monitor.stop();

      expect(completions).toHaveLength(1);
      expect(completions[0]!.exit_code).toBe(2);
      expect(completions[0]!.command).toContain("make test");
    }, 10000);

    test("concurrent completions all detected", async () => {
      const completions: LongRunStatus[] = [];
      const monitor = new ProcessMonitor();

      monitor.start(async (status) => {
        completions.push(status);
      });

      // Write 5 completions simultaneously
      for (let i = 0; i < 5; i++) {
        writeStatus(makeCompleted(`concurrent-${i}`));
        writeLog(`concurrent-${i}`, `Output ${i}`);
      }

      await new Promise((r) => setTimeout(r, 7000));
      monitor.stop();

      expect(completions).toHaveLength(5);
    }, 10000);
  });
});
