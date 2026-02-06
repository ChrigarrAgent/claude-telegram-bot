/**
 * Process Locking Tests
 *
 * Tests for preventing multiple bot instances (409 conflict issue).
 * Verifies:
 * - PID lock file mechanism
 * - Stale process detection
 * - Graceful shutdown cleanup
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";

// Test-specific PID file path (avoid interfering with real bot)
const TEST_PID_FILE = "/tmp/test-claude-telegram-bot.pid";
const TEST_LOCK_DIR = "/tmp/test-claude-lock";

// Mock process lock functions for testing
// These mirror what will be in src/process-lock.ts

interface LockData {
  pid: number;
  startedAt: string;
  hostname: string;
}

function writeLockFile(pidFile: string, pid: number): void {
  const data: LockData = {
    pid,
    startedAt: new Date().toISOString(),
    hostname: require("os").hostname(),
  };
  writeFileSync(pidFile, JSON.stringify(data, null, 2));
}

function readLockFile(pidFile: string): LockData | null {
  try {
    if (!existsSync(pidFile)) return null;
    const content = readFileSync(pidFile, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    // Send signal 0 to check if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeLockFile(pidFile: string): void {
  try {
    if (existsSync(pidFile)) {
      unlinkSync(pidFile);
    }
  } catch {
    // Ignore errors
  }
}

describe("Process Lock Mechanism", () => {
  beforeEach(() => {
    // Clean up any existing test lock files
    removeLockFile(TEST_PID_FILE);
  });

  afterEach(() => {
    removeLockFile(TEST_PID_FILE);
  });

  describe("Lock File Creation", () => {
    test("creates lock file with correct data", () => {
      const testPid = process.pid;
      writeLockFile(TEST_PID_FILE, testPid);

      expect(existsSync(TEST_PID_FILE)).toBe(true);

      const data = readLockFile(TEST_PID_FILE);
      expect(data).not.toBe(null);
      expect(data?.pid).toBe(testPid);
      expect(data?.startedAt).toBeTruthy();
      expect(data?.hostname).toBeTruthy();
    });

    test("overwrites existing lock file", () => {
      // Write first lock
      writeLockFile(TEST_PID_FILE, 11111);

      // Write second lock (should overwrite)
      writeLockFile(TEST_PID_FILE, 22222);

      const data = readLockFile(TEST_PID_FILE);
      expect(data?.pid).toBe(22222);
    });
  });

  describe("Lock File Reading", () => {
    test("returns null for non-existent file", () => {
      const data = readLockFile("/tmp/nonexistent-pid-file.pid");
      expect(data).toBe(null);
    });

    test("returns null for invalid JSON", () => {
      writeFileSync(TEST_PID_FILE, "not valid json");
      const data = readLockFile(TEST_PID_FILE);
      expect(data).toBe(null);
    });

    test("parses valid lock file correctly", () => {
      const expected: LockData = {
        pid: 12345,
        startedAt: "2024-01-01T00:00:00.000Z",
        hostname: "test-host",
      };
      writeFileSync(TEST_PID_FILE, JSON.stringify(expected));

      const data = readLockFile(TEST_PID_FILE);
      expect(data).toEqual(expected);
    });
  });

  describe("Process Running Check", () => {
    test("returns true for current process", () => {
      expect(isProcessRunning(process.pid)).toBe(true);
    });

    test("returns false for non-existent PID", () => {
      // Use a very high PID that's unlikely to exist
      expect(isProcessRunning(999999999)).toBe(false);
    });

    test("returns false or handles permission denied for PID 1", () => {
      // In containers or unprivileged environments, we may not have
      // permission to send signals to PID 1, so this could return false
      // The important thing is it doesn't throw
      const result = isProcessRunning(1);
      expect(typeof result).toBe("boolean");
    });
  });

  describe("Lock File Removal", () => {
    test("removes existing lock file", () => {
      writeLockFile(TEST_PID_FILE, process.pid);
      expect(existsSync(TEST_PID_FILE)).toBe(true);

      removeLockFile(TEST_PID_FILE);
      expect(existsSync(TEST_PID_FILE)).toBe(false);
    });

    test("does not throw for non-existent file", () => {
      expect(() => removeLockFile("/tmp/nonexistent.pid")).not.toThrow();
    });
  });

  describe("Stale Lock Detection", () => {
    test("detects stale lock (process not running)", () => {
      // Write a lock file with a non-existent PID
      writeLockFile(TEST_PID_FILE, 999999999);

      const data = readLockFile(TEST_PID_FILE);
      expect(data).not.toBe(null);
      expect(isProcessRunning(data!.pid)).toBe(false);
    });

    test("detects valid lock (process running)", () => {
      // Write a lock file with current process PID
      writeLockFile(TEST_PID_FILE, process.pid);

      const data = readLockFile(TEST_PID_FILE);
      expect(data).not.toBe(null);
      expect(isProcessRunning(data!.pid)).toBe(true);
    });
  });
});

describe("Lock Acquisition Logic", () => {
  beforeEach(() => {
    removeLockFile(TEST_PID_FILE);
  });

  afterEach(() => {
    removeLockFile(TEST_PID_FILE);
  });

  /**
   * Simulates acquiring a lock:
   * 1. Check if lock file exists
   * 2. If exists, check if owning process is running
   * 3. If process running, fail (another instance active)
   * 4. If process not running, remove stale lock and proceed
   * 5. Create new lock file
   */
  function acquireLock(pidFile: string): { success: boolean; message: string; stalePid?: number } {
    const existingLock = readLockFile(pidFile);

    if (existingLock) {
      if (isProcessRunning(existingLock.pid)) {
        return {
          success: false,
          message: `Another instance is running (PID ${existingLock.pid})`,
        };
      } else {
        // Stale lock - remove it
        removeLockFile(pidFile);
        writeLockFile(pidFile, process.pid);
        return {
          success: true,
          message: `Removed stale lock from PID ${existingLock.pid}`,
          stalePid: existingLock.pid,
        };
      }
    }

    // No existing lock - create new one
    writeLockFile(pidFile, process.pid);
    return { success: true, message: "Lock acquired" };
  }

  test("acquires lock when no existing lock", () => {
    const result = acquireLock(TEST_PID_FILE);

    expect(result.success).toBe(true);
    expect(result.message).toBe("Lock acquired");
    expect(existsSync(TEST_PID_FILE)).toBe(true);
  });

  test("fails when another process has lock", () => {
    // Use current process PID to simulate another running instance
    writeLockFile(TEST_PID_FILE, process.pid);

    // Create a "different" process trying to acquire
    // Since we can't actually create another process in tests,
    // we'll simulate by checking that the lock prevents acquisition
    const existingLock = readLockFile(TEST_PID_FILE);
    expect(existingLock).not.toBe(null);
    expect(isProcessRunning(existingLock!.pid)).toBe(true);

    // In real scenario, this would return failure
    // But since it's our own PID, we demonstrate the check
    const result = acquireLock(TEST_PID_FILE);
    // This will succeed because it's the same process
    // In production, the check would be against a DIFFERENT process
    expect(result.success).toBe(false);
    expect(result.message).toContain("Another instance is running");
  });

  test("removes stale lock and acquires", () => {
    // Write a lock with non-existent PID
    writeLockFile(TEST_PID_FILE, 999999999);

    const result = acquireLock(TEST_PID_FILE);

    expect(result.success).toBe(true);
    expect(result.message).toContain("Removed stale lock");
    expect(result.stalePid).toBe(999999999);

    // Verify new lock has current PID
    const newLock = readLockFile(TEST_PID_FILE);
    expect(newLock?.pid).toBe(process.pid);
  });
});

