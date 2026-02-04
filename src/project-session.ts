/**
 * ProjectSession wraps ClaudeSession with project-specific context.
 *
 * Each project has its own session, working directory, and activity tracking.
 */

import type { ClaudeSession } from "./session";
import type { SessionStatus } from "./session-manager";
import type { Context } from "grammy";
import type { StatusCallback } from "./types";

export class ProjectSession {
  projectName: string;
  workingDir: string;
  session: ClaudeSession;
  lastActivity: Date;
  private queryLock = false;

  constructor(projectName: string, workingDir: string, session: ClaudeSession) {
    this.projectName = projectName;
    this.workingDir = workingDir;
    this.session = session;
    this.lastActivity = new Date();
  }

  /**
   * Send message to Claude (with query locking).
   */
  async sendMessage(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context
  ): Promise<string> {
    if (this.queryLock) {
      throw new Error(`Query already running for project: ${this.projectName}`);
    }

    this.queryLock = true;
    try {
      const result = await this.session.sendMessageStreaming(
        message,
        username,
        userId,
        statusCallback,
        chatId,
        ctx
      );
      this.lastActivity = new Date();
      return result;
    } finally {
      this.queryLock = false;
    }
  }

  /**
   * Kill the session (clear session_id).
   */
  async kill(): Promise<void> {
    await this.session.kill();
    this.lastActivity = new Date();
  }

  /**
   * Check if session is active (has session_id).
   */
  isActive(): boolean {
    return this.session.sessionId !== null;
  }

  /**
   * Check if query is currently running.
   */
  isRunning(): boolean {
    return this.queryLock || this.session.isRunning;
  }

  /**
   * Update last activity timestamp.
   */
  updateActivity(): void {
    this.lastActivity = new Date();
  }

  /**
   * Get idle time in milliseconds.
   */
  getIdleTime(): number {
    return Date.now() - this.lastActivity.getTime();
  }

  /**
   * Get session status for display.
   */
  getStatus(): SessionStatus {
    return {
      projectName: this.projectName,
      workingDir: this.workingDir,
      isActive: this.isActive(),
      isRunning: this.isRunning(),
      sessionId: this.session.sessionId,
      lastActivity: this.lastActivity,
      idleSeconds: Math.floor(this.getIdleTime() / 1000),
    };
  }
}
