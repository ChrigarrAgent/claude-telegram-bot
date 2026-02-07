/**
 * Multi-project session manager for Claude Telegram Bot.
 *
 * Manages multiple concurrent Claude Code sessions across different projects,
 * with race condition protection and per-chat project tracking.
 */

import type { ProjectSession } from "./project-session";
import type { PendingAskUserQuestion } from "./types";
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
 * Pending group link verification state.
 */
export interface PendingGroupLink {
  groupId: number;
  groupTitle: string;
  projectName: string;
  projectPath: string;
  verificationCode: string;
  createdAt: Date;
  requestedBy: number;
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
  private pendingQuestionsPerProject = new Map<string, PendingAskUserQuestion>();
  private pendingGroupLinks = new Map<number, PendingGroupLink>(); // groupId → pending link
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
    // Skip auto-resume in test environment to ensure clean state
    if (process.env.NODE_ENV !== "test") {
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
   * Set pending group link verification state.
   */
  setPendingGroupLink(data: PendingGroupLink): void {
    this.pendingGroupLinks.set(data.groupId, data);
  }

  /**
   * Get pending group link verification state.
   */
  getPendingGroupLink(groupId: number): PendingGroupLink | null {
    return this.pendingGroupLinks.get(groupId) || null;
  }

  /**
   * Clear pending group link verification state.
   */
  clearPendingGroupLink(groupId: number): void {
    this.pendingGroupLinks.delete(groupId);
  }

  /**
   * Clean up expired pending group links (older than 10 minutes).
   */
  cleanupExpiredGroupLinks(): void {
    const now = new Date();
    const maxAge = 10 * 60 * 1000; // 10 minutes

    for (const [groupId, link] of Array.from(this.pendingGroupLinks)) {
      const age = now.getTime() - link.createdAt.getTime();
      if (age > maxAge) {
        this.pendingGroupLinks.delete(groupId);
      }
    }
  }

  /**
   * Set pending AskUserQuestion for a project.
   * Stored per-project to support concurrent sessions.
   */
  setPendingQuestion(projectName: string, question: PendingAskUserQuestion): void {
    this.pendingQuestionsPerProject.set(projectName, question);
  }

  /**
   * Get pending AskUserQuestion for a chat.
   * Looks up by project name if provided, otherwise by chat's last-used project.
   */
  getPendingQuestion(chatId: number, projectName?: string): PendingAskUserQuestion | null {
    // If project name provided, look up directly
    if (projectName) {
      const pending = this.pendingQuestionsPerProject.get(projectName);
      if (pending && pending.chatId === chatId) {
        // Check expiration
        if (new Date() > pending.expiresAt) {
          this.pendingQuestionsPerProject.delete(projectName);
          return null;
        }
        return pending;
      }
      return null;
    }

    // Otherwise look up by chat's last-used project
    const lastUsedProject = this.lastUsedPerChat.get(chatId);
    if (lastUsedProject) {
      const pending = this.pendingQuestionsPerProject.get(lastUsedProject);
      if (pending && pending.chatId === chatId) {
        // Check expiration
        if (new Date() > pending.expiresAt) {
          this.pendingQuestionsPerProject.delete(lastUsedProject);
          return null;
        }
        return pending;
      }
    }

    // Fallback: search all pending questions for this chat
    for (const [projName, pending] of this.pendingQuestionsPerProject) {
      if (pending.chatId === chatId) {
        // Check expiration
        if (new Date() > pending.expiresAt) {
          this.pendingQuestionsPerProject.delete(projName);
          continue;
        }
        return pending;
      }
    }

    return null;
  }

  /**
   * Clear pending AskUserQuestion for a project.
   */
  clearPendingQuestion(projectName: string): void {
    this.pendingQuestionsPerProject.delete(projectName);
  }

  /**
   * Toggle selection for multi-select questions.
   * Returns the updated set of selected indices.
   */
  updateQuestionSelection(
    projectName: string,
    questionIndex: number,
    optionIndex: number
  ): Set<number> | null {
    const pending = this.pendingQuestionsPerProject.get(projectName);
    if (!pending) return null;

    // Get or create the selection set for this question
    if (!pending.selectedIndices.has(questionIndex)) {
      pending.selectedIndices.set(questionIndex, new Set());
    }

    const selections = pending.selectedIndices.get(questionIndex)!;

    // Toggle selection
    if (selections.has(optionIndex)) {
      selections.delete(optionIndex);
    } else {
      selections.add(optionIndex);
    }

    return selections;
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
  sessionManager["pendingQuestionsPerProject"].clear();
  sessionManager["currentProject"] = "default";
}
