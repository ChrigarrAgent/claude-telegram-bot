/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { TELEGRAM_TOKEN, WORKING_DIR, ALLOWED_USERS, RESTART_FILE, ACTIVE_SESSIONS_FILE, HEARTBEAT_FILE } from "./config";
import type { ActiveSessionsData, HeartbeatData, ActiveSessionEntry } from "./types";
import { sessionManager } from "./session-manager";
import { unlinkSync, readFileSync, existsSync } from "fs";
import { acquireLock, releaseLock, setupLockCleanup } from "./process-lock";
import {
  handleStart,
  handleNew,
  handleStop,
  handleStatus,
  handleResume,
  handleRestart,
  handleRetry,
  handleHandoff,
  handleTmux,
  handleProject,
  handleProjects,
  handleUsage,
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleCallback,
  createBotApiStatusCallback,
} from "./handlers";
import { scanAndGenerateAliases } from "./project-aliases";
import type { ProjectSession } from "./project-session";
import { processMonitor } from "./process-monitor";
import type { LongRunStatus } from "./process-monitor";

// Create bot instance
const bot = new Bot(TELEGRAM_TOKEN);

/**
 * Automatically continue a session after restart by sending a "continue" message to Claude.
 * Streams the response back to the user via Telegram.
 */
async function autoContinueSession(
  projectSession: ProjectSession,
  chatId: number,
  isCrash: boolean
): Promise<void> {
  try {
    console.log(`Auto-continuing session for chat ${chatId}...`);

    // Get project alias for prefixing messages
    const { getProjectAlias } = await import("./project-aliases");
    const projectAlias = getProjectAlias(projectSession.workingDir);

    // Use consolidated status callback (same pattern as normal message flow)
    const statusCallback = createBotApiStatusCallback(bot.api, chatId, projectAlias);

    // Send the continue message to Claude
    // IMPORTANT: Explicitly tell Claude NOT to restart the bot again.
    // Without this, Claude may re-execute a restart as part of "continuing",
    // spawning a rogue process outside PM2.
    const continuePrompt = isCrash
      ? "The bot just restarted after a crash. Please summarize what you were working on before the crash and what the current status is. Do NOT restart the bot or run any commands — just provide a summary to the user."
      : "The bot just restarted. Please summarize what you were working on and what the current status is. Do NOT restart the bot or run any commands — just provide a summary to the user.";

    await projectSession.sendMessage(
      continuePrompt,
      "system",
      0,
      statusCallback,
      chatId,
      undefined // no ctx available during startup
    );

    console.log(`Auto-continue completed for chat ${chatId}`);
  } catch (error) {
    console.error(`Auto-continue failed for chat ${chatId}:`, error);
    // Send error message to user
    try {
      await bot.api.sendMessage(
        chatId,
        `⚠️ Failed to auto-continue: ${String(error).slice(0, 200)}`
      );
    } catch {
      // Ignore if we can't even send error message
    }
  }
}

/**
 * Handle start of a long-running background process.
 * Sends a simple notification to the user (no LLM action needed).
 */
