/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart
 */

import type { Context } from "grammy";
import { session } from "../session";
import { sessionManager } from "../session-manager";
import { WORKING_DIR, ALLOWED_USERS, RESTART_FILE, PROJECT_ALIASES, getWorkingDir, setWorkingDir } from "../config";
import { isAuthorized } from "../security";

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const status = session.isActive ? "Active session" : "No active session";
  const workDir = getWorkingDir();

  await ctx.reply(
    `🤖 <b>Claude Telegram Bot</b>\n\n` +
      `Status: ${status}\n` +
      `Working directory: <code>${workDir}</code>\n\n` +
      `<b>Session Commands:</b>\n` +
      `/new - Start fresh session\n` +
      `/stop - Stop current query\n` +
      `/status - Show detailed status\n` +
      `/usage - Show token usage &amp; costs\n` +
      `/resume - Resume saved session\n` +
      `/retry - Retry last message\n` +
      `/restart - Restart the bot\n\n` +
      `<b>Project Commands:</b>\n` +
      `/projects - List all available projects\n` +
      `/project &lt;name&gt; - Switch to project\n` +
      `  • If project doesn't exist, offers to create or clone from GitHub\n\n` +
      `<b>SSH Handoff:</b>\n` +
      `/handoff - Get SSH takeover command\n` +
      `/tmux - Shared tmux session info\n\n` +
      `<b>Message Features:</b>\n` +
      `• 📝 Text messages - Chat with Claude\n` +
      `• 🎤 Voice messages - Transcribed and processed\n` +
      `• 📷 Photos - Image analysis\n` +
      `• 📄 Documents - PDF and text file processing\n` +
      `• ↩️ Reply context - Reply to a message to include it\n` +
      `• ↪️ Forward context - Forward messages to analyze them\n\n` +
      `<b>Tips:</b>\n` +
      `• Prefix with <code>!</code> to interrupt current query\n` +
      `• Use "think" keyword for extended reasoning`,
    { parse_mode: "HTML" }
  );
}

