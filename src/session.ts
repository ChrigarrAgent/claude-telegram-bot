/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions using the Agent SDK V1.
 * V1 supports full options (cwd, mcpServers, settingSources, etc.)
 */

import {
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import type { Context } from "grammy";
import {
  ALLOWED_PATHS,
  CLAUDE_CLI_PATH,
  MCP_SERVERS,
  QUERY_TIMEOUT_MS,
  SYSTEM_PROMPT,
  SESSION_FILE,
  STREAMING_THROTTLE_MS,
  TEMP_PATHS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
  WORKING_DIR,
  getWorkingDir,
} from "./config";
import { formatToolStatus } from "./formatting";
import { checkPendingAskUserRequests } from "./handlers/streaming";
import {
  isAskUserQuestionInput,
  displayAskUserQuestions,
} from "./handlers/ask-user-question";
import {
  requestSafetyConfirmation,
  waitForSafetyDecision,
} from "./handlers/safety-confirmation";
import { checkCommandSafety, isPathAllowed } from "./security";
import { getProjectAlias } from "./project-aliases";
import { sessionManager } from "./session-manager";
import type {
  AskUserQuestionInput,
  SavedSession,
  SessionHistory,
  StatusCallback,
  TokenUsage,
} from "./types";

/**
 * Determine thinking token budget based on message keywords.
 * Default: thinking is ON (10000 tokens)
 * Use /fast or /f to disable thinking (returns undefined to omit maxThinkingTokens)
 * Use deep thinking keywords for extended thinking (50000 tokens)
 */
function getThinkingLevel(message: string): number | undefined {
  const msgLower = message.toLowerCase();

  // Check for fast mode (disable thinking) - use word boundary regex to avoid matching /fix, /format, etc.
  if (/\/fast\b/i.test(message) || /\/f\b/i.test(message)) {
    return undefined; // Don't pass maxThinkingTokens → SDK default (thinking OFF)
  }

  // Check deep thinking triggers (more thinking tokens)
  if (THINKING_DEEP_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 50000;
  }

  // Default: normal thinking ON
  return 10000;
}

/**
 * Extract text content from SDK message.
 */
function getTextFromMessage(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;

  const textParts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("") : null;
}

/**
 * Manages Claude Code sessions using the Agent SDK V1.
 */
// Maximum number of sessions to keep per project
const SESSIONS_PER_PROJECT = 3;
const DEFAULT_PROJECT_NAME = "default";

export class ClaudeSession {
  sessionId: string | null = null;
  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastMessage: string | null = null;
  conversationTitle: string | null = null;

  private abortController: AbortController | null = null;
  private isQueryRunning = false;
  private stopRequested = false;
  private _isProcessing = false;
  private _wasInterruptedByNewMessage = false;
  private _resumeAttempted = false; // Track if we tried to resume from disk
  private typingInterval: Timer | null = null; // Typing indicator control
  private currentCtx: Context | null = null; // Current context for typing
  private typingIntervalId = 0; // Unique ID for each typing interval

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this.isQueryRunning || this._isProcessing;
  }

  /**
   * Check if the last stop was triggered by a new message interrupt (! prefix).
   * Resets the flag when called. Also clears stopRequested so new messages can proceed.
   */
  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) {
      // Clear stopRequested so the new message can proceed
      this.stopRequested = false;
    }
    return was;
  }

  /**
   * Mark that this stop is from a new message interrupt.
   */
  markInterrupt(): void {
    this._wasInterruptedByNewMessage = true;
  }

  /**
   * Clear the stopRequested flag (used after interrupt to allow new message to proceed).
   */
  clearStopRequested(): void {
    this.stopRequested = false;
  }

  /**
   * Mark processing as started.
   * Returns a cleanup function to call when done.
   */
  startProcessing(): () => void {
    this._isProcessing = true;
    return () => {
      this._isProcessing = false;
    };
  }

  /**
   * Stop the currently running query or mark for cancellation.
   * Returns: "stopped" if query was aborted, "pending" if processing will be cancelled, false if nothing running
   */
  async stop(): Promise<"stopped" | "pending" | false> {
    // Always stop typing indicator when stopping
    this.stopTyping();

    // If a query is actively running, abort it
    if (this.isQueryRunning && this.abortController) {
      this.stopRequested = true;
      this.abortController.abort();
      console.log("Stop requested - aborting current query");
      return "stopped";
    }

    // If processing but query not started yet
    if (this._isProcessing) {
      this.stopRequested = true;
      console.log("Stop requested - will cancel before query starts");
      return "pending";
    }

    return false;
  }

  /**
   * Send a message to Claude with streaming updates via callback.
   *
   * @param ctx - grammY context for ask_user button display
   */
  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context,
    workingDir?: string
  ): Promise<string> {
    // Set chat context for ask_user MCP tool
    if (chatId) {
      process.env.TELEGRAM_CHAT_ID = String(chatId);
    }

    // Store context for typing indicator
    this.currentCtx = ctx || null;

    const isNewSession = !this.isActive;
    const thinkingTokens = getThinkingLevel(message);
    const thinkingLabel =
      thinkingTokens === undefined
        ? "off"
        : { 10000: "normal", 50000: "deep" }[thinkingTokens] || String(thinkingTokens);

    // Strip /fast or /f from message before sending to Claude
    let messageToSend = message.replace(/\/fast\b/gi, "").replace(/\/f\b/gi, "").trim();

    // Inject current date/time at session start so Claude doesn't need to call a tool for it
    if (isNewSession) {
      const now = new Date();
      const datePrefix = `[Current date/time: ${now.toLocaleDateString(
        "en-US",
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        }
      )}]\n\n`;
      messageToSend = datePrefix + messageToSend;
    }

    // Build SDK V1 options - supports all features
    const options: Options = {
      model: "claude-sonnet-4-5",
      cwd: workingDir || getWorkingDir(),
      settingSources: ["user", "project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: MCP_SERVERS,
      // Only include maxThinkingTokens when defined (undefined = SDK default = thinking OFF)
      ...(thinkingTokens !== undefined && { maxThinkingTokens: thinkingTokens }),
      additionalDirectories: ALLOWED_PATHS,
      resume: this.sessionId || undefined,
    };

    // Add Claude Code executable path - use config or env
    const claudePath = process.env.CLAUDE_CODE_PATH || CLAUDE_CLI_PATH;
    if (claudePath) {
      options.pathToClaudeCodeExecutable = claudePath;
      console.log(`DEBUG: Claude CLI path: ${claudePath}`);
    }

    if (this.sessionId && !isNewSession) {
      console.log(
        `RESUMING session ${this.sessionId.slice(
          0,
          8
        )}... (thinking=${thinkingLabel})`
      );
    } else {
      console.log(`STARTING new Claude session (thinking=${thinkingLabel})`);
      this.sessionId = null;
    }

    // DEBUG: Log the working directory being passed to Claude
    console.log(`[SESSION] cwd being passed to SDK: ${options.cwd}`);

    // Check if stop was requested during processing phase
    if (this.stopRequested) {
      console.log(
        "Query cancelled before starting (stop was requested during processing)"
      );
      this.stopRequested = false;
      throw new Error("Query cancelled");
    }

    // Create abort controller for cancellation
    this.abortController = new AbortController();
    this.isQueryRunning = true;
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

    // Start typing indicator now that query is actually running
    this.startTyping();

    // Response tracking
    const responseParts: string[] = [];
    let currentSegmentId = 0;
    let currentSegmentText = "";
    let lastTextUpdate = 0;
    let queryCompleted = false;
    let askUserTriggered = false;

    // Activity timeout - abort if no events received for too long
    let activityTimeout: Timer | null = null;
    const resetActivityTimeout = () => {
      if (activityTimeout) clearTimeout(activityTimeout);
      activityTimeout = setTimeout(() => {
        console.warn(`Query timeout - no activity for ${QUERY_TIMEOUT_MS / 1000}s`);
        this.stopRequested = true;
        this.abortController?.abort();
      }, QUERY_TIMEOUT_MS);
    };
    const clearActivityTimeout = () => {
      if (activityTimeout) {
        clearTimeout(activityTimeout);
        activityTimeout = null;
      }
    };

    try {
      // Use V1 query() API - supports all options including cwd, mcpServers, etc.
      console.log("DEBUG: Creating query instance...");
      console.log("DEBUG: Options:", JSON.stringify({
        model: options.model,
        cwd: options.cwd,
        resume: options.resume,
        maxThinkingTokens: options.maxThinkingTokens,
      }));

      let queryInstance;
      try {
        queryInstance = query({
          prompt: messageToSend,
          options: {
            ...options,
            abortController: this.abortController,
          },
        });
        console.log("DEBUG: Query instance created successfully");
      } catch (queryError) {
        console.error("DEBUG: Error creating query instance:", queryError);
        throw queryError;
      }

      // Start activity timeout
      resetActivityTimeout();

      console.log("DEBUG: Starting event loop...");
      let eventCount = 0;

      // Process streaming response
      for await (const event of queryInstance) {
        eventCount++;
        console.log(`DEBUG: Event ${eventCount}: type=${event.type}`);

        // Reset timeout on any activity
        resetActivityTimeout();

        // Check for abort
        if (this.stopRequested) {
          console.log("Query aborted by user");
          break;
        }

        // Capture session_id from first message
        if (!this.sessionId && event.session_id) {
          this.sessionId = event.session_id;
          this._resumeAttempted = false; // Session validated successfully
          console.log(`GOT session_id: ${this.sessionId!.slice(0, 8)}...`);
          this.saveSession(workingDir);
        } else if (this.sessionId && this._resumeAttempted) {
          // Resume was successful - got events with existing session_id
          this._resumeAttempted = false;
        }

        // Handle different message types
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            // Thinking blocks
            if (block.type === "thinking") {
              const thinkingText = block.thinking;
              if (thinkingText) {
                console.log(`THINKING BLOCK: ${thinkingText.slice(0, 100)}...`);
                await statusCallback("thinking", thinkingText);
              }
            }

            // Tool use blocks
            if (block.type === "tool_use") {
              const toolName = block.name;
              const toolInput = block.input as Record<string, unknown>;

              // Safety check for Bash commands
              if (toolName === "Bash" && ctx && chatId) {
                const command = String(toolInput.command || "");
                const [isSafe, reason] = checkCommandSafety(command);
                if (!isSafe) {
                  console.warn(`UNSAFE COMMAND: ${reason} - requesting confirmation`);
                  await statusCallback("tool", `⚠️ Requesting confirmation for: ${reason}`);

                  // Request confirmation via Telegram buttons
                  const requestId = await requestSafetyConfirmation(
                    ctx,
                    chatId,
                    "command",
                    reason,
                    command
                  );

                  // Wait for user decision
                  const allowed = await waitForSafetyDecision(requestId);

                  if (!allowed) {
                    console.warn(`User denied: ${reason}`);
                    await statusCallback("tool", `❌ Command blocked by user: ${reason}`);
                    throw new Error(`Command blocked by user: ${reason}`);
                  }

                  console.log(`User allowed: ${command}`);
                  await statusCallback("tool", `✅ Command allowed by user`);
                }
              }

              // Safety check for file operations
              if (["Read", "Write", "Edit"].includes(toolName) && ctx && chatId) {
                const filePath = String(toolInput.file_path || "");
                if (filePath) {
                  // Allow reads from temp paths and .claude directories
                  const isTmpRead =
                    toolName === "Read" &&
                    (TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
                      filePath.includes("/.claude/"));

                  if (!isTmpRead && !isPathAllowed(filePath)) {
                    console.warn(
                      `UNSAFE FILE OPERATION: Access outside allowed paths: ${filePath} - requesting confirmation`
                    );
                    await statusCallback("tool", `🔒 Requesting confirmation for file access`);

                    // Request confirmation via Telegram buttons
                    const requestId = await requestSafetyConfirmation(
                      ctx,
                      chatId,
                      "file_operation",
                      `${toolName} file outside allowed paths`,
                      filePath
                    );

                    // Wait for user decision
                    const allowed = await waitForSafetyDecision(requestId);

                    if (!allowed) {
                      console.warn(`User denied file access: ${filePath}`);
                      await statusCallback("tool", `❌ File access blocked by user: ${filePath}`);
                      throw new Error(`File access blocked by user: ${filePath}`);
                    }

                    console.log(`User allowed file access: ${filePath}`);
                    await statusCallback("tool", `✅ File access allowed by user`);
                  }
                }
              }

              // Segment ends when tool starts
              if (currentSegmentText) {
                await statusCallback(
                  "segment_end",
                  currentSegmentText,
                  currentSegmentId
                );
                currentSegmentId++;
                currentSegmentText = "";
              }

              // Check for AskUserQuestion format (used by GSD and similar plugins)
              // This works regardless of tool name - we detect by input structure
              if (isAskUserQuestionInput(toolInput) && ctx && chatId) {
                const effectiveCwd = workingDir || getWorkingDir();
                const projectName = effectiveCwd.split("/").pop() || "default";
                const projectAlias = getProjectAlias(effectiveCwd);

                const displayed = await displayAskUserQuestions(
                  ctx,
                  toolInput as AskUserQuestionInput,
                  projectName,
                  projectAlias,
                  chatId
                );

                if (displayed) {
                  askUserTriggered = true;
                  // Don't show tool status for AskUserQuestion - buttons are displayed
                  console.log(`AskUserQuestion displayed for ${projectName}`);
                }
              }

              // Format and show tool status
              const toolDisplay = formatToolStatus(toolName, toolInput);
              this.currentTool = toolDisplay;
              this.lastTool = toolDisplay;
              console.log(`Tool: ${toolDisplay}`);

              // Don't show tool status for ask_user or AskUserQuestion - the buttons are self-explanatory
              if (!toolName.startsWith("mcp__ask-user") && !askUserTriggered) {
                await statusCallback("tool", toolDisplay);
              }

              // Check for pending ask_user requests after ask-user MCP tool
              if (toolName.startsWith("mcp__ask-user") && ctx && chatId) {
                // Small delay to let MCP server write the file
                await new Promise((resolve) => setTimeout(resolve, 200));

                // Retry a few times in case of timing issues
                for (let attempt = 0; attempt < 3; attempt++) {
                  const buttonsSent = await checkPendingAskUserRequests(
                    ctx,
                    chatId
                  );
                  if (buttonsSent) {
                    askUserTriggered = true;
                    break;
                  }
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
              }
            }

            // Text content
            if (block.type === "text") {
              responseParts.push(block.text);
              currentSegmentText += block.text;

              // Stream text updates (throttled)
              const now = Date.now();
              if (
                now - lastTextUpdate > STREAMING_THROTTLE_MS &&
                currentSegmentText.length > 20
              ) {
                await statusCallback(
                  "text",
                  currentSegmentText,
                  currentSegmentId
                );
                lastTextUpdate = now;
              }
            }
          }

          // Break out of event loop if ask_user was triggered
          if (askUserTriggered) {
            break;
          }
        }

        // Result message
        if (event.type === "result") {
          console.log("Response complete");
          queryCompleted = true;

          // Capture usage if available
          if ("usage" in event && event.usage) {
            this.lastUsage = event.usage as TokenUsage;
            const u = this.lastUsage;
            console.log(
              `Usage: in=${u.input_tokens} out=${u.output_tokens} cache_read=${
                u.cache_read_input_tokens || 0
              } cache_create=${u.cache_creation_input_tokens || 0}`
            );
          }
        }
      }

      console.log(`DEBUG: Event loop finished. Total events: ${eventCount}, completed: ${queryCompleted}`);

      // V1 query completes automatically when the generator ends
    } catch (error) {
      const errorStr = String(error).toLowerCase();
      const isCleanupError =
        errorStr.includes("cancel") || errorStr.includes("abort");

      // Check if this was a resume failure (session not found, invalid, expired)
      const isResumeFailure =
        this._resumeAttempted &&
        (errorStr.includes("session") ||
          errorStr.includes("not found") ||
          errorStr.includes("invalid") ||
          errorStr.includes("expired"));

      if (isResumeFailure) {
        console.warn(`Resume failed, will start fresh session: ${error}`);
        // Clear the failed session so next attempt starts fresh
        this.sessionId = null;
        this._resumeAttempted = false;
        this.lastError = "Resume failed - starting fresh session";
        this.lastErrorTime = new Date();
        throw new Error("Session resume failed - please retry");
      }

      if (
        isCleanupError &&
        (queryCompleted || askUserTriggered || this.stopRequested)
      ) {
        console.warn(`Suppressed post-completion error: ${error}`);
      } else {
        console.error(`Error in query: ${error}`);
        this.lastError = String(error).slice(0, 100);
        this.lastErrorTime = new Date();
        throw error;
      }
    } finally {
      this.stopTyping(); // Always stop typing when query ends
      clearActivityTimeout();
      this.isQueryRunning = false;
      this.abortController = null;
      this.queryStarted = null;
      this.currentTool = null;
      this.currentCtx = null; // Clear context reference
    }

    this.lastActivity = new Date();
    this.lastError = null;
    this.lastErrorTime = null;

    // If ask_user was triggered, return early - user will respond via button
    if (askUserTriggered) {
      await statusCallback("done", "");
      return "[Waiting for user selection]";
    }

    // Emit final segment
    if (currentSegmentText) {
      await statusCallback("segment_end", currentSegmentText, currentSegmentId);
    }

    await statusCallback("done", "");

    return responseParts.join("") || "No response from Claude.";
  }

  /**
   * Start typing indicator.
   */
  private startTyping(): void {
    // Stop any existing typing first
    this.stopTyping();

    if (this.currentCtx && !this.typingInterval) {
      // Generate unique ID for this interval
      const intervalId = ++this.typingIntervalId;
      console.log(`[TYPING] Starting typing indicator #${intervalId} (session: ${this.sessionId?.slice(0, 8)})`);

      this.typingInterval = setInterval(async () => {
        // Check if this is still the active interval (prevents stale callbacks)
        if (intervalId !== this.typingIntervalId || !this.currentCtx) {
          console.log(`[TYPING] Interval #${intervalId} fired but is stale (current: ${this.typingIntervalId}), skipping`);
          return;
        }
        console.log(`[TYPING] Sending typing action (interval #${intervalId})`);
        try {
          await this.currentCtx.replyWithChatAction("typing");
        } catch (error) {
          console.debug("Typing indicator failed:", error);
        }
      }, 4000);
      // Send immediately
      console.log(`[TYPING] Sending typing action (immediate #${intervalId})`);
      this.currentCtx.replyWithChatAction("typing").catch(() => {});
    }
  }

  /**
   * Stop typing indicator.
   */
  private stopTyping(): void {
    console.log(`[TYPING] Stopping typing indicator #${this.typingIntervalId} (session: ${this.sessionId?.slice(0, 8)}, isQueryRunning: ${this.isQueryRunning})`);
    // Increment ID to invalidate any queued callbacks from old interval
    this.typingIntervalId++;
    if (this.typingInterval) {
      console.log(`[TYPING] Clearing interval, new ID: ${this.typingIntervalId}`);
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  /**
   * Kill the current session (clear session_id).
   */
  async kill(): Promise<void> {
    this.stopTyping(); // Ensure typing is stopped
    this.sessionId = null;
    this.lastActivity = null;
    this.conversationTitle = null;
    this.currentCtx = null;
    console.log("Session cleared");
  }

  /**
   * Trim session history to keep only SESSIONS_PER_PROJECT per project.
   * Groups sessions by project and keeps the most recent sessions for each.
   */
  private trimSessionHistory(history: SessionHistory): void {
    const groupedByProject = new Map<string, SavedSession[]>();

    // Group sessions by project
    for (const session of history.sessions) {
      const projName = session.project || DEFAULT_PROJECT_NAME;
      if (!groupedByProject.has(projName)) {
        groupedByProject.set(projName, []);
      }
      groupedByProject.get(projName)!.push(session);
    }

    // Trim each project to SESSIONS_PER_PROJECT
    const trimmedSessions: SavedSession[] = [];
    for (const [, sessions] of groupedByProject.entries()) {
      // Keep only the most recent SESSIONS_PER_PROJECT for this project
      trimmedSessions.push(...sessions.slice(0, SESSIONS_PER_PROJECT));
    }

    history.sessions = trimmedSessions;
  }

  /**
   * Save session to disk for resume after restart.
   * Saves to multi-session history format.
   */
  saveSession(overrideWorkingDir?: string): void {
    if (!this.sessionId) return;

    try {
      // Load existing session history
      const history = this.loadSessionHistory();

      // Create new session entry with project name
      const workDir = overrideWorkingDir || getWorkingDir();
      const projectName = workDir.split("/").pop() || DEFAULT_PROJECT_NAME;
      const newSession: SavedSession = {
        session_id: this.sessionId,
        saved_at: new Date().toISOString(),
        working_dir: workDir,
        title: this.conversationTitle || `${projectName} session`,
        project: projectName,
      };

      // Remove any existing entry with same session_id (update in place)
      const existingIndex = history.sessions.findIndex(
        (s) => s.session_id === this.sessionId
      );
      if (existingIndex !== -1) {
        history.sessions[existingIndex] = newSession;
      } else {
        // Add new session at the beginning
        history.sessions.unshift(newSession);
      }

      // Keep only the last SESSIONS_PER_PROJECT per project
      this.trimSessionHistory(history);

      // Save
      Bun.write(SESSION_FILE, JSON.stringify(history, null, 2));
      console.log(`Session saved to ${SESSION_FILE}`);
    } catch (error) {
      console.warn(`Failed to save session: ${error}`);
    }
  }

  /**
   * Load session history from disk.
   */
  private loadSessionHistory(): SessionHistory {
    try {
      const file = Bun.file(SESSION_FILE);
      if (!file.size) {
        return { sessions: [] };
      }

      const text = readFileSync(SESSION_FILE, "utf-8");
      return JSON.parse(text) as SessionHistory;
    } catch {
      return { sessions: [] };
    }
  }

  /**
   * Get list of saved sessions for display.
   * @param filterByProject - Optional project name to filter by (if undefined, returns all sessions)
   */
  getSessionList(filterByProject?: string): SavedSession[] {
    const history = this.loadSessionHistory();

    // If filter specified, return only sessions for that project
    if (filterByProject !== undefined) {
      return history.sessions.filter(
        (s) => s.project === filterByProject || s.working_dir === filterByProject
      );
    }

    // Return ALL sessions (no filtering)
    return history.sessions;
  }

  /**
   * Resume a specific session by ID.
   */
  resumeSession(sessionId: string): [success: boolean, message: string] {
    const history = this.loadSessionHistory();
    const sessionData = history.sessions.find((s) => s.session_id === sessionId);

    if (!sessionData) {
      return [false, "Session not found"];
    }

    // NOTE: We don't check working_dir anymore because:
    // 1. WORKING_DIR is a stale constant from startup time
    // 2. Multi-project sessions should be resumable regardless of current dir
    // 3. The SDK's resume parameter handles directory mismatches gracefully

    this.sessionId = sessionData.session_id;
    this.conversationTitle = sessionData.title;
    this.lastActivity = new Date();

    console.log(
      `Resumed session ${sessionData.session_id.slice(0, 8)}... - "${sessionData.title}"`
    );

    return [
      true,
      `Resumed session: "${sessionData.title}"`,
    ];
  }

  /**
   * Resume the last persisted session (legacy method, now resumes most recent).
   */
  resumeLast(): [success: boolean, message: string] {
    const sessions = this.getSessionList();
    if (sessions.length === 0) {
      return [false, "No saved sessions"];
    }

    return this.resumeSession(sessions[0]!.session_id);
  }
}

// Global session instance
export const session = new ClaudeSession();
