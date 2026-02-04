/**
 * Text message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { exec } from "child_process";
import { promisify } from "util";
import { sessionManager } from "../session-manager";
import type { ProjectSession } from "../project-session";
import { ALLOWED_USERS, setWorkingDir, SHOW_PROJECT_HEADERS, getWorkingDir, resolveProjectPath } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  checkInterrupt,
  startTypingIndicator,
} from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { getProjectAlias, getProjectByAlias } from "../project-aliases";

const execAsync = promisify(exec);

/**
 * Extract context from replied-to or forwarded messages.
 */
function extractMessageContext(ctx: Context): string | null {
  const msg = ctx.message;
  if (!msg) return null;

  const parts: string[] = [];

  // Handle forwarded messages
  if (msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_date) {
    let forwardSource = "unknown";

    // Try to get forward source info
    if (msg.forward_from) {
      forwardSource = msg.forward_from.username
        ? `@${msg.forward_from.username}`
        : `${msg.forward_from.first_name || "User"}`;
    } else if (msg.forward_from_chat) {
      forwardSource = msg.forward_from_chat.title || msg.forward_from_chat.username || "Chat";
    } else if ((msg.forward_origin as any)?.sender_user) {
      const sender = (msg.forward_origin as any).sender_user;
      forwardSource = sender.username ? `@${sender.username}` : sender.first_name || "User";
    } else if ((msg.forward_origin as any)?.chat) {
      forwardSource = (msg.forward_origin as any).chat.title || "Chat";
    }

    // The forwarded content IS the message text itself, so we note the source
    parts.push(`[Forwarded from ${forwardSource}]`);
  }

  // Handle reply to another message
  const replyTo = msg.reply_to_message;
  if (replyTo) {
    const replyFrom = replyTo.from?.username
      ? `@${replyTo.from.username}`
      : replyTo.from?.first_name || "Someone";

    // Get the content of the replied message
    let replyContent = "";
    if (replyTo.text) {
      replyContent = replyTo.text;
    } else if (replyTo.caption) {
      replyContent = `[Media] ${replyTo.caption}`;
    } else if (replyTo.photo) {
      replyContent = "[Photo]";
    } else if (replyTo.document) {
      replyContent = `[Document: ${replyTo.document.file_name || "file"}]`;
    } else if (replyTo.voice) {
      replyContent = "[Voice message]";
    } else {
      replyContent = "[Message]";
    }

    // Truncate if too long
    if (replyContent.length > 500) {
      replyContent = replyContent.slice(0, 497) + "...";
    }

    parts.push(`[Replying to ${replyFrom}]: ${replyContent}`);
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Handle pending GitHub clone flow.
 * Called when user sends a repo name/URL after clicking "Clone from GitHub".
 */
async function handlePendingClone(ctx: Context, input: string, pending: {
  projectName: string;
  projectPath: string;
  chatId: number | undefined;
}): Promise<void> {

  // Parse repo input - accept various formats:
  // - username/repo
  // - https://github.com/username/repo
  // - https://github.com/username/repo.git
  // - git@github.com:username/repo.git
  let repo = input.trim();

  // Extract repo from full URL
  if (repo.includes("github.com")) {
    const match = repo.match(/github\.com[/:]([\w.-]+\/[\w.-]+)/);
    if (match) {
      repo = match[1]!.replace(/\.git$/, "");
    }
  }

  // Validate format
  if (!repo.match(/^[\w.-]+\/[\w.-]+$/)) {
    await ctx.reply(
      `❌ Invalid repository format: <code>${input}</code>\n\n` +
        `Expected: <code>username/repo</code> or GitHub URL`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Start cloning
  const statusMsg = await ctx.reply(
    `🔄 Cloning <code>${repo}</code>...`,
    { parse_mode: "HTML" }
  );

  try {
    // Use gh CLI to clone (handles auth automatically)
    const { stdout, stderr } = await execAsync(
      `gh repo clone ${repo} "${pending.projectPath}"`,
      { timeout: 120000 } // 2 minute timeout
    );

    console.log(`Clone output: ${stdout}`);
    if (stderr) console.log(`Clone stderr: ${stderr}`);

    // Switch to the cloned project
    setWorkingDir(pending.projectPath);
    sessionManager.setCurrentProject(pending.projectName);
    if (pending.chatId) {
      sessionManager.setLastUsed(pending.chatId, pending.projectName);
    }

    // Note: We don't kill any session here because:
    // 1. This is a NEW project, so there's no existing session to kill
    // 2. Killing the global session would affect other projects

    // Update status message
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      `✅ <b>Cloned:</b> <code>${repo}</code>\n\n` +
        `📁 Path: <code>${pending.projectPath}</code>\n\n` +
        `Next message starts fresh in this project.`,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    console.error(`Clone failed:`, error);
    const errorMsg = String(error).slice(0, 200);

    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      `❌ <b>Clone failed:</b>\n<code>${errorMsg}</code>`,
      { parse_mode: "HTML" }
    );
  }
}

/**
 * Handle incoming text messages.
 */
export async function handleText(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  let message = ctx.message?.text;

  if (!userId || !message || !chatId) {
    return;
  }

  // Extract context from reply/forward
  const messageContext = extractMessageContext(ctx);
  if (messageContext) {
    message = `${messageContext}\n\n[Your message]: ${message}`;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 1.4. Parse @project syntax for direct project routing
  // Format: @projectname message (routes message to that project)
  let targetProjectFromAtSyntax: string | null = null;
  const atMatch = message.match(/^@(\S+)\s+(.+)$/s);

  if (atMatch) {
    const [, projectAlias, remainingMessage] = atMatch;

    // Check if this alias exists
    const projectPath = getProjectByAlias(projectAlias!);
    if (projectPath) {
      targetProjectFromAtSyntax = projectAlias!.toLowerCase();
      message = remainingMessage!;

      // Switch to this project
      setWorkingDir(projectPath);
      const pathParts = projectPath.split("/");
      const projName = pathParts[pathParts.length - 1] || "default";
      sessionManager.setCurrentProject(projName);
      sessionManager.setLastUsed(chatId, projName);
    } else {
      // Unknown project alias - warn user and continue with original message
      await ctx.reply(
        `⚠️ Unknown project: <code>@${projectAlias}</code>\n\n` +
          `Use <code>/projects</code> to see available projects.`,
        { parse_mode: "HTML" }
      );
      return;
    }
  }

  // 1.5. Determine target project (from @-syntax, last-used, or default)
  const projectName = targetProjectFromAtSyntax || sessionManager.getLastUsed(chatId) || (() => {
    // Extract project name from current working directory
    const workDir = getWorkingDir();
    const pathParts = workDir.split("/");
    return pathParts[pathParts.length - 1] || "default";
  })();

  // Get or create project session
  const projectSession = await sessionManager.getOrCreateSession(projectName);

  // CRITICAL: Track last-used project IMMEDIATELY so subsequent messages route correctly
  // This ensures that even if this message fails, the next message knows which project to use
  sessionManager.setLastUsed(chatId, projectName);

  // 1.6. Handle pending clone flow (stored per-chat in sessionManager)
  const pendingClone = sessionManager.getPendingClone(chatId);
  if (pendingClone) {
    sessionManager.clearPendingClone(chatId);
    await handlePendingClone(ctx, message, pendingClone);
    return;
  }

  // 2. Check for interrupt prefix (per-project)
  message = await checkInterrupt(message);
  if (!message.trim()) {
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    return;
  }

  // 4. Store message for retry (on project session)
  projectSession.session.lastMessage = message;

  // 5. Set conversation title from first message (if new session)
  if (!projectSession.isActive()) {
    // Truncate title to ~50 chars
    const title =
      message.length > 50 ? message.slice(0, 47) + "..." : message;
    projectSession.session.conversationTitle = title;
  }

  // 6. Show project header based on config (with alias)
  const shouldShowHeader =
    SHOW_PROJECT_HEADERS === "always" ||
    (SHOW_PROJECT_HEADERS === "multiple" && sessionManager.getAllSessions().length > 1);

  // Show project switch notification if using @-syntax
  if (targetProjectFromAtSyntax) {
    const projectAlias = getProjectAlias(projectSession.workingDir);
    await ctx.reply(`📁 <b>${projectAlias}</b>`, { parse_mode: "HTML" });
  } else if (shouldShowHeader && projectName !== "default") {
    const projectAlias = getProjectAlias(projectSession.workingDir);
    await ctx.reply(`<b>${projectAlias}</b>:`, { parse_mode: "HTML" });
  }

  // 7. Mark processing started (on project session)
  const stopProcessing = projectSession.session.startProcessing();

  // 8. Start typing indicator
  const typing = startTypingIndicator(ctx);

  // 9. Create streaming state and callback
  let state = new StreamingState();
  let statusCallback = createStatusCallback(ctx, state);

  // 10. Send to Claude with retry logic for crashes
  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await projectSession.sendMessage(
        message,
        username,
        userId,
        statusCallback,
        chatId,
        ctx
      );

      // 11. Update project activity (lastUsed already set above)
      projectSession.updateActivity();

      // 12. Audit log
      await auditLog(userId, username, "TEXT", message, response);
      break; // Success - exit retry loop
    } catch (error) {
      const errorStr = String(error);
      const isClaudeCodeCrash = errorStr.includes("exited with code");

      // Clean up any partial messages from this attempt
      for (const toolMsg of state.toolMessages) {
        try {
          await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Retry on Claude Code crash (not user cancellation)
      if (isClaudeCodeCrash && attempt < MAX_RETRIES) {
        console.log(
          `Claude Code crashed for ${projectName}, retrying (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`
        );
        await projectSession.kill(); // Clear corrupted session
        await ctx.reply(`⚠️ Claude crashed, retrying...`);
        // Reset state for retry
        state = new StreamingState();
        statusCallback = createStatusCallback(ctx, state);
        continue;
      }

      // Final attempt failed or non-retryable error
      console.error(`Error processing message for ${projectName}:`, error);

      // Check if it was a cancellation
      if (errorStr.includes("abort") || errorStr.includes("cancel")) {
        // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
        const wasInterrupt = projectSession.session.consumeInterruptFlag();
        if (!wasInterrupt) {
          await ctx.reply("🛑 Query stopped.");
        }
      } else {
        await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`);
      }
      break; // Exit loop after handling error
    }
  }

  // 13. Cleanup
  stopProcessing();
  typing.stop();
}
