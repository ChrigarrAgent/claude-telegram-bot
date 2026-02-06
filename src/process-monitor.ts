/**
 * Process monitor for long-running background commands.
 *
 * Polls /tmp/long-run/ for status changes and triggers callbacks
 * when processes complete. Handles bot restarts gracefully.
 */

import { readdirSync, readFileSync, unlinkSync, statSync } from "fs";
import { existsSync } from "fs";

const LONG_RUN_DIR = "/tmp/long-run";
const POLL_INTERVAL_MS = 5_000;
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const RECENT_COMPLETION_MS = 5 * 60 * 1000; // 5 minutes

export interface LongRunStatus {
  id: string;
  command: string;
  cwd: string;
  started_at: string;
  completed_at?: string;
  pid: number | null;
  status: "starting" | "running" | "completed";
  exit_code: number | null;
}

type CompletionCallback = (status: LongRunStatus) => Promise<void>;

export class ProcessMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private handledIds = new Set<string>();
  private callback: CompletionCallback | null = null;

  /**
   * Start monitoring for process completions.
   * On startup, already-completed processes are marked as handled
   * unless they completed within the last 5 minutes (handles bot-was-down case).
   */
  start(callback: CompletionCallback): void {
    this.callback = callback;
    this.initialScan();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    console.log("ProcessMonitor started");
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("ProcessMonitor stopped");
  }

  /**
   * Get all currently running processes.
   */
  getRunningProcesses(): LongRunStatus[] {
    const statuses = this.readAllStatuses();
    return statuses.filter((s) => s.status === "running" || s.status === "starting");
  }

  /**
   * Initial scan: mark old completions as handled, but re-process recent ones.
   */
  private initialScan(): void {
    const statuses = this.readAllStatuses();
    const now = Date.now();

    for (const status of statuses) {
      if (status.status === "completed") {
        const completedAt = status.completed_at
          ? new Date(status.completed_at).getTime()
          : 0;
        const age = now - completedAt;

        if (age > RECENT_COMPLETION_MS) {
          // Old completion — mark as handled, don't fire callback
          this.handledIds.add(status.id);
        }
        // Recent completions are NOT added to handledIds,
        // so they'll be picked up in the next poll cycle
      }
    }

    this.cleanup(statuses);

    const running = statuses.filter(
      (s) => s.status === "running" || s.status === "starting"
    ).length;
    const pending = statuses.filter(
      (s) => s.status === "completed" && !this.handledIds.has(s.id)
    ).length;

    if (running > 0 || pending > 0) {
      console.log(
        `ProcessMonitor initial scan: ${running} running, ${pending} pending notifications`
      );
    }
  }

  /**
   * Poll for status changes.
   */
  private async poll(): Promise<void> {
    const statuses = this.readAllStatuses();

    for (const status of statuses) {
      if (status.status === "completed" && !this.handledIds.has(status.id)) {
        this.handledIds.add(status.id);

        if (this.callback) {
          try {
            await this.callback(status);
          } catch (error) {
            console.error(
              `ProcessMonitor callback error for ${status.id}:`,
              error
            );
          }
        }
      }
    }
  }

  /**
   * Read all status files from /tmp/long-run/.
   */
  private readAllStatuses(): LongRunStatus[] {
    if (!existsSync(LONG_RUN_DIR)) {
      return [];
    }

    const results: LongRunStatus[] = [];

    try {
      const files = readdirSync(LONG_RUN_DIR);

      for (const file of files) {
        if (!file.endsWith(".status")) continue;

        try {
          const content = readFileSync(`${LONG_RUN_DIR}/${file}`, "utf-8");
          const status: LongRunStatus = JSON.parse(content);
          results.push(status);
        } catch {
          // Bad JSON or read error — skip and retry next poll
        }
      }
    } catch {
      // Directory read error
    }

    return results;
  }

  /**
   * Remove status+log files older than 24 hours.
   */
  private cleanup(statuses: LongRunStatus[]): void {
    const now = Date.now();

    for (const status of statuses) {
      const startedAt = new Date(status.started_at).getTime();
      if (now - startedAt > CLEANUP_AGE_MS && status.status === "completed") {
        try {
          const statusFile = `${LONG_RUN_DIR}/${status.id}.status`;
          const logFile = `${LONG_RUN_DIR}/${status.id}.log`;

          if (existsSync(statusFile)) unlinkSync(statusFile);
          if (existsSync(logFile)) unlinkSync(logFile);

          this.handledIds.delete(status.id);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
}

export const processMonitor = new ProcessMonitor();
