/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration).
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { session } from "../session";
import { sessionManager } from "../session-manager";
import { ALLOWED_USERS, setWorkingDir, resolveProjectPath } from "../config";
import { isAuthorized } from "../security";
import { auditLog, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { updateSafetyRequest } from "./safety-confirmation";
import { getProjectByAlias, getProjectAlias } from "../project-aliases";

/**
 * Handle callback queries from inline keyboards.
 */
export async function handleCallback(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId || !callbackData) {
    await ctx.answerCallbackQuery();
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.answerCallbackQuery({ text: "Unauthorized" });
    return;
  }

  // 2. Handle resume callbacks: resume:{session_id}
  if (callbackData.startsWith("resume:")) {
    await handleResumeCallback(ctx, callbackData);
    return;
  }

  // 2.5. Handle project callbacks: project:create|clone|cancel:{name}
  if (callbackData.startsWith("project:")) {
    await handleProjectCallback(ctx, callbackData);
    return;
  }

  // 3. Handle safety confirmation callbacks: safety:{request_id}:allow|deny
  if (callbackData.startsWith("safety:")) {
    await handleSafetyCallback(ctx, callbackData);
    return;
  }

  // 4. Parse callback data: askuser:{request_id}:{option_index}
  if (!callbackData.startsWith("askuser:")) {
    await ctx.answerCallbackQuery();
    return;
  }

  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const optionIndex = parseInt(parts[2]!, 10);

  // 3. Load request file
  const requestFile = `/tmp/ask-user-${requestId}.json`;
  let requestData: {
    question: string;
    options: string[];
    status: string;
  };

  try {
    const file = Bun.file(requestFile);
    const text = await file.text();
    requestData = JSON.parse(text);
  } catch (error) {
    console.error(`Failed to load ask-user request ${requestId}:`, error);
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  // 4. Get selected option
  if (optionIndex < 0 || optionIndex >= requestData.options.length) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }

  const selectedOption = requestData.options[optionIndex]!;

  // 5. Update the message to show selection
  try {
    await ctx.editMessageText(`✓ ${selectedOption}`);
  } catch (error) {
    console.debug("Failed to edit callback message:", error);
  }

  // 6. Answer the callback
  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedOption.slice(0, 50)}`,
  });

  // 7. Delete request file
  try {
    unlinkSync(requestFile);
  } catch (error) {
    console.debug("Failed to delete request file:", error);
  }

  // 8. Send the choice to Claude as a message
  const message = selectedOption;

  // Get the project session for this chat
  const projectName = sessionManager.getLastUsed(chatId) || "default";
  const projectSession = await sessionManager.getOrCreateSession(projectName);

  // Interrupt any running query - button responses are always immediate
  if (projectSession.isRunning()) {
    console.log("Interrupting current query for button response");
    await projectSession.session.stop();
    // Small delay to ensure clean interruption
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await projectSession.sendMessage(
      message,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(userId, username, "CALLBACK", message, response);
  } catch (error) {
    console.error("Error processing callback:", error);

    for (const toolMsg of state.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch (error) {
        console.debug("Failed to delete tool message:", error);
      }
    }

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
      const wasInterrupt = projectSession.session.consumeInterruptFlag();
      if (!wasInterrupt) {
        await ctx.reply("🛑 Query stopped.");
      }
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
    }
  } finally {
    typing.stop();
  }
}

/**
 * Handle safety confirmation callback (safety:{request_id}:allow|deny).
 */
async function handleSafetyCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  const decision = parts[2]! as "allow" | "deny";

  // Update the request file
  const updated = await updateSafetyRequest(
    requestId,
    decision === "allow" ? "allowed" : "denied"
  );

  if (!updated) {
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  // Update the message to show decision
  const emoji = decision === "allow" ? "✅" : "❌";
  const action = decision === "allow" ? "Allowed" : "Blocked";
  try {
    await ctx.editMessageText(`${emoji} ${action} by user`);
  } catch (error) {
    console.debug("Failed to edit safety callback message:", error);
  }

  await ctx.answerCallbackQuery({
    text: `Operation ${action.toLowerCase()}`,
  });
}

/**
 * Handle resume session callback (resume:{session_id}:{project_name}).
 */
async function handleResumeCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;

  // Parse callback data: resume:{session_id}:{project_name}
  const parts = callbackData.split(":");
  const sessionId = parts[1];
  const projectName = parts[2] || "default";

  if (!sessionId || !userId || !chatId) {
    await ctx.answerCallbackQuery({ text: "Invalid session ID" });
    return;
  }

  // Get or create project session
  const projectSession = await sessionManager.getOrCreateSession(projectName);

  // Check if session is already active
  if (projectSession.isActive()) {
    await ctx.answerCallbackQuery({ text: "Session already active for this project" });
    return;
  }

  // ALWAYS switch to the project's working directory when resuming
  // This ensures messages are routed to the correct folder
  const projectPath = resolveProjectPath(projectName);
  setWorkingDir(projectPath);
  sessionManager.setCurrentProject(projectName);
  if (chatId) {
    sessionManager.setLastUsed(chatId, projectName);
  }

  // Resume the selected session
  const [success, message] = projectSession.session.resumeSession(sessionId);

  if (!success) {
    await ctx.answerCallbackQuery({ text: message, show_alert: true });
    return;
  }

  // Update the original message to show selection
  try {
    await ctx.editMessageText(`✅ ${message}\n📁 Project: ${projectName}`);
  } catch (error) {
    console.debug("Failed to edit resume message:", error);
  }
  await ctx.answerCallbackQuery({ text: "Session resumed!" });

  // Send a hidden recap prompt to Claude
  const recapPrompt =
    "Please write a very concise recap of where we are in this conversation, to refresh my memory. Max 2-3 sentences.";

  const typing = startTypingIndicator(ctx);
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    await projectSession.sendMessage(
      recapPrompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );
  } catch (error) {
    console.error("Error getting recap:", error);
    // Don't show error to user - session is still resumed, recap just failed
  } finally {
    typing.stop();
  }
}

/**
 * Handle project callbacks: project:switch|create|clone|cancel:{name}
 */
async function handleProjectCallback(
  ctx: Context,
  callbackData: string
): Promise<void> {
  const chatId = ctx.chat?.id;
  const parts = callbackData.split(":");
  const action = parts[1]; // switch, create, clone, or cancel
  const projectName = parts[2]; // project name or alias

  if (action === "cancel") {
    try {
      await ctx.editMessageText("❌ Cancelled.");
    } catch (error) {
      console.debug("Failed to edit project callback message:", error);
    }
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    return;
  }

  // Handle "switch" action from /projects command buttons
  if (action === "switch" && projectName) {
    // Look up the project path from alias
    const projectPath = getProjectByAlias(projectName);

    if (!projectPath) {
      await ctx.answerCallbackQuery({ text: "Project not found", show_alert: true });
      return;
    }

    // Extract project name from path for session manager
    const pathParts = projectPath.split("/");
    const projName = pathParts[pathParts.length - 1] || "default";

    // Switch to the project
    setWorkingDir(projectPath);
    sessionManager.setCurrentProject(projName);

    if (chatId) {
      sessionManager.setLastUsed(chatId, projName);
    }

    // Get alias for display
    const alias = getProjectAlias(projectPath);

    try {
      await ctx.editMessageText(
        `✅ <b>Switched to: ${alias}</b>\n\n` +
          `<code>${projectPath}</code>\n\n` +
          `Send a message to start working.`,
        { parse_mode: "HTML" }
      );
    } catch (error) {
      console.debug("Failed to edit project switch message:", error);
    }

    await ctx.answerCallbackQuery({ text: `Switched to ${alias}` });
    return;
  }

  // Handle "create:new" action from /projects "Create New Project" button
  if (action === "create" && projectName === "new") {
    try {
      await ctx.editMessageText(
        `➕ <b>Create New Project</b>\n\n` +
          `To create a new project, use:\n` +
          `<code>/project /path/to/new-project</code>\n\n` +
          `Example:\n` +
          `<code>/project /home/ubuntu/Projects/my-app</code>`,
        { parse_mode: "HTML" }
      );
    } catch (error) {
      console.debug("Failed to edit create message:", error);
    }
    await ctx.answerCallbackQuery({ text: "See instructions above" });
    return;
  }

  if (!projectName) {
    await ctx.answerCallbackQuery({ text: "Invalid project name", show_alert: true });
    return;
  }

  const projectPath = `/home/ubuntu/Projects/${projectName}`;

  if (action === "create") {
    // Create empty project directory
    try {
      const { mkdirSync } = await import("fs");
      mkdirSync(projectPath, { recursive: true });

      // Switch to the new project
      setWorkingDir(projectPath);
      sessionManager.setCurrentProject(projectName);
      if (chatId) {
        sessionManager.setLastUsed(chatId, projectName);
      }

      // Note: We don't kill any session here because:
      // 1. This is a NEW project, so there's no existing session to kill
      // 2. Killing the global session would affect other projects
      // The next message will create a fresh session for this new project

      await ctx.editMessageText(
        `✅ <b>Created project:</b> <code>${projectName}</code>\n\n` +
          `📁 Path: <code>${projectPath}</code>\n\n` +
          `Next message starts fresh in this project.`,
        { parse_mode: "HTML" }
      );
      await ctx.answerCallbackQuery({ text: "Project created!" });
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: `Failed to create: ${error}`,
        show_alert: true,
      });
    }
    return;
  }

  if (action === "clone") {
    // Ask for the GitHub repo URL/name
    try {
      await ctx.editMessageText(
        `🐙 <b>Clone from GitHub</b>\n\n` +
          `Send the repository (one of these formats):\n` +
          `• <code>username/repo</code>\n` +
          `• <code>https://github.com/username/repo</code>\n\n` +
          `The repo will be cloned to:\n` +
          `<code>${projectPath}</code>`,
        { parse_mode: "HTML" }
      );
      await ctx.answerCallbackQuery({ text: "Send the repo name..." });

      // Store pending clone state in sessionManager (per-chat, not per-session)
      // This prevents cross-chat leakage when multiple users use the bot
      if (chatId) {
        sessionManager.setPendingClone(chatId, {
          projectName,
          projectPath,
          chatId,
        });
      }
    } catch (error) {
      await ctx.answerCallbackQuery({
        text: `Error: ${error}`,
        show_alert: true,
      });
    }
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action" });
}