/**
 * /new - Start a fresh session.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Stop any running query
  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      await Bun.sleep(100);
      session.clearStopRequested();
    }
  }

  // Clear session
  await session.kill();

  await ctx.reply("🆕 Session cleared. Next message starts fresh.");
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      // Wait for the abort to be processed, then clear stopRequested so next message can proceed
      await Bun.sleep(100);
      session.clearStopRequested();
    }
    // Silent stop - no message shown
  }
  // If nothing running, also stay silent
}

/**
 * /status - Show multi-project detailed status.
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const lines: string[] = ["📊 <b>Multi-Project Status</b>\n"];

  // Get all project sessions
  const allSessions = sessionManager.getAllSessions();
  const currentProject = sessionManager.getCurrentProject();

  if (allSessions.length === 0) {
    lines.push("⚪ No active sessions");
  } else {
    // Show current project first
    const currentSession = allSessions.find(s => s.projectName === currentProject);

    if (currentSession) {
      lines.push(`▶️ <b>CURRENT: ${currentSession.projectName}</b>`);

      const sess = currentSession.session;

      if (currentSession.isActive()) {
        lines.push(`  ✅ Session: ${sess.sessionId?.slice(0, 8)}...`);
      } else {
        lines.push("  ⚪ Session: None");
      }

      if (currentSession.isRunning()) {
        const elapsed = sess.queryStarted
          ? Math.floor((Date.now() - sess.queryStarted.getTime()) / 1000)
          : 0;
        lines.push(`  🔄 Query: Running (${elapsed}s)`);
        if (sess.currentTool) {
          lines.push(`     └─ ${sess.currentTool}`);
        }
      } else {
        lines.push("  ⚪ Query: Idle");
        if (sess.lastTool) {
          lines.push(`     └─ Last: ${sess.lastTool}`);
        }
      }

      if (currentSession.lastActivity) {
        const ago = Math.floor(currentSession.getIdleTime() / 1000);
        lines.push(`  ⏱️  Last: ${ago}s ago`);
      }

      lines.push(`  📁 ${currentSession.workingDir}`);
    }

    // Show other projects
    const otherSessions = allSessions.filter(s => s.projectName !== currentProject);

    if (otherSessions.length > 0) {
      lines.push(`\n📁 <b>OTHER PROJECTS:</b>`);

      for (const projSess of otherSessions) {
        const status = projSess.isActive() ? "✅" : "⚪";
        const idleTime = Math.floor(projSess.getIdleTime() / 1000);
        const idleStr = idleTime < 60 ? `${idleTime}s` : `${Math.floor(idleTime / 60)}m`;

        lines.push(`  ${status} ${projSess.projectName} (idle ${idleStr})`);

        if (projSess.session.sessionId) {
          lines.push(`     └─ ${projSess.session.sessionId.slice(0, 8)}...`);
        }
      }
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /resume - Show list of all sessions across projects with inline keyboard.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Get ALL saved sessions (cross-project)
  const allSessions = session.getSessionList(); // No filter = all sessions

  if (allSessions.length === 0) {
    await ctx.reply("❌ No saved sessions.");
    return;
  }

  // Group sessions by project
  const sessionsByProject = new Map<string, typeof allSessions>();

  for (const sess of allSessions) {
    const projName = sess.project || "default";
    if (!sessionsByProject.has(projName)) {
      sessionsByProject.set(projName, []);
    }
    sessionsByProject.get(projName)!.push(sess);
  }

  // Build message with grouped sessions
  const lines: string[] = ["📋 <b>All Saved Sessions</b>\n"];

  const currentProject = sessionManager.getCurrentProject();

  // Show current project first
  const currentSessions = sessionsByProject.get(currentProject);
  if (currentSessions) {
    lines.push(`▶️ <b>${currentProject}</b> (current)`);
    sessionsByProject.delete(currentProject);
  }

  // Build inline keyboard with session list
  const buttons: { text: string; callback_data: string }[][] = [];

  if (currentSessions) {
    for (const s of currentSessions) {
      const date = new Date(s.saved_at);
      const dateStr = date.toLocaleDateString("it-IT", {
        day: "2-digit",
        month: "2-digit",
      });
      const timeStr = date.toLocaleTimeString("it-IT", {
        hour: "2-digit",
        minute: "2-digit",
      });

      const titlePreview =
        s.title.length > 30 ? s.title.slice(0, 27) + "..." : s.title;

      buttons.push([
        {
          text: `📅 ${dateStr} ${timeStr} - "${titlePreview}"`,
          callback_data: `resume:${s.session_id}:${s.project || "default"}`,
        },
      ]);
    }
  }

  // Show other projects
  for (const [projName, sessions] of sessionsByProject.entries()) {
    lines.push(`\n📁 <b>${projName}</b>`);

    for (const s of sessions) {
      const date = new Date(s.saved_at);
      const dateStr = date.toLocaleDateString("it-IT", {
        day: "2-digit",
        month: "2-digit",
      });
      const timeStr = date.toLocaleTimeString("it-IT", {
        hour: "2-digit",
        minute: "2-digit",
      });

      const titlePreview =
        s.title.length > 30 ? s.title.slice(0, 27) + "..." : s.title;

      buttons.push([
        {
          text: `${projName}: ${dateStr} ${timeStr} - "${titlePreview}"`,
          callback_data: `resume:${s.session_id}:${s.project || "default"}`,
        },
      ]);
    }
  }

  await ctx.reply("📋 <b>Saved Sessions (All Projects)</b>\n\nSelect a session to resume:", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}

/**
 * /restart - Restart the bot process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const msg = await ctx.reply("🔄 Restarting bot...");

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  // Give time for the message to send
  await Bun.sleep(500);

  // Exit - launchd will restart us
  process.exit(0);
}

/**
 * /handoff - Show session ID and SSH takeover instructions.
 */