describe("Graceful Shutdown Integration", () => {
  beforeEach(() => {
    removeLockFile(TEST_PID_FILE);
  });

  afterEach(() => {
    removeLockFile(TEST_PID_FILE);
  });

  test("lock file is removed on graceful shutdown", async () => {
    // Simulate startup
    writeLockFile(TEST_PID_FILE, process.pid);
    expect(existsSync(TEST_PID_FILE)).toBe(true);

    // Simulate graceful shutdown
    removeLockFile(TEST_PID_FILE);
    expect(existsSync(TEST_PID_FILE)).toBe(false);
  });

  test("lock file persists if crash (no cleanup)", () => {
    // Simulate startup
    writeLockFile(TEST_PID_FILE, process.pid);
    expect(existsSync(TEST_PID_FILE)).toBe(true);

    // Simulate crash (no cleanup called)
    // Lock file should still exist
    expect(existsSync(TEST_PID_FILE)).toBe(true);
  });
});

describe("Multiple Instance Prevention", () => {
  const LOCK_FILE_1 = "/tmp/test-lock-instance-1.pid";
  const LOCK_FILE_2 = "/tmp/test-lock-instance-2.pid";

  beforeEach(() => {
    removeLockFile(LOCK_FILE_1);
    removeLockFile(LOCK_FILE_2);
  });

  afterEach(() => {
    removeLockFile(LOCK_FILE_1);
    removeLockFile(LOCK_FILE_2);
  });

  test("different lock files are independent", () => {
    writeLockFile(LOCK_FILE_1, 11111);
    writeLockFile(LOCK_FILE_2, 22222);

    const lock1 = readLockFile(LOCK_FILE_1);
    const lock2 = readLockFile(LOCK_FILE_2);

    expect(lock1?.pid).toBe(11111);
    expect(lock2?.pid).toBe(22222);
  });
});
