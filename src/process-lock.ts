/**
 * Process Lock for Claude Telegram Bot
 *
 * Prevents multiple bot instances from running simultaneously,
 * which causes 409 Conflict errors with Telegram's getUpdates.
 *
 * Features:
 * - PID file-based locking
 * - Stale process detection and cleanup
 * - Automatic cleanup on graceful shutdown
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { hostname } from "os";
import { execSync } from "child_process";

const PID_FILE = "/tmp/claude-telegram-bot.pid";

export interface LockData {
  pid: number;
  startedAt: string;
  hostname: string;
}

export interface AcquireLockResult {
  success: boolean;
  message: string;
  stalePid?: number;
  killedPids?: number[];
}

/**
 * Check if a process with the given PID is running.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // Send signal 0 to check if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the current lock file data.
 */
export function readLockFile(): LockData | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const content = readFileSync(PID_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write a new lock file with the current process info.
 */
export function writeLockFile(): void {
  const data: LockData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
  };
  writeFileSync(PID_FILE, JSON.stringify(data, null, 2));
}

/**
 * Remove the lock file.
 */
export function removeLockFile(): void {
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
  } catch (error) {
    console.warn("Failed to remove lock file:", error);
  }
}

/**
 * Find and kill any stale bot processes.
 * Returns the list of PIDs that were killed.
 */
export function killStaleBotProcesses(): number[] {
  const killedPids: number[] = [];

  try {
    // Find all bun processes running claude-telegram-bot
    const output = execSync(
      'pgrep -f "bun.*claude-telegram-bot" 2>/dev/null || true',
      { encoding: "utf-8" }
    ).trim();

    if (!output) return killedPids;

    const pids = output
      .split("\n")
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => !isNaN(pid) && pid !== process.pid);

    for (const pid of pids) {
      try {
        // Double-check process is still running before trying to kill
        if (!isProcessRunning(pid)) {
          console.log(`Process PID ${pid} already terminated`);
          continue;
        }

        console.log(`Killing stale bot process: PID ${pid}`);
        process.kill(pid, "SIGTERM");
        killedPids.push(pid);

        // Give it a moment to shut down gracefully
        // Then force kill if still running
        setTimeout(() => {
          if (isProcessRunning(pid)) {
            try {
              process.kill(pid, "SIGKILL");
              console.log(`Force killed process: PID ${pid}`);
            } catch {
              // Process already dead
            }
          }
        }, 2000);
      } catch (error: any) {
        // Process may have already died - this is fine
        if (error?.code === "ESRCH") {
          console.log(`Process PID ${pid} already terminated`);
        } else {
          console.warn(`Could not kill PID ${pid}:`, error?.message || error);
        }
      }
    }
  } catch (error) {
    console.warn("Error finding stale processes:", error);
  }

  return killedPids;
}

/**
 * Acquire the process lock.
 *
 * 1. Check if lock file exists
 * 2. If exists and process is running, fail (another instance active)
 * 3. If exists but process not running, clean up stale lock
 * 4. Kill any other bot processes
 * 5. Create new lock file
 */
export function acquireLock(): AcquireLockResult {
  const existingLock = readLockFile();

  if (existingLock) {
    if (isProcessRunning(existingLock.pid)) {
      // Another instance is genuinely running
      return {
        success: false,
        message: `Another instance is already running (PID ${existingLock.pid}, started ${existingLock.startedAt})`,
      };
    } else {
      // Stale lock - the process died without cleanup
      console.log(
        `Found stale lock from PID ${existingLock.pid} (process no longer running)`
      );
      removeLockFile();
    }
  }

  // Kill any stale bot processes that might be lingering
  const killedPids = killStaleBotProcesses();

  if (killedPids.length > 0) {
    console.log(`Killed ${killedPids.length} stale bot process(es): ${killedPids.join(", ")}`);
    // Wait a moment for processes to fully terminate
    // This is synchronous because we need to ensure cleanup before proceeding
    execSync("sleep 2");
  }

  // Create new lock
  writeLockFile();

  const stalePid = existingLock?.pid;
  return {
    success: true,
    message: stalePid
      ? `Acquired lock (replaced stale lock from PID ${stalePid})`
      : "Lock acquired",
    stalePid,
    killedPids: killedPids.length > 0 ? killedPids : undefined,
  };
}

/**
 * Release the process lock (for graceful shutdown).
 */
export function releaseLock(): void {
  const existingLock = readLockFile();

  // Only remove if we own the lock
  if (existingLock && existingLock.pid === process.pid) {
    removeLockFile();
    console.log("Released process lock");
  }
}

/**
 * Setup signal handlers for graceful shutdown.
 * This should be called early in startup.
 */
export function setupLockCleanup(): void {
  const cleanup = () => {
    releaseLock();
  };

  // These handlers run before the main shutdown handlers
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("beforeExit", cleanup);
}

/**
 * Get lock status for diagnostics.
 */
export function getLockStatus(): {
  locked: boolean;
  ownedByUs: boolean;
  lockData: LockData | null;
  processRunning: boolean;
} {
  const lockData = readLockFile();

  if (!lockData) {
    return {
      locked: false,
      ownedByUs: false,
      lockData: null,
      processRunning: false,
    };
  }

  const processRunning = isProcessRunning(lockData.pid);
  const ownedByUs = lockData.pid === process.pid;

  return {
    locked: true,
    ownedByUs,
    lockData,
    processRunning,
  };
}

/**
 * Force acquire lock by killing any existing instance.
 * Use with caution - only for explicit user-requested restarts.
 */
export function forceAcquireLock(): AcquireLockResult {
  const existingLock = readLockFile();

  if (existingLock && isProcessRunning(existingLock.pid)) {
    console.log(`Force killing existing instance (PID ${existingLock.pid})`);
    try {
      process.kill(existingLock.pid, "SIGTERM");

      // Wait and force kill if necessary
      setTimeout(() => {
        if (isProcessRunning(existingLock.pid)) {
          try {
            process.kill(existingLock.pid, "SIGKILL");
          } catch {
            // Process already dead
          }
        }
      }, 2000);
    } catch (error) {
      console.warn(`Could not kill PID ${existingLock.pid}:`, error);
    }
  }

  // Clean up and kill any other stale processes
  removeLockFile();
  const killedPids = killStaleBotProcesses();

  // Wait for processes to die
  if (existingLock || killedPids.length > 0) {
    execSync("sleep 3");
  }

  // Create new lock
  writeLockFile();

  return {
    success: true,
    message: existingLock
      ? `Force acquired lock (killed PID ${existingLock.pid})`
      : "Lock acquired",
    stalePid: existingLock?.pid,
    killedPids,
  };
}