export async function handleHandoff(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (!session.isActive) {
    await ctx.reply(
      "❌ No active session.\n\n" +
        "Start a conversation first, then use /handoff to take over in SSH."
    );
    return;
  }

  const sessionId = session.sessionId!;
  const shortId = sessionId.slice(0, 8);

  // Create a simple command the user can run after SSH
  await ctx.reply(
    `🔄 <b>SSH Handoff</b>\n\n` +
      `<b>1. SSH to your server, then run:</b>\n` +
      `<code>cr</code>\n\n` +
      `That's it! The <code>cr</code> (claude-resume) command auto-detects and resumes this session.\n\n` +
      `<b>Session ID (if needed):</b>\n` +
      `<code>${sessionId}</code>`,
    { parse_mode: "HTML" }
  );
}

/**
 * /tmux - Start/attach to a shared tmux session for Claude.
 */
export async function handleTmux(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const tmuxSession = "claude-shared";
  const sessionArg = session.isActive ? ` --resume ${session.sessionId}` : "";

  await ctx.reply(
    `🖥️ <b>tmux Session</b>\n\n` +
      `<b>Attach to shared session:</b>\n` +
      `<code>tmux attach -t ${tmuxSession} || tmux new -s ${tmuxSession} "claude${sessionArg}"</code>\n\n` +
      `<b>Send command from Telegram:</b>\n` +
      `<code>tmux send-keys -t ${tmuxSession} "your message" Enter</code>\n\n` +
      `<b>Current state:</b>\n` +
      `• Telegram session: ${session.isActive ? "Active" : "None"}\n` +
      `• Working dir: <code>${WORKING_DIR}</code>`,
    { parse_mode: "HTML" }
  );
}

/**
 * /project - Switch working directory or list projects.
 */
export async function handleProject(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.split(/\s+/).slice(1); // Remove /project

  // No args - show current project and list
  if (args.length === 0) {
    const currentDir = getWorkingDir();
    const projectList = Object.entries(PROJECT_ALIASES)
      .map(([name, path]) => `  <code>/project ${name}</code> → ${path}`)
      .join("\n");

    await ctx.reply(
      `📁 <b>Current Project</b>\n` +
        `<code>${currentDir}</code>\n\n` +
        `<b>Available Projects:</b>\n${projectList}\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/project name</code> - Switch to project\n` +
        `<code>/project name &lt;prompt&gt;</code> - Switch and send prompt\n` +
        `<code>/project /path</code> - Switch to custom path`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const target = args[0]!;
  // Extract optional prompt (everything after project name)
  const promptStartIndex = text.indexOf(target) + target.length;
  const optionalPrompt = text.slice(promptStartIndex).trim();
  let newDir: string;

  // Check if it's an alias
  if (PROJECT_ALIASES[target]) {
    newDir = PROJECT_ALIASES[target]!;
  } else if (target.startsWith("/") || target.startsWith("~")) {
    // It's a path
    newDir = target.replace(/^~/, process.env.HOME || "/home/ubuntu");
  } else {
    // Try as a project name in common locations
    const candidates = [
      `/home/ubuntu/Projects/${target}`,
      `/home/ubuntu/.openclaw/workspace/${target}`,
      `/home/ubuntu/${target}`,
    ];
    const { existsSync, statSync } = await import("fs");
    const found = candidates.find((p) => {
      try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
    });
    if (!found) {
      // Project not found - offer to create or clone
      await ctx.reply(
        `🔍 Project "<b>${target}</b>" not found.\n\n` +
          `What would you like to do?`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "📁 Create empty project", callback_data: `project:create:${target}` },
              ],
              [
                { text: "🐙 Clone from GitHub", callback_data: `project:clone:${target}` },
              ],
              [
                { text: "❌ Cancel", callback_data: `project:cancel` },
              ],
            ],
          },
        }
      );
      return;
    }
    newDir = found;
  }

  // Verify directory exists (use fs.stat for directories, Bun.file is only for files)
  const { stat } = await import("fs/promises");
  const dirExists = await stat(newDir).then(s => s.isDirectory()).catch(() => false);
  if (!dirExists) {
    await ctx.reply(`❌ Directory not found: <code>${newDir}</code>`, {
      parse_mode: "HTML",
    });
    return;
  }

  // Extract project name from directory path
  const pathParts = newDir.split("/");
  const projectName = pathParts[pathParts.length - 1] || "default";

  // Switch directory and update session manager
  setWorkingDir(newDir);
  sessionManager.setCurrentProject(projectName);

  // Track last-used project for this chat
  const chatId = ctx.chat?.id;
  if (chatId) {
    sessionManager.setLastUsed(chatId, projectName);
  }

  // If prompt provided, send it immediately
  if (optionalPrompt) {
    await ctx.reply(
      `✅ <b>Switched to:</b> <code>${newDir}</code>\n\n` +
        `🚀 Sending prompt...`,
      { parse_mode: "HTML" }
    );

    // Import and call text handler with the prompt
    const { handleText } = await import("./text");
    const fakeCtx = {
      ...ctx,
      message: {
        ...ctx.message,
        text: optionalPrompt,
      },
    } as Context;

    await handleText(fakeCtx);
  } else {
    await ctx.reply(
      `✅ <b>Switched to:</b> <code>${projectName}</code>\n\n` +
        `Next message will use this project.`,
      { parse_mode: "HTML" }
    );
  }
}

