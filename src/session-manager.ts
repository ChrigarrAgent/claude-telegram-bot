/**
 * Multi-project session manager for Claude Telegram Bot.
 *
 * Manages multiple concurrent Claude Code sessions across different projects,
 * with race condition protection and per-chat project tracking.
 */

import type { ProjectSession } from "./project-session";
import { ClaudeSession } from "./session";
import { resolveProjectPath } from "./config";

export interface SessionStatus {
  projectName: string;
  workingDir: string;
  isActive: boolean;
  isRunning: boolean;
  sessionId: string | null;
  lastActivity: Date | null;
  idleSeconds: number;
}

/**
 * SessionManager coordinates multiple ProjectSession instances.
 */
class SessionManager {
  private sessions = new Map<string, ProjectSession>();
  private creationLocks = new Map<string, Promise<ProjectSession>>();
  private lastUsedPerChat = new Map<number, string>();
  private currentProject: string = "default";

  /**
   * Get or create a session for a project (with race condition protection).
   */
  async getOrCreateSession(projectName: string): Promise<ProjectSession> {
    // Check if already creating (prevent duplicate sessions)
    if (this.creationLocks.has(projectName)) {
      return this.creationLocks.get(projectName)!;
    }

    // Check if already exists
    if (this.sessions.has(projectName)) {
      return this.sessions.get(projectName)!;
    }

    // Create with lock
    const creationPromise = this._createSession(projectName);
    this.creationLocks.set(projectName, creationPromise);

    try {
      const session = await creationPromise;
      this.sessions.set(projectName, session);
      return session;
    } finally {
      this.creationLocks.delete(projectName);
    }
  }

  /**
   * Internal session creation (imported dynamically to avoid circular deps).
   */
  private async _createSession(projectName: string): Promise<ProjectSession> {
    const { ProjectSession: PS } = await import("./project-session");
    const workingDir = resolveProjectPath(projectName);
    const claudeSession = new ClaudeSession();
    return new PS(projectName, workingDir, claudeSession);
  }

  /**
   * Get existing session (does not create).
   */
  getSession(projectName: string): ProjectSession | null {
    return this.sessions.get(projectName) || null;
  }

  /**
   * Get all active sessions.
   */
  getAllSessions(): ProjectSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get current project name.
   */
  getCurrentProject(): string {
    return this.currentProject;
  }

  /**
   * Set current project (for legacy compatibility).
   */
  setCurrentProject(projectName: string): void {
    this.currentProject = projectName;
  }

  /**
   * Track last-used project for a chat.
   */
  setLastUsed(chatId: number, projectName: string): void {
    this.lastUsedPerChat.set(chatId, projectName);
    this.currentProject = projectName;
  }

  /**
   * Get last-used project for a chat.
   */
  getLastUsed(chatId: number): string | null {
    return this.lastUsedPerChat.get(chatId) || null;
  }

  /**
   * Get all chat IDs that are using a specific project.
   */
  getChatIdsForProject(projectName: string): number[] {
    const chatIds: number[] = [];
    for (const [chatId, project] of this.lastUsedPerChat.entries()) {
      if (project === projectName) {
        chatIds.push(chatId);
      }
    }
    return chatIds;
  }

  /**
   * Get all chat IDs and their associated projects.
   */
  getAllChatProjects(): Map<number, string> {
    return new Map(this.lastUsedPerChat);
  }

  /**
   * Kill a session (clear session_id and state).
   */
  async killSession(projectName: string): Promise<void> {
    const session = this.sessions.get(projectName);
    if (session) {
      await session.kill();
    }
  }

  /**
   * Get status for a specific project.
   */
  getSessionStatus(projectName: string): SessionStatus | null {
    const session = this.sessions.get(projectName);
    if (!session) return null;

    return session.getStatus();
  }

  /**
   * Get status for all sessions.
   */
  getAllSessionStatus(): SessionStatus[] {
    return Array.from(this.sessions.values()).map((s) => s.getStatus());
  }

  /**
   * Get current session (legacy compatibility).
   * Returns the current project's session.
   */
  getCurrentSession(): ClaudeSession {
    const projectSession = this.sessions.get(this.currentProject);
    if (projectSession) {
      return projectSession.session;
    }

    // Create default session synchronously for legacy compatibility
    // This is a fallback - modern code should use getOrCreateSession()
    const claudeSession = new ClaudeSession();
    return claudeSession;
  }
}

// Global singleton
export const sessionManager = new SessionManager();

/**
 * Legacy compatibility export.
 * This allows old code using `import { session }` to continue working.
 * New code should use sessionManager directly.
 */
export const session = sessionManager.getCurrentSession();
