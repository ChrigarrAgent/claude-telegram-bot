/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart
 */

import type { Context } from "grammy";
import { session } from "../session";
import { sessionManager } from "../session-manager";
import { WORKING_DIR, ALLOWED_USERS, RESTART_FILE, getWorkingDir, setWorkingDir, resolveProjectPath } from "../config";
import { isAuthorized } from "../security";
import { getProjectAlias, getOrCreateProjectAlias, getAliasToPathMap, getProjectByAlias } from "../project-aliases";

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
  const projectAlias = getProjectAlias(workDir);

  await ctx.reply(
    `🤖 <b>Claude Telegram Bot</b>\n\n` +
      `Status: ${status}\n` +
      `Project: <b>${projectAlias}</b>\n` +
      `Directory: <code>${workDir}</code>\n\n` +
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
 * /new - Start a fresh session for the current project.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Get current project for this chat
  const projectName = chatId ? sessionManager.getLastUsed(chatId) : null;
  const projectSession = projectName ? sessionManager.getSession(projectName) : null;

  if (projectSession) {
    // Stop any running query on this project's session
    if (projectSession.isRunning()) {
      const result = await projectSession.session.stop();
      if (result) {
        await Bun.sleep(100);
        projectSession.session.clearStopRequested();
      }
    }

    // Clear the project's session
    await projectSession.kill();
    const projectAlias = getProjectAlias(projectSession.workingDir);

    // CRITICAL: Preserve the project mapping after killing session
    // This ensures next message stays in the same project
    if (chatId && projectName) {
      sessionManager.setLastUsed(chatId, projectName);
    }

    await ctx.reply(`🆕 Session cleared for <b>${projectAlias}</b>. Next message starts fresh.`, { parse_mode: "HTML" });
  } else {
    // Fallback to global session for backwards compatibility
    if (session.isRunning) {
      const result = await session.stop();
      if (result) {
        await Bun.sleep(100);
        session.clearStopRequested();
      }
    }
    await session.kill();
    await ctx.reply("🆕 Session cleared. Next message starts fresh.");
  }
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Try project-specific session first
  const projectName = chatId ? sessionManager.getLastUsed(chatId) : null;
  const projectSession = projectName ? sessionManager.getSession(projectName) : null;

  if (projectSession && projectSession.isRunning()) {
    const result = await projectSession.session.stop();
    if (result) {
      await Bun.sleep(100);
      projectSession.session.clearStopRequested();
    }
    // Silent stop - no message shown
  } else if (session.isRunning) {
    // Fallback to global session
    const result = await session.stop();
    if (result) {
      await Bun.sleep(100);
      session.clearStopRequested();
    }
  }
  // If nothing running, stay silent
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
      const projectAlias = getProjectAlias(currentSession.workingDir);
      lines.push(`▶️ <b>CURRENT: ${projectAlias}</b>`);

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
        const projectAlias = getProjectAlias(projSess.workingDir);
        const status = projSess.isActive() ? "✅" : "⚪";
        const idleTime = Math.floor(projSess.getIdleTime() / 1000);
        const idleStr = idleTime < 60 ? `${idleTime}s` : `${Math.floor(idleTime / 60)}m`;

        lines.push(`  ${status} ${projectAlias} (idle ${idleStr})`);

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

  // Save active sessions state for auto-resume
  try {
    const { saveActiveSessionsState } = await import("../index");
    await saveActiveSessionsState("restart");
  } catch (e) {
    console.warn("Failed to save active sessions:", e);
  }

  // Give time for the message to send
  await Bun.sleep(500);

  // Exit - PM2/launchd will restart us
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
    const currentAlias = getProjectAlias(currentDir);
    const aliasMap = getAliasToPathMap();
    const projectList = Object.entries(aliasMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 10) // Show first 10 aliases
      .map(([alias, path]) => {
        const isCurrent = path === currentDir;
        const marker = isCurrent ? " ← current" : "";
        return `  <code>/project ${alias}</code> → ${path}${marker}`;
      })
      .join("\n");

    await ctx.reply(
      `📁 <b>Current Project</b>\n` +
        `<b>${currentAlias}</b>\n` +
        `<code>${currentDir}</code>\n\n` +
        `<b>Available Projects:</b>\n${projectList}\n\n` +
        `Use <code>/projects</code> to see all projects with buttons.\n\n` +
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

  // Check if it's an alias (using auto-generated aliases)
  const aliasPath = getProjectByAlias(target);
  if (aliasPath) {
    newDir = aliasPath;
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

  // Generate/get alias and save it (explicit project switch)
  const projectAlias = getOrCreateProjectAlias(newDir);

  // If prompt provided, send it immediately
  if (optionalPrompt) {
    await ctx.reply(
      `✅ <b>Switched to: ${projectAlias}</b>\n` +
        `<code>${newDir}</code>\n\n` +
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
      `✅ <b>Switched to: ${projectAlias}</b>\n` +
        `<code>${newDir}</code>\n\n` +
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
 * /projects - List all available projects with interactive buttons.
 */
export async function handleProjects(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const currentDir = getWorkingDir();
  const currentAlias = getProjectAlias(currentDir);

  // Get all project aliases
  const aliasMap = getAliasToPathMap();
  const projects = Object.entries(aliasMap)
    .sort(([a], [b]) => a.localeCompare(b));

  if (projects.length === 0) {
    await ctx.reply(
      "📁 <b>No Projects Found</b>\n\n" +
        "No projects have been discovered yet.\n" +
        "Use <code>/project /path/to/dir</code> to add one.",
      { parse_mode: "HTML" }
    );
    return;
  }

  // Create inline keyboard buttons (2 per row)
  const buttons: { text: string; callback_data: string }[][] = [];

  for (let i = 0; i < projects.length; i += 2) {
    const row: { text: string; callback_data: string }[] = [];

    // First button in row
    const [alias1] = projects[i]!;
    const isCurrent1 = alias1 === currentAlias;
    row.push({
      text: isCurrent1 ? `▶️ ${alias1}` : alias1,
      callback_data: `project:switch:${alias1}`,
    });

    // Second button in row (if exists)
    if (projects[i + 1]) {
      const [alias2] = projects[i + 1]!;
      const isCurrent2 = alias2 === currentAlias;
      row.push({
        text: isCurrent2 ? `▶️ ${alias2}` : alias2,
        callback_data: `project:switch:${alias2}`,
      });
    }

    buttons.push(row);
  }

  // Add "Create New Project" button
  buttons.push([
    { text: "➕ Create New Project", callback_data: "project:create:new" },
  ]);

  await ctx.reply(
    `📁 <b>Available Projects</b> (${projects.length})\n\n` +
      `Current: <b>${currentAlias}</b>\n\n` +
      `Select a project to switch:`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Get project-specific session
  const projectName = chatId ? sessionManager.getLastUsed(chatId) : null;
  const projectSession = projectName ? sessionManager.getSession(projectName) : null;
  const lastMessage = projectSession?.session.lastMessage || session.lastMessage;

  // Check if there's a message to retry
  if (!lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  // Check if something is already running
  const isRunning = projectSession?.isRunning() || session.isRunning;
  if (isRunning) {
    await ctx.reply("⏳ A query is already running. Use /stop first.");
    return;
  }

  await ctx.reply(`🔄 Retrying: "${lastMessage.slice(0, 50)}${lastMessage.length > 50 ? "..." : ""}"`);

  // Simulate sending the message again by emitting a fake text message event
  // We do this by directly calling the text handler logic
  const { handleText } = await import("./text");

  // Create a modified context with the last message
  const fakeCtx = {
    ...ctx,
    message: {
      ...ctx.message,
      text: lastMessage,
    },
  } as Context;

  await handleText(fakeCtx);
}
