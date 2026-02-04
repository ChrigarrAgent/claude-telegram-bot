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
 * Pending clone state for a chat (stored separately from sessions to avoid cross-chat leakage).
 */
export interface PendingClone {
  projectName: string;
  projectPath: string;
  chatId: number;
}

/**
 * SessionManager coordinates multiple ProjectSession instances.
 */
class SessionManager {
  private sessions = new Map<string, ProjectSession>();
  private creationLocks = new Map<string, Promise<ProjectSession>>();
  private lastUsedPerChat = new Map<number, string>();
  private chatsByProject = new Map<string, Set<number>>(); // Reverse index for O(1) lookup
  private pendingClonePerChat = new Map<number, PendingClone>();
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
   * Automatically resumes persisted session if one exists for this project.
   */
  private async _createSession(projectName: string): Promise<ProjectSession> {
    const { ProjectSession: PS } = await import("./project-session");
    const workingDir = resolveProjectPath(projectName);
    const claudeSession = new ClaudeSession();

    // CRITICAL: Auto-resume persisted session for this project
    // This ensures continuity when bot restarts or sessions are recreated
    const savedSessions = claudeSession.getSessionList(projectName);
    if (savedSessions.length > 0) {
      const mostRecent = savedSessions[0]!;
      // Only resume if it's for the same working directory
      if (mostRecent.working_dir === workingDir || mostRecent.project === projectName) {
        claudeSession.sessionId = mostRecent.session_id;
        claudeSession.conversationTitle = mostRecent.title;
        claudeSession["_resumeAttempted"] = true; // Track for validation on first message
        console.log(`Auto-resumed session for ${projectName}: ${mostRecent.session_id.slice(0, 8)}...`);
      }
    }

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
   * Maintains reverse index for O(1) lookup of chats by project.
   */
  setLastUsed(chatId: number, projectName: string): void {
    // Remove from old project's chat set (if different)
    const oldProject = this.lastUsedPerChat.get(chatId);
    if (oldProject && oldProject !== projectName) {
      this.chatsByProject.get(oldProject)?.delete(chatId);
    }

    // Add to new project's chat set
    if (!this.chatsByProject.has(projectName)) {
      this.chatsByProject.set(projectName, new Set());
    }
    this.chatsByProject.get(projectName)!.add(chatId);

    // Update primary mapping
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
   * Uses reverse index for O(1) lookup.
   */
  getChatIdsForProject(projectName: string): number[] {
    const chatSet = this.chatsByProject.get(projectName);
    return chatSet ? Array.from(chatSet) : [];
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
   * Set pending clone state for a chat.
   * Stored per-chat to avoid cross-chat leakage.
   */
  setPendingClone(chatId: number, data: PendingClone): void {
    this.pendingClonePerChat.set(chatId, data);
  }

  /**
   * Get pending clone state for a chat.
   */
  getPendingClone(chatId: number): PendingClone | null {
    return this.pendingClonePerChat.get(chatId) || null;
  }

  /**
   * Clear pending clone state for a chat.
   */
  clearPendingClone(chatId: number): void {
    this.pendingClonePerChat.delete(chatId);
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
 * Reset session manager state (for testing only).
 */
export function resetSessionManager(): void {
  sessionManager["sessions"].clear();
  sessionManager["creationLocks"].clear();
  sessionManager["lastUsedPerChat"].clear();
  sessionManager["chatsByProject"].clear();
  sessionManager["pendingClonePerChat"].clear();
  sessionManager["currentProject"] = "default";
}

/**
 * Legacy compatibility export.
 * This allows old code using `import { session }` to continue working.
 * New code should use sessionManager directly.
 */
export const session = sessionManager.getCurrentSession();