/**
 * Helper to create a progress bar using Unicode blocks.
 */
function progressBar(used: number, total: number, width = 10): string {
  const pct = Math.min(used / total, 1);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * Helper to format numbers compactly (1234567 -> 1.2M)
 */
function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return n.toString();
}

/**
 * /usage - Show Claude Code usage statistics and rate limits.
 */
export async function handleUsage(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const statusMsg = await ctx.reply("📊 Fetching usage data...");

  try {
    const { readFileSync } = await import("fs");
    const lines: string[] = ["📊 <b>Claude Code Usage</b>"];

    // Try to get rate limits from API
    let hasRateLimits = false;
    try {
      const credPath = `${process.env.HOME}/.claude/.credentials.json`;
      const creds = JSON.parse(readFileSync(credPath, "utf-8"));
      const token = creds.claudeAiOauth?.accessToken;

      if (token) {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-5-20250929",
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
        });

        const limitRequests = response.headers.get("anthropic-ratelimit-requests-limit");
        const remainingRequests = response.headers.get("anthropic-ratelimit-requests-remaining");
        const limitTokens = response.headers.get("anthropic-ratelimit-tokens-limit");
        const remainingTokens = response.headers.get("anthropic-ratelimit-tokens-remaining");
        const resetTime = response.headers.get("anthropic-ratelimit-requests-reset");

        if (limitRequests || limitTokens) {
          hasRateLimits = true;
          lines.push("\n<b>⏱️ Rate Limits (5h)</b>");
          lines.push("<pre>");

          if (limitRequests && remainingRequests) {
            const limit = parseInt(limitRequests);
            const remaining = parseInt(remainingRequests);
            const used = limit - remaining;
            const pct = ((used / limit) * 100).toFixed(0);
            lines.push(`Requests ${progressBar(used, limit)} ${pct.padStart(3)}%`);
            lines.push(`         ${used.toString().padStart(6)} / ${limit}`);
          }

          if (limitTokens && remainingTokens) {
            const limit = parseInt(limitTokens);
            const remaining = parseInt(remainingTokens);
            const used = limit - remaining;
            const pct = ((used / limit) * 100).toFixed(0);
            lines.push(`Tokens   ${progressBar(used, limit)} ${pct.padStart(3)}%`);
            lines.push(`         ${formatNum(used).padStart(6)} / ${formatNum(limit)}`);
          }

          if (resetTime) {
            const resetDate = new Date(resetTime);
            const now = new Date();
            const minsLeft = Math.round((resetDate.getTime() - now.getTime()) / 60000);
            if (minsLeft > 0) {
              const h = Math.floor(minsLeft / 60);
              const m = minsLeft % 60;
              lines.push(`Resets   ${h}h ${m}m`);
            }
          }
          lines.push("</pre>");
        }
      }
    } catch (rateLimitError) {
      console.log("Could not fetch rate limits:", rateLimitError);
    }

    // Read stats cache
    const statsPath = `${process.env.HOME}/.claude/stats-cache.json`;
    const stats = JSON.parse(readFileSync(statsPath, "utf-8"));

    // Model usage table
    if (stats.modelUsage && Object.keys(stats.modelUsage).length > 0) {
      lines.push("\n<b>📈 Token Usage</b>");
      lines.push("<pre>");
      lines.push("Model          Input    Output    Cache");
      lines.push("─".repeat(42));

      for (const [model, usage] of Object.entries(stats.modelUsage)) {
        const u = usage as {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
        };
        const shortModel = model
          .replace("claude-", "")
          .replace(/-20\d+$/, "")
          .slice(0, 12)
          .padEnd(12);
        const input = formatNum(u.inputTokens).padStart(8);
        const output = formatNum(u.outputTokens).padStart(8);
        const cache = formatNum((u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0)).padStart(8);
        lines.push(`${shortModel}  ${input}  ${output}  ${cache}`);
      }
      lines.push("</pre>");
    }

    // Activity stats
    lines.push("\n<b>📊 Activity</b>");
    lines.push("<pre>");
    lines.push(`Sessions: ${stats.totalSessions || 0}`);
    lines.push(`Messages: ${stats.totalMessages || 0}`);
    lines.push("</pre>");

    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      lines.join("\n"),
      { parse_mode: "HTML" }
    );
  } catch (error) {
    console.error("Usage error:", error);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      "❌ Could not read usage stats.",
      { parse_mode: "HTML" }
    );
  }
}