async function handleProcessStart(status: LongRunStatus): Promise<void> {
  try {
    const { loadProjectAliases, getProjectAlias } = await import("./project-aliases");
    const aliases = loadProjectAliases();

    // Resolve CWD to project alias
    let matchedAlias: string | null = null;
    for (const [projectPath, alias] of Object.entries(aliases)) {
      if (status.cwd === projectPath) {
        matchedAlias = alias;
        break;
      }
    }
    if (!matchedAlias) {
      for (const [projectPath, alias] of Object.entries(aliases)) {
        if (status.cwd.startsWith(projectPath + "/")) {
          matchedAlias = alias;
          break;
        }
      }
    }

    if (!matchedAlias) return;

    const chatIds = sessionManager.getChatIdsForProject(matchedAlias);
    if (chatIds.length === 0) return;

    const projectSession = sessionManager.getSession(matchedAlias);
    const projectAlias = projectSession
      ? getProjectAlias(projectSession.workingDir)
      : matchedAlias;

    // Clean up command for display (remove newlines from long-run format)
    const command = status.command.replace(/\n/g, " ").trim();

    for (const chatId of chatIds) {
      try {
        await bot.api.sendMessage(
          chatId,
          `<b>${projectAlias}:</b> ⏳ Long-running task started\n` +
            `<code>${command}</code>\n\n` +
            `You will be notified when it completes.`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        console.error(`ProcessMonitor: Failed to notify chat ${chatId} about start:`, e);
      }
    }

    console.log(`ProcessMonitor: Notified start of ${status.id} for project ${matchedAlias}`);
  } catch (error) {
    console.error("ProcessMonitor: Failed to handle process start:", error);
  }
}

/**
 * Handle completion of a long-running background process.
 * Resolves the process CWD to a project, notifies the user, and sends
 * a synthetic message to Claude to read the output log.
 */
async function handleProcessCompletion(status: LongRunStatus): Promise<void> {
  try {
    const { loadProjectAliases } = await import("./project-aliases");
    const { getProjectAlias } = await import("./project-aliases");

    const aliases = loadProjectAliases();

    // Resolve CWD to project alias: exact match, then prefix match
    let matchedAlias: string | null = null;
    for (const [projectPath, alias] of Object.entries(aliases)) {
      if (status.cwd === projectPath) {
        matchedAlias = alias;
        break;
      }
    }
    if (!matchedAlias) {
      for (const [projectPath, alias] of Object.entries(aliases)) {
        if (status.cwd.startsWith(projectPath + "/")) {
          matchedAlias = alias;
          break;
        }
      }
    }

    if (!matchedAlias) {
      console.warn(
        `ProcessMonitor: No project found for CWD ${status.cwd}, skipping`
      );
      return;
    }

    const chatIds = sessionManager.getChatIdsForProject(matchedAlias);
    if (chatIds.length === 0) {
      console.warn(
        `ProcessMonitor: No chats found for project ${matchedAlias}, skipping`
      );
      return;
    }

    const projectSession = sessionManager.getSession(matchedAlias);
    if (!projectSession) {
      console.warn(
        `ProcessMonitor: No session found for project ${matchedAlias}, skipping`
      );
      return;
    }

    // If session is busy, retry after 10 seconds
    if (projectSession.isRunning()) {
      console.log(
        `ProcessMonitor: Session ${matchedAlias} is busy, retrying in 10s`
      );
      setTimeout(() => handleProcessCompletion(status), 10_000);
      return;
    }

    const exitLabel = status.exit_code === 0 ? "successfully" : `with exit code ${status.exit_code}`;
    const projectAlias = getProjectAlias(projectSession.workingDir);

    // Notify all chats for this project
    for (const chatId of chatIds) {
      try {
        await bot.api.sendMessage(
          chatId,
          `<b>${projectAlias}:</b> Background process completed ${exitLabel}.\n` +
            `<code>${status.command.trim()}</code>`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        console.error(
          `ProcessMonitor: Failed to notify chat ${chatId}:`,
          e
        );
      }
    }

    // Send synthetic message to Claude to read the log and continue
    const primaryChatId = chatIds[0]!;

    // Use consolidated status callback (same pattern as normal message flow)
    const statusCallback = createBotApiStatusCallback(bot.api, primaryChatId, projectAlias);

    const logFile = `/tmp/long-run/${status.id}.log`;
    const prompt =
      `A background process has completed ${exitLabel}.\n` +
      `Command: ${status.command.trim()}\n` +
      `Log file: ${logFile}\n\n` +
      `Please read the log file and provide a summary of the results to the user.`;

    await projectSession.sendMessage(
      prompt,
      "system",
      0,
      statusCallback,
      primaryChatId,
      undefined
    );

    console.log(
      `ProcessMonitor: Handled completion of ${status.id} for project ${matchedAlias}`
    );
  } catch (error) {
    console.error(`ProcessMonitor: Failed to handle completion:`, error);
    // Try to send a fallback message
    try {
      const { loadProjectAliases } = await import("./project-aliases");
      const aliases = loadProjectAliases();
      let alias: string | null = null;
      for (const [path, a] of Object.entries(aliases)) {
        if (status.cwd === path || status.cwd.startsWith(path + "/")) {
          alias = a;
          break;
        }
      }
      if (alias) {
        const chatIds = sessionManager.getChatIdsForProject(alias);
        for (const chatId of chatIds) {
          await bot.api.sendMessage(
            chatId,
            `Background process completed but failed to auto-resume.\n` +
              `Command: ${status.command.trim()}\n` +
              `Exit code: ${status.exit_code}\n` +
              `Log: /tmp/long-run/${status.id}.log`
          );
        }
      }
    } catch {
      // Give up
    }
  }
}

// Treat slash commands from forwarded messages as regular text (security: don't execute /restart from forwards)
bot.use(async (ctx, next) => {
  const msg = ctx.message;
  if (msg?.text?.startsWith("/")) {
    // Check if message is forwarded
    const isForwarded = !!(msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_date);
    if (isForwarded) {
      // Treat forwarded commands as regular text - send directly to text handler
      await handleText(ctx);
      return; // Don't continue to command handlers
    }
  }
  await next();
});

// Sequentialize non-command messages per (chat, project) to prevent race conditions
// This allows concurrent execution across projects while preventing races within same project
bot.use(
  sequentialize((ctx) => {
    // Commands are not sequentialized - they work immediately
    if (ctx.message?.text?.startsWith("/")) {
      return undefined;
    }
    // Messages with ! prefix bypass queue (interrupt current project query)
    if (ctx.message?.text?.startsWith("!")) {
      return undefined;
    }
    // Callback queries (button clicks) are not sequentialized
    if (ctx.callbackQuery) {
      return undefined;
    }

    // Queue per (chatId, projectName) tuple
    // This allows different projects to run concurrently while preventing
    // race conditions within the same project
    const chatId = ctx.chat?.id;
    if (!chatId) return undefined;

    // Check for @project syntax in message to determine target project
    // This allows concurrent multi-project messaging
    const text = ctx.message?.text || "";
    const atMatch = text.match(/^@(\S+)\s/);
    let projectName: string;

    if (atMatch) {
      // Use the @-mentioned project for queue key
      projectName = atMatch[1]!.toLowerCase();
    } else {
      // Fall back to last-used project
      projectName = sessionManager.getLastUsed(chatId) || 'default';
    }

    return `${chatId}:${projectName}`;
  })
);

// ============== Command Handlers ==============

bot.command("start", handleStart);
bot.command("new", handleNew);
bot.command("stop", handleStop);
bot.command("status", handleStatus);
bot.command("resume", handleResume);
bot.command("restart", handleRestart);
bot.command("retry", handleRetry);
bot.command("handoff", handleHandoff);
bot.command("tmux", handleTmux);
bot.command("project", handleProject);
bot.command("projects", handleProjects);
bot.command("usage", handleUsage);

// ============== Message Handlers ==============

// Text messages
bot.on("message:text", handleText);

// Voice messages
bot.on("message:voice", handleVoice);

// Photo messages
bot.on("message:photo", handlePhoto);

// Document messages
bot.on("message:document", handleDocument);

// ============== Callback Queries ==============

bot.on("callback_query:data", handleCallback);

// ============== Error Handler ==============

bot.catch((err) => {
  console.error("Bot error:", err);
});

// Handle 409 polling conflicts by logging (actual retry logic is in startWithRetry)
// We don't retry here anymore to avoid double-retry issues
bot.api.config.use(async (prev, method, payload, signal) => {
  try {
    return await prev(method, payload, signal);
  } catch (error: any) {
    // If it's a 409 conflict error, log it but don't retry here
    // The startWithRetry function handles the main retry logic
    if (error?.error_code === 409) {
      console.warn(`409 Conflict in API call (${method}) - this will be handled by startWithRetry`);
    }
    throw error;
  }
});

// ============== Process Lock ==============

// Setup cleanup handlers early (before any errors can occur)
setupLockCleanup();

// Acquire process lock to prevent multiple instances
const lockResult = acquireLock();

if (!lockResult.success) {
  console.error("=".repeat(50));
  console.error("STARTUP FAILED: " + lockResult.message);
  console.error("=".repeat(50));
  console.error("");
  console.error("Another instance of the bot is already running.");
  console.error("To force start, first stop the other instance:");
  console.error("  pm2 stop claude-telegram-bot && pkill -9 -f 'bun.*claude-telegram-bot'");
  console.error("");
  process.exit(1);
}

if (lockResult.killedPids && lockResult.killedPids.length > 0) {
  console.log(`Cleaned up ${lockResult.killedPids.length} stale process(es)`);
}

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Claude Telegram Bot - TypeScript Edition");
console.log("=".repeat(50));
console.log(`PID: ${process.pid}`);
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);

// Scan and generate project aliases on startup
await scanAndGenerateAliases();

console.log("Starting bot...");

// Get bot info first
const botInfo = await bot.api.getMe();
console.log(`Bot started: @${botInfo.username}`);

// Clear any lingering webhook/polling connections
try {
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  console.log("Cleared previous connections");
} catch (e) {
  console.warn("Could not clear connections:", e);
}

// Check for pending restart message to update
if (existsSync(RESTART_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
    const age = Date.now() - data.timestamp;

    // Only update if restart was recent (within 30 seconds)
    if (age < 30000 && data.chat_id && data.message_id) {
      await bot.api.editMessageText(
        data.chat_id,
        data.message_id,
        "✅ Bot restarted"
      );
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    console.warn("Failed to update restart message:", e);
    try { unlinkSync(RESTART_FILE); } catch {}
  }
}

// Check for crash via heartbeat file (heartbeat file exists = crash, no graceful shutdown)
let crashedSessions: ActiveSessionEntry[] = [];
if (existsSync(HEARTBEAT_FILE)) {
  try {
    const heartbeat: HeartbeatData = JSON.parse(readFileSync(HEARTBEAT_FILE, "utf-8"));
    const age = Date.now() - new Date(heartbeat.last_heartbeat).getTime();

    // If heartbeat is recent (within 2 minutes), this was a crash
    if (age < 2 * 60 * 1000 && heartbeat.sessions.length > 0) {
      console.log(`Detected crash! Last heartbeat was ${Math.round(age / 1000)}s ago`);

      // Restore routing for ALL sessions from heartbeat
      const allHeartbeatSessions = heartbeat.sessions.filter(s => s.session_id);
      crashedSessions = allHeartbeatSessions.filter(s => s.was_running);

      // First: restore project routing for all sessions
      for (const sess of allHeartbeatSessions) {
        sessionManager.setLastUsed(sess.chat_id, sess.project_name);
        await sessionManager.getOrCreateSession(sess.project_name);
      }

      // Then: auto-continue only crashed (was_running) sessions
      for (const sess of crashedSessions) {
        try {
          await bot.api.sendMessage(
            sess.chat_id,
            `⚠️ <b>Bot crashed and restarted</b>\n\n` +
            `Resuming your session automatically...`,
            { parse_mode: "HTML" }
          );

          // Restore the session
          const projectSession = await sessionManager.getOrCreateSession(sess.project_name);
          if (sess.session_id) {
            const [success, message] = projectSession.session.resumeSession(sess.session_id);
            if (success) {
              console.log(`Resumed crashed session ${sess.session_id.slice(0, 8)}... for chat ${sess.chat_id}`);

              // Automatically continue the session
              await autoContinueSession(projectSession, sess.chat_id, true);
            } else {
              console.warn(`Failed to resume crashed session for chat ${sess.chat_id}: ${message}`);
            }
          }
        } catch (resumeError) {
          console.warn(`Failed to resume crashed session for chat ${sess.chat_id}:`, resumeError);
        }
      }
    }
    unlinkSync(HEARTBEAT_FILE);
  } catch (e) {
    console.warn("Failed to process heartbeat file:", e);
    try { unlinkSync(HEARTBEAT_FILE); } catch {}
  }
}

// Check for interrupted sessions (from graceful restart) and auto-resume
if (existsSync(ACTIVE_SESSIONS_FILE) && crashedSessions.length === 0) {
  try {
    const data: ActiveSessionsData = JSON.parse(
      readFileSync(ACTIVE_SESSIONS_FILE, "utf-8")
    );

    const age = Date.now() - new Date(data.shutdown_time).getTime();

    // Only resume if shutdown was recent (within 5 minutes)
    if (age < 5 * 60 * 1000) {
      // Restore project routing for ALL sessions (so messages route correctly after restart)
      const allSavedSessions = data.sessions.filter(s => s.session_id);
      const interruptedSessions = allSavedSessions.filter(s => s.was_running);

      console.log(`Restoring ${allSavedSessions.length} sessions (${interruptedSessions.length} were running)`);

      // First pass: restore lastUsed routing for ALL sessions
      for (const sess of allSavedSessions) {
        sessionManager.setLastUsed(sess.chat_id, sess.project_name);
        // Ensure project session exists with auto-resumed session ID
        await sessionManager.getOrCreateSession(sess.project_name);
        console.log(`Restored routing: chat ${sess.chat_id} → ${sess.project_name}`);
      }

      // Second pass: auto-continue only sessions that were actively running
      for (const sess of interruptedSessions) {
        try {
          // Send notification to chat
          await bot.api.sendMessage(
            sess.chat_id,
            `🔄 <b>Bot restarted</b>\n\n` +
            `Resuming your session automatically...`,
            { parse_mode: "HTML" }
          );

          // Get the project session (already created in first pass)
          const projectSession = await sessionManager.getOrCreateSession(sess.project_name);

          if (sess.session_id) {
            const [success, message] = projectSession.session.resumeSession(sess.session_id);
            if (success) {
              console.log(`Auto-continuing session ${sess.session_id.slice(0, 8)}... for chat ${sess.chat_id}`);

              // Automatically continue the session
              await autoContinueSession(projectSession, sess.chat_id, false);
            } else {
              console.warn(`Failed to resume session for chat ${sess.chat_id}: ${message}`);
            }
          }
        } catch (resumeError) {
          console.warn(`Failed to resume session for chat ${sess.chat_id}:`, resumeError);
        }
      }
    } else {
      console.log(`Active sessions file too old (${Math.round(age / 1000)}s), skipping resume`);
    }

    // Clean up
    unlinkSync(ACTIVE_SESSIONS_FILE);
  } catch (e) {
    console.warn("Failed to restore interrupted sessions:", e);
    try { unlinkSync(ACTIVE_SESSIONS_FILE); } catch {}
  }
}

// Start polling with concurrent update processing via @grammyjs/runner
// This allows different projects to process messages in parallel,
// while sequentialize ensures same-project messages are serial
let runner: ReturnType<typeof run> | null = null;

try {
  console.log("Starting concurrent polling with @grammyjs/runner...");
  runner = run(bot, {
    runner: {
      // Retry getUpdates calls for up to 60 seconds on failure
      maxRetryTime: 60000,
      retryInterval: "exponential",
    },
  });
  console.log("Polling started successfully (concurrent mode)");

  // Start monitoring for long-running process completions
  processMonitor.start(handleProcessCompletion, handleProcessStart);

  // Monitor runner task for unexpected termination
  runner.task()?.then(() => {
    console.log("Runner stopped");
  }).catch((err) => {
    console.error("Runner crashed:", err);
    process.exit(1);
  });
} catch (err) {
  console.error("Failed to start bot:", err);
  process.exit(1);
}

// Heartbeat interval - writes state every 10 seconds for crash detection
const HEARTBEAT_INTERVAL = 10_000;
const startTime = new Date().toISOString();

async function writeHeartbeat(): Promise<void> {
  const sessions: ActiveSessionEntry[] = [];

  for (const projSess of sessionManager.getAllSessions()) {
    const chatIds = sessionManager.getChatIdsForProject(projSess.projectName);
    for (const chatId of chatIds) {
      if (projSess.session.sessionId) {
        sessions.push({
          chat_id: chatId,
          project_name: projSess.projectName,
          session_id: projSess.session.sessionId,
          last_message: projSess.session.lastMessage || undefined,
          was_running: projSess.isRunning()
        });
      }
    }
  }

  const heartbeat: HeartbeatData = {
    pid: process.pid,
    started_at: startTime,
    last_heartbeat: new Date().toISOString(),
    sessions
  };

  await Bun.write(HEARTBEAT_FILE, JSON.stringify(heartbeat, null, 2));
}

// Start heartbeat
const heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL);
writeHeartbeat(); // Write immediately on start

// Graceful shutdown
const stopBot = async () => {
  console.log("Stopping bot...");
  if (runner?.isRunning()) {
    await runner.stop();
  }
};

/**
 * Save active sessions state before shutdown.
 * This allows auto-resume of interrupted sessions on restart.
 */
export async function saveActiveSessionsState(reason: "signal" | "restart"): Promise<void> {
  const activeData: ActiveSessionsData = {
    shutdown_time: new Date().toISOString(),
    reason,
    sessions: []
  };

  // Get all project sessions
  const allSessions = sessionManager.getAllSessions();

  for (const projSess of allSessions) {
    // Get all chat IDs that were using this project
    const chatIds = sessionManager.getChatIdsForProject(projSess.projectName);

    for (const chatId of chatIds) {
      if (projSess.session.sessionId) {
        activeData.sessions.push({
          chat_id: chatId,
          project_name: projSess.projectName,
          session_id: projSess.session.sessionId,
          last_message: projSess.session.lastMessage || undefined,
          was_running: projSess.isRunning()
        });
      }
    }
  }

  // Save to file
  if (activeData.sessions.length > 0) {
    await Bun.write(ACTIVE_SESSIONS_FILE, JSON.stringify(activeData, null, 2));
    console.log(`Saved ${activeData.sessions.length} active sessions (${activeData.sessions.filter(s => s.was_running).length} running)`);
  }
}

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}`);

  // Stop process monitor
  processMonitor.stop();

  // Stop heartbeat
  clearInterval(heartbeatTimer);

  // Delete heartbeat file (signals clean shutdown)
  try { unlinkSync(HEARTBEAT_FILE); } catch {}

  // Save active sessions state
  await saveActiveSessionsState("signal");

  // Release process lock
  releaseLock();

  await stopBot();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
