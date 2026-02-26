/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart
 */

import type { Context } from "grammy";
import { getSavedSessionList } from "../session";
import { sessionManager } from "../session-manager";
import { ALLOWED_USERS, RESTART_FILE, getWorkingDir, setWorkingDir, resolveProjectPath } from "../config";
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

  const chatId = ctx.chat?.id;
  const projectName = chatId ? sessionManager.getLastUsed(chatId) : null;
  const projectSession = projectName ? sessionManager.getSession(projectName) : null;
  const status = projectSession?.isActive() ? "Active session" : "No active session";
  const workDir = getWorkingDir();
  const projectAlias = getProjectAlias(workDir);

  await ctx.reply(
    `🤖 <b>Claude Telegram Bot</b>\n\n` +
      `Status: ${status}\n` +
      `Project: <b>${projectAlias}</b>\n` +
      `Directory: <code>${workDir}</code>\n\n` +
      `<b>Quick Start:</b>\n` +
      `/help - Complete guide to all features\n` +
      `/projects - Switch between projects\n` +
      `/new - Start fresh session\n` +
      `/status - Show detailed status\n` +
      `/voice - Toggle voice responses\n\n` +
      `<b>Message Types:</b>\n` +
      `• 📝 Text messages - Chat with Claude\n` +
      `• 🎤 Voice messages - Transcribed and processed\n` +
      `• 📷 Photos - Image analysis\n` +
      `• 📄 Documents - PDF and text file processing\n` +
      `• ↩️ Reply context - Reply to a message to include it\n` +
      `• ↪️ Forward context - Forward messages to analyze them\n\n` +
      `<b>Tips:</b>\n` +
      `• Prefix with <code>!</code> to interrupt current query\n` +
      `• Use "think" keyword for extended reasoning\n` +
      `• Type <code>/help</code> for complete documentation`,
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
    await ctx.reply("🆕 No active session. Next message starts fresh.");
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
  const allSessions = getSavedSessionList();

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

  // Collect active session IDs per project for marking current sessions
  const activeSessionIds = new Set<string>();
  for (const projSess of sessionManager.getAllSessions()) {
    if (projSess.session.sessionId) {
      activeSessionIds.add(projSess.session.sessionId);
    }
  }

  // Helper to build a session button
  const makeButton = (s: typeof allSessions[0], prefix: string) => {
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
      s.title.length > 25 ? s.title.slice(0, 22) + "..." : s.title;
    const isActive = activeSessionIds.has(s.session_id);
    const activeMarker = isActive ? "\u2713 " : "";

    return [{
      text: `${activeMarker}${prefix}${dateStr} ${timeStr} - "${titlePreview}"`,
      callback_data: `resume:${s.session_id}:${s.project || "default"}`,
    }];
  };

  // Build inline keyboard with session list
  const buttons: { text: string; callback_data: string }[][] = [];

  if (currentSessions) {
    for (const s of currentSessions) {
      buttons.push(makeButton(s, ""));
    }
  }

  // Show other projects
  for (const [projName, sessions] of sessionsByProject.entries()) {
    lines.push(`\n📁 <b>${projName}</b>`);

    for (const s of sessions) {
      buttons.push(makeButton(s, `${projName}: `));
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

  const chatId = ctx.chat?.id;
  const projectName = chatId ? sessionManager.getLastUsed(chatId) : null;
  const projectSession = projectName ? sessionManager.getSession(projectName) : null;

  if (!projectSession?.isActive()) {
    await ctx.reply(
      "❌ No active session.\n\n" +
        "Start a conversation first, then use /handoff to take over in SSH."
    );
    return;
  }

  const sessionId = projectSession.session.sessionId!;

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

  const chatId = ctx.chat?.id;
  const projectName = chatId ? sessionManager.getLastUsed(chatId) : null;
  const projectSession = projectName ? sessionManager.getSession(projectName) : null;

  const tmuxSession = "claude-shared";
  const sessionArg = projectSession?.isActive() ? ` --resume ${projectSession.session.sessionId}` : "";
  const workDir = projectSession?.workingDir || getWorkingDir();

  await ctx.reply(
    `🖥️ <b>tmux Session</b>\n\n` +
      `<b>Attach to shared session:</b>\n` +
      `<code>tmux attach -t ${tmuxSession} || tmux new -s ${tmuxSession} "claude${sessionArg}"</code>\n\n` +
      `<b>Send command from Telegram:</b>\n` +
      `<code>tmux send-keys -t ${tmuxSession} "your message" Enter</code>\n\n` +
      `<b>Current state:</b>\n` +
      `• Telegram session: ${projectSession?.isActive() ? "Active" : "None"}\n` +
      `• Working dir: <code>${workDir}</code>`,
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
  const lastMessage = projectSession?.session.lastMessage || null;

  // Check if there's a message to retry
  if (!lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  // Check if something is already running
  const isRunning = projectSession?.isRunning() || false;
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

/**
 * Generate a progress bar for usage display.
 */
function generateProgressBar(percent: number, length: number = 20): string {
  const filled = Math.round((percent / 100) * length);
  const empty = length - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `[${bar}]`;
}

/**
 * /voice [on|off|clear|status|override] - Toggle voice mode and track usage.
 *
 * In DM: Sets voice mode for DM and ALL linked groups
 * In Group: Sets voice mode for this group only
 */
export async function handleVoice(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (!chatId) return;

  const { TTS_AVAILABLE } = await import("../config");
  if (!TTS_AVAILABLE) {
    await ctx.reply(
      "❌ <b>Voice mode not available</b>\n\n" +
        "Set <code>GOOGLE_TTS_API_KEY</code> in your environment to enable voice responses.\n\n" +
        "Get an API key:\n" +
        "1. Go to https://console.cloud.google.com/\n" +
        "2. Enable Text-to-Speech API\n" +
        "3. Create API key in Credentials",
      { parse_mode: "HTML" }
    );
    return;
  }

  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const { getVoiceMode, setChatVoiceMode, clearChatVoiceMode } = await import("../chat-settings");
  const { getAllGroupLinks } = await import("../group-links");
  const { getTTSUsageStats, setTTSDisabled } = await import("../tts-usage");

  // Parse args
  const text = ctx.message?.text || "";
  const args = text.split(/\s+/).slice(1);
  const command = args[0]?.toLowerCase();

  // Show status if no args
  if (!command) {
    const current = getVoiceMode(chatId);
    const { getVoiceProfile } = await import("../chat-settings");
    const { getVoiceProfile: getProfile } = await import("../voice-profiles");
    const profileId = getVoiceProfile(chatId);
    const profile = getProfile(profileId);

    await ctx.reply(
      `🔊 <b>Voice Mode</b>\n\n` +
      `Current: ${current ? 'ON 🔊' : 'OFF 🔇'}\n` +
      `Profile: <b>${profile.name}</b> (${profile.description})\n\n` +
      `<b>Usage:</b>\n` +
      `<code>/voice on</code> - Enable voice responses\n` +
      `<code>/voice off</code> - Disable voice responses\n` +
      `<code>/voice profiles</code> - List voice profiles\n` +
      `<code>/voice profile &lt;id&gt;</code> - Switch profile\n` +
      `<code>/voice language [code]</code> - Set/view language\n` +
      `<code>/voice status</code> - Check TTS usage stats\n` +
      (isGroup ? `<code>/voice clear</code> - Reset to default\n\n` : '\n') +
      (isGroup
        ? `<i>Changes apply to this group only.</i>`
        : `<i>Changes apply to DM and all linked groups.</i>`
      ),
      { parse_mode: "HTML" }
    );
    return;
  }

  // Handle profiles list
  if (command === 'profiles') {
    const { getAllVoiceProfiles } = await import("../voice-profiles");
    const { getVoiceProfile } = await import("../chat-settings");
    const currentProfileId = getVoiceProfile(chatId);
    const profiles = getAllVoiceProfiles();

    // Create inline keyboard buttons (2 per row)
    const buttons: { text: string; callback_data: string }[][] = [];

    for (let i = 0; i < profiles.length; i += 2) {
      const row: { text: string; callback_data: string }[] = [];

      // First button in row
      const profile1 = profiles[i]!;
      const isCurrent1 = profile1.id === currentProfileId;
      row.push({
        text: isCurrent1 ? `▶️ ${profile1.name}` : profile1.name,
        callback_data: `voice_profile:${profile1.id}`,
      });

      // Second button in row (if exists)
      if (profiles[i + 1]) {
        const profile2 = profiles[i + 1]!;
        const isCurrent2 = profile2.id === currentProfileId;
        row.push({
          text: isCurrent2 ? `▶️ ${profile2.name}` : profile2.name,
          callback_data: `voice_profile:${profile2.id}`,
        });
      }

      buttons.push(row);
    }

    await ctx.reply(
      `🎙️ <b>Available Voice Profiles</b>\n\n` +
      `Current: <b>${profiles.find(p => p.id === currentProfileId)?.name}</b>\n\n` +
      `Select a profile to switch:`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: buttons,
        },
      }
    );
    return;
  }

  // Handle profile switch
  if (command === 'profile') {
    const profileId = args[1]?.toLowerCase();

    if (!profileId) {
      await ctx.reply(
        `❌ Please specify a profile ID.\n\n` +
        `Usage: <code>/voice profile &lt;id&gt;</code>\n` +
        `Example: <code>/voice profile genz</code>\n\n` +
        `Use <code>/voice profiles</code> to see all available profiles.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const { getVoiceProfile: getProfile } = await import("../voice-profiles");
    const { setVoiceProfile } = await import("../chat-settings");
    const profile = getProfile(profileId);

    // Check if profile exists (will return default if not found)
    if (profile.id !== profileId) {
      await ctx.reply(
        `❌ Unknown profile: <code>${profileId}</code>\n\n` +
        `Use <code>/voice profiles</code> to see available profiles.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Set profile for this chat
    if (isGroup) {
      // Group: Set for this group only
      setVoiceProfile(chatId, profileId);

      await ctx.reply(
        `✅ Voice profile switched to <b>${profile.name}</b>\n\n` +
        `${profile.description}\n\n` +
        `Voice: ${profile.voice}\n\n` +
        `<i>${profile.systemPrompt.split('\n')[0]}</i>`,
        { parse_mode: "HTML" }
      );
    } else {
      // DM: Set for DM + propagate to all linked groups
      setVoiceProfile(chatId, profileId);

      // Propagate to all linked groups
      const allGroups = getAllGroupLinks();
      let groupCount = 0;
      for (const [groupId] of Array.from(allGroups)) {
        setVoiceProfile(groupId, profileId);
        groupCount++;
      }

      await ctx.reply(
        `✅ Voice profile switched to <b>${profile.name}</b>\n\n` +
        `${profile.description}\n\n` +
        `Voice: ${profile.voice}\n\n` +
        `<i>${profile.systemPrompt.split('\n')[0]}</i>\n\n` +
        `Applied to DM and ${groupCount} linked group(s).\n\n` +
        `<i>Groups can still override individually with /voice profile.</i>`,
        { parse_mode: "HTML" }
      );
    }
    return;
  }

  // Handle language setting (global bot setting)
  if (command === 'language') {
    const languageCode = args[1]?.toLowerCase();

    if (!languageCode) {
      // Show current language
      const { getGlobalVoiceLanguage } = await import("../global-settings");
      const languageOverride = getGlobalVoiceLanguage();
      const currentLanguage = languageOverride || "en-US";

      await ctx.reply(
        `🌍 <b>Voice Language (Global)</b>\n\n` +
        `Current: <b>${currentLanguage}</b> ${languageOverride ? '(custom)' : '(default)'}\n\n` +
        `<b>Usage:</b>\n` +
        `<code>/voice language en-US</code> - English (US)\n` +
        `<code>/voice language de-DE</code> - German\n` +
        `<code>/voice language es-ES</code> - Spanish\n` +
        `<code>/voice language fr-FR</code> - French\n` +
        `<code>/voice language clear</code> - Reset to default\n\n` +
        `<i>⚙️ This is a bot-wide setting that applies to ALL chats (DMs and groups).</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Handle clear
    if (languageCode === 'clear') {
      const { clearGlobalVoiceLanguage } = await import("../global-settings");
      clearGlobalVoiceLanguage();

      await ctx.reply(
        `✅ Language reset to default: <b>en-US</b>\n\n` +
        `<i>This applies to all chats.</i>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Set language override
    const { setGlobalVoiceLanguage } = await import("../global-settings");
    setGlobalVoiceLanguage(languageCode);

    await ctx.reply(
      `✅ Voice language set to <b>${languageCode}</b>\n\n` +
      `<i>⚙️ This applies to ALL chats (DMs and groups).</i>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Handle status
  if (command === 'status') {
    const stats = getTTSUsageStats();
    const percentBar = generateProgressBar(stats.percentUsed, 20);

    await ctx.reply(
      `📊 <b>TTS Usage Statistics</b>\n\n` +
      `<b>Month:</b> ${stats.month}\n` +
      `<b>Characters used:</b> ${stats.charactersUsed.toLocaleString()} / ${stats.monthlyLimit.toLocaleString()}\n` +
      `<b>Requests:</b> ${stats.requestCount.toLocaleString()}\n` +
      `<b>Usage:</b> ${stats.percentUsed.toFixed(1)}%\n` +
      `${percentBar}\n\n` +
      `<b>Remaining:</b> ${stats.remainingCharacters.toLocaleString()} characters\n` +
      `<b>Status:</b> ${stats.disabled ? '🔴 DISABLED (limit reached)' : '🟢 Active'}\n\n` +
      `<i>Auto-disables at ${(stats.willAutoDisableAt).toLocaleString()} characters (98%)</i>\n\n` +
      (stats.disabled
        ? `Use <code>/voice override</code> to manually re-enable (not recommended)`
        : ``),
      { parse_mode: "HTML" }
    );
    return;
  }

  // Handle override (manual re-enable)
  if (command === 'override') {
    const stats = getTTSUsageStats();
    if (!stats.disabled) {
      await ctx.reply("⚠️ TTS is not currently disabled.");
      return;
    }

    setTTSDisabled(false);
    await ctx.reply(
      `✅ TTS manually re-enabled.\n\n` +
      `⚠️ <b>Warning:</b> You've used ${stats.percentUsed.toFixed(1)}% of your monthly limit.\n` +
      `Continuing may result in charges if you exceed the free tier.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Handle clear (groups only)
  if (command === 'clear') {
    if (!isGroup) {
      await ctx.reply("Clear is only for groups.");
      return;
    }

    clearChatVoiceMode(chatId);
    await ctx.reply(`✅ Voice mode reset to default (OFF)`);
    return;
  }

  // Validate command
  const validCommands = ['on', 'off', 'status', 'override', 'profiles', 'profile'];
  if (isGroup) validCommands.push('clear');

  if (!validCommands.includes(command)) {
    await ctx.reply(
      `Invalid command. Use:\n` +
      `<code>/voice on</code>\n` +
      `<code>/voice off</code>\n` +
      `<code>/voice profiles</code>\n` +
      `<code>/voice profile &lt;id&gt;</code>\n` +
      `<code>/voice language [code]</code>\n` +
      `<code>/voice status</code>\n` +
      (isGroup ? `<code>/voice clear</code>\n` : '') +
      `<code>/voice override</code> (if disabled)`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const enable = command === 'on';

  if (isGroup) {
    // Group: Set for this group only
    setChatVoiceMode(chatId, enable);
    await ctx.reply(
      `${enable ? '🔊' : '🔇'} Voice mode ${enable ? 'enabled' : 'disabled'} for this group.`
    );
  } else {
    // DM: Set for DM + propagate to all linked groups
    setChatVoiceMode(chatId, enable);

    // Propagate to all linked groups
    const allGroups = getAllGroupLinks();
    let groupCount = 0;
    for (const [groupId] of Array.from(allGroups)) {
      setChatVoiceMode(groupId, enable);
      groupCount++;
    }

    await ctx.reply(
      `${enable ? '🔊' : '🔇'} Voice mode ${enable ? 'enabled' : 'disabled'}.\n\n` +
      `Applied to DM and ${groupCount} linked group(s).\n\n` +
      `<i>Groups can still override individually with /voice.</i>`,
      { parse_mode: "HTML" }
    );
  }
}

/**
 * /link <project-name> - Link a group chat to a project (requires verification).
 */
export async function handleLink(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;
  const groupTitle = ctx.chat?.title || "Unknown Group";

  if (!userId || !chatId) {
    return;
  }

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // Only works in groups
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  if (!isGroup) {
    await ctx.reply(
      "⚠️ The <code>/link</code> command only works in group chats.\n\n" +
      "Use it in a group to link the group to a project.",
      { parse_mode: "HTML" }
    );
    return;
  }

  // Parse project name from command
  const args = ctx.message?.text?.split(/\s+/).slice(1);
  if (!args || args.length === 0) {
    // No project specified - show inline buttons like /projects
    const { getGroupLink } = await import("../group-links");
    const existingLink = getGroupLink(chatId);

    // Get all available projects
    const aliasMap = getAliasToPathMap();
    const projectButtons = Object.entries(aliasMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([alias]) => [
        {
          text: alias,
          callback_data: `link_project:${alias}`,
        },
      ]);

    if (projectButtons.length === 0) {
      await ctx.reply(
        "❌ No projects found.\n\n" +
        "Create a project folder first, then use <code>/link &lt;project-name&gt;</code>",
        { parse_mode: "HTML" }
      );
      return;
    }

    let message = "🔗 <b>Link Group to Project</b>\n\n";
    if (existingLink) {
      message += `Currently linked to: <code>${existingLink.projectName}</code>\n\n`;
      message += "Select a different project to link:\n";
    } else {
      message += "Select a project to link this group to:\n";
    }

    await ctx.reply(message, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: projectButtons,
      },
    });
    return;
  }

  const projectAlias = args[0]!.toLowerCase();
  const projectPath = getProjectByAlias(projectAlias);

  if (!projectPath) {
    await ctx.reply(
      `❌ Unknown project: <code>${projectAlias}</code>\n\n` +
      "Use <code>/projects</code> to see available projects.",
      { parse_mode: "HTML" }
    );
    return;
  }

  // Check if already linked
  const { getGroupLink } = await import("../group-links");
  const existingLink = getGroupLink(chatId);
  if (existingLink) {
    await ctx.reply(
      `⚠️ This group is already linked to <code>${existingLink.projectName}</code>.\n\n` +
      "Use <code>/unlink</code> first to unlink, then link to a different project.",
      { parse_mode: "HTML" }
    );
    return;
  }

  // Generate verification code (6-digit)
  const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

  // Store pending link
  sessionManager.setPendingGroupLink({
    groupId: chatId,
    groupTitle,
    projectName: projectAlias,
    projectPath,
    verificationCode,
    createdAt: new Date(),
    requestedBy: userId,
  });

  // Send verification code to user's DM
  console.log(`[LINK] Generated code ${verificationCode} for group ${chatId} → project ${projectAlias}`);

  try {
    await ctx.api.sendMessage(
      userId,
      `🔐 <b>Group Link Verification</b>\n\n` +
      `You requested to link group <b>${groupTitle}</b> to project <code>${projectAlias}</code>.\n\n` +
      `Verification code:\n` +
      `<code>${verificationCode}</code>\n\n` +
      `<b>Go back to the group and run:</b>\n` +
      `<code>/verify ${verificationCode}</code>\n\n` +
      `<i>Code expires in 10 minutes.</i>`,
      { parse_mode: "HTML" }
    );

    await ctx.reply(
      `✅ <b>Verification code sent to your DM!</b>\n\n` +
      `Use the command shown in your DM to complete the link.`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    console.error("Failed to send verification code:", error);
    sessionManager.clearPendingGroupLink(chatId);
    await ctx.reply(
      `❌ Failed to send verification code to your DM.\n\n` +
      `Make sure you've started a private chat with the bot first (send /start in DM).`
    );
  }
}

/**
 * /verify <code> - Verify group link with 6-digit code.
 */
export async function handleVerify(ctx: Context): Promise<void> {
  console.log(`[VERIFY-CMD] handleVerify called! chatId=${ctx.chat?.id}`);

  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!userId || !chatId) {
    return;
  }

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // Only works in groups
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  if (!isGroup) {
    await ctx.reply(
      "⚠️ The <code>/verify</code> command only works in group chats.",
      { parse_mode: "HTML" }
    );
    return;
  }

  // Parse verification code from command
  const args = ctx.message?.text?.split(/\s+/).slice(1);
  if (!args || args.length === 0) {
    await ctx.reply(
      "❌ Please provide the 6-digit verification code.\n\n" +
      "Usage: <code>/verify 123456</code>",
      { parse_mode: "HTML" }
    );
    return;
  }

  const code = args[0]!.trim();

  // Validate it's 6 digits
  if (!/^\d{6}$/.test(code)) {
    await ctx.reply(
      "❌ Invalid format. Code must be exactly 6 digits.\n\n" +
      "Example: <code>/verify 123456</code>",
      { parse_mode: "HTML" }
    );
    return;
  }

  const pendingLink = sessionManager.getPendingGroupLink(chatId);

  console.log(`[VERIFY] Received code ${code} in group ${chatId} via /verify command`);
  console.log(`[VERIFY] Pending link:`, pendingLink ? `exists for project ${pendingLink.projectName}` : 'not found');

  if (pendingLink) {
    console.log(`[VERIFY] Stored code: ${pendingLink.verificationCode}, received code: ${code}, match: ${pendingLink.verificationCode === code}`);
  }

  if (pendingLink && pendingLink.verificationCode === code) {
    // Valid code - complete the link
    console.log(`[VERIFY] ✅ Code match! Linking group ${chatId} to project ${pendingLink.projectName}`);

    const { setGroupLink } = await import("../group-links");
    setGroupLink(chatId, {
      projectName: pendingLink.projectName,
      projectPath: pendingLink.projectPath,
      linkedAt: new Date().toISOString(),
      linkedBy: userId,
      groupTitle: ctx.chat?.title || "Unknown Group",
    });

    // Clear pending link
    sessionManager.clearPendingGroupLink(chatId);

    // Set this group as the last-used project for this chat
    sessionManager.setLastUsed(chatId, pendingLink.projectName);

    console.log(`[VERIFY] ✅ Link complete! Group ${chatId} → ${pendingLink.projectName}`);

    await ctx.reply(
      `✅ <b>Group successfully linked!</b>\n\n` +
      `Project: <code>${pendingLink.projectName}</code>\n\n` +
      `You can now send messages and files to Claude in this group.`,
      { parse_mode: "HTML" }
    );
  } else if (pendingLink) {
    // Invalid code
    await ctx.reply(
      `❌ Invalid verification code.\n\n` +
      `The code in your DM is different. Please check and try again.\n\n` +
      `<i>Use /link again if the code expired.</i>`,
      { parse_mode: "HTML" }
    );
  } else {
    // No pending link
    await ctx.reply(
      `⚠️ No pending link verification for this group.\n\n` +
      `Use <code>/link &lt;project-name&gt;</code> to start the linking process.`,
      { parse_mode: "HTML" }
    );
  }
}

/**
 * /unlink - Unlink a group chat from its project.
 */
export async function handleUnlink(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!userId || !chatId) {
    return;
  }

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // Only works in groups
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  if (!isGroup) {
    await ctx.reply(
      "⚠️ The <code>/unlink</code> command only works in group chats.",
      { parse_mode: "HTML" }
    );
    return;
  }

  // Check if linked
  const { getGroupLink, removeGroupLink } = await import("../group-links");
  const link = getGroupLink(chatId);

  if (!link) {
    await ctx.reply(
      "⚠️ This group is not linked to any project.\n\n" +
      "Use <code>/link &lt;project-name&gt;</code> to link it.",
      { parse_mode: "HTML" }
    );
    return;
  }

  // Remove link
  removeGroupLink(chatId);

  await ctx.reply(
    `✅ Group unlinked from project <code>${link.projectName}</code>.`,
    { parse_mode: "HTML" }
  );
}

/**
 * /help - Show comprehensive help about bot features and commands.
 */
export async function handleHelp(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const helpText = `
🤖 <b>Claude Telegram Bot - Complete Guide</b>

━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>💬 HOW TO INTERACT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━

<b>Text Messages</b>
• Just send a message to chat with Claude
• Prefix with <code>!</code> to interrupt current query
• Use "think" keyword for extended reasoning

<b>Voice Messages</b>
• Send voice → auto-transcribed → processed
• Enable voice responses with <code>/voice on</code>

<b>Photos</b>
• Send photos for image analysis
• Albums are grouped automatically

<b>Documents</b>
• PDFs: Automatically extracted
• Text files: Parsed and sent to Claude
• <code>/raw filename</code> or <code>/file filename</code> as caption:
  → Saves to project without parsing
  → Claude can read/process manually

<b>Context Features</b>
• ↩️ Reply to a message to include it
• ↪️ Forward messages to analyze them

━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>📁 PROJECT MANAGEMENT</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━

<b>Commands:</b>
<code>/projects</code> - List all projects (buttons)
<code>/project &lt;name&gt;</code> - Switch to project
<code>/project &lt;name&gt; &lt;prompt&gt;</code> - Switch and send prompt
<code>/project /path</code> - Use custom path

<b>Multi-Project Syntax:</b>
<code>@projectname your message</code>
Routes message to specific project without switching

<b>Example:</b>
<code>@mysite check server status</code>
<code>@api-backend run tests</code>

━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>🎮 SESSION COMMANDS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━

<code>/new</code> - Start fresh session
<code>/stop</code> - Stop current query
<code>/status</code> - Show detailed status
<code>/resume</code> - List and resume saved sessions
<code>/retry</code> - Retry last message
<code>/restart</code> - Restart the bot

━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>🔊 VOICE RESPONSES</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━

<code>/voice</code> - Show current status
<code>/voice on</code> - Enable voice responses
<code>/voice off</code> - Disable voice responses
<code>/voice profiles</code> - List voice profiles
<code>/voice profile &lt;id&gt;</code> - Switch profile
<code>/voice language &lt;code&gt;</code> - Set language
<code>/voice status</code> - Check TTS usage stats

<b>Available Profiles:</b>
• default - Professional assistant
• genz - Casual Gen Z style
• pirate - Pirate speak
• robot - Robotic monotone
• storyteller - Narrative style

━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>👥 GROUP CHAT FEATURES</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━

<code>/link &lt;project&gt;</code> - Link group to project
<code>/verify &lt;code&gt;</code> - Verify link (6-digit code)
<code>/unlink</code> - Unlink group from project

<b>How it works:</b>
1. In group: <code>/link myproject</code>
2. Bot sends code to your DM
3. In group: <code>/verify 123456</code>
4. Group now routes to that project

━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>🖥️ SSH HANDOFF</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━

<code>/handoff</code> - Get session takeover info
<code>/tmux</code> - Shared tmux session details

<b>Workflow:</b>
1. Start conversation in Telegram
2. Run <code>/handoff</code>
3. SSH to server, run <code>cr</code>
4. Continue in terminal

━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>⚙️ ADVANCED FEATURES</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━

<b>Token Usage:</b>
<code>/usage</code> - View token stats, costs, rate limits

<b>Long-Running Tasks:</b>
Claude automatically detects long tasks and runs them in background:
• You get notified when complete
• Auto-resumes to analyze results
• Examples: simulations, test suites, builds

<b>Large Responses:</b>
Responses >3,500 chars are saved as files:
• Summary shown in chat
• Full markdown file sent for download
• Stored in <code>.claude-bot/responses/</code>

<b>File Management:</b>
• Raw files: <code>.claude-bot/files/</code>
• Auto-cleanup after 7 days (configurable)

━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>🎯 PRO TIPS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━

• Work on multiple projects concurrently
• Use <code>@project</code> syntax for parallel tasks
• Voice messages work great for quick queries
• Forward code snippets for analysis
• Reply to old messages for context
• Use <code>!</code> prefix to interrupt long queries

━━━━━━━━━━━━━━━━━━━━━━━━━━

<b>Need help with a specific feature?</b>
Try: <code>/start</code> for quick reference
Or: <code>/status</code> for current state
`;

  await ctx.reply(helpText, { parse_mode: "HTML" });
}