/**
 * /projects - List all available projects.
 */
export async function handleProjects(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const { existsSync, readdirSync, statSync } = await import("fs");
  const currentDir = getWorkingDir();

  // Get project aliases
  const aliasLines = Object.entries(PROJECT_ALIASES)
    .map(([name, path]) => {
      const isCurrent = path === currentDir;
      const marker = isCurrent ? " ← current" : "";
      return `  <code>${name}</code> → ${path}${marker}`;
    })
    .join("\n");

  // Scan Projects directory for additional projects
  const projectsDir = "/home/ubuntu/Projects";
  let discoveredProjects: string[] = [];

  if (existsSync(projectsDir)) {
    try {
      discoveredProjects = readdirSync(projectsDir)
        .filter((name) => {
          const fullPath = `${projectsDir}/${name}`;
          try {
            return statSync(fullPath).isDirectory() && !name.startsWith(".");
          } catch {
            return false;
          }
        })
        .filter((name) => !Object.keys(PROJECT_ALIASES).includes(name));
    } catch {
      // Ignore errors
    }
  }

  let discoveredSection = "";
  if (discoveredProjects.length > 0) {
    const discoveredLines = discoveredProjects
      .map((name) => {
        const fullPath = `${projectsDir}/${name}`;
        const isCurrent = fullPath === currentDir;
        const marker = isCurrent ? " ← current" : "";
        return `  <code>${name}</code>${marker}`;
      })
      .join("\n");
    discoveredSection = `\n\n<b>Other Projects (~/Projects/):</b>\n${discoveredLines}`;
  }

  await ctx.reply(
    `📁 <b>Available Projects</b>\n\n` +
      `<b>Aliases:</b>\n${aliasLines}${discoveredSection}\n\n` +
      `<b>Usage:</b>\n` +
      `<code>/project name</code> - Switch to project\n` +
      `<code>/project /path</code> - Switch to custom path`,
    { parse_mode: "HTML" }
  );
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Check if there's a message to retry
  if (!session.lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  // Check if something is already running
  if (session.isRunning) {
    await ctx.reply("⏳ A query is already running. Use /stop first.");
    return;
  }

  const message = session.lastMessage;
  await ctx.reply(`🔄 Retrying: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`);

  // Simulate sending the message again by emitting a fake text message event
  // We do this by directly calling the text handler logic
  const { handleText } = await import("./text");

  // Create a modified context with the last message
  const fakeCtx = {
    ...ctx,
    message: {
      ...ctx.message,
      text: message,
    },
  } as Context;

  await handleText(fakeCtx);
}
