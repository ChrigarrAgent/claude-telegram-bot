/**
 * Shared helper functions for Claude Telegram Bot.
 *
 * Reduces code duplication across handlers.
 */

import type { Context } from "grammy";
import type { ProjectSession } from "./project-session";
import { sessionManager } from "./session-manager";
import { getWorkingDir } from "./config";
import { StreamingState, createStatusCallback } from "./handlers/streaming";
import { getProjectAlias } from "./project-aliases";

/**
 * Get the project name for a chat, using last-used or deriving from working directory.
 */
export function getProjectNameForChat(chatId: number): string {
  const lastUsed = sessionManager.getLastUsed(chatId);
  console.log(`[getProjectNameForChat] chatId=${chatId}, lastUsed=${lastUsed}`);
  if (lastUsed) return lastUsed;

  const pathParts = getWorkingDir().split("/");
  const fallback = pathParts[pathParts.length - 1] || "default";
  console.log(`[getProjectNameForChat] No lastUsed, falling back to: ${fallback}`);
  return fallback;
}

/**
 * Get or create a project session for a chat, tracking last-used.
 */
export async function getSessionForChat(chatId: number): Promise<ProjectSession> {
  const projectName = getProjectNameForChat(chatId);
  const projectSession = await sessionManager.getOrCreateSession(projectName);
  sessionManager.setLastUsed(chatId, projectName);
  return projectSession;
}

/**
 * Result from sendMessageWithRetry.
 */
export interface SendMessageResult {
  response: string;
  state: StreamingState;
}

/**
 * Send a message to Claude with automatic retry on crashes.
 *
 * Handles the common pattern of:
 * 1. Creating streaming state
 * 2. Sending message
 * 3. Retrying on "exited with code" errors
 * 4. Cleaning up partial messages on failure
 */
export async function sendMessageWithRetry(
  projectSession: ProjectSession,
  message: string,
  username: string,
  userId: number,
  ctx: Context,
  chatId: number,
  maxRetries = 1,
  voiceEnabled = false
): Promise<SendMessageResult> {
  const projectAlias = getProjectAlias(projectSession.workingDir);
  let state = new StreamingState();
  let statusCallback = createStatusCallback(ctx, state, projectAlias, voiceEnabled);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await projectSession.sendMessage(
        message,
        username,
        userId,
        statusCallback,
        chatId,
        ctx
      );
      return { response, state };
    } catch (error) {
      const errorStr = String(error);
      const isClaudeCodeCrash = errorStr.includes("exited with code");

      // Clean up partial messages from this attempt
      for (const toolMsg of state.toolMessages) {
        try {
          await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Retry on Claude Code crash
      if (isClaudeCodeCrash && attempt < maxRetries) {
        console.log(
          `Claude Code crashed, retrying (attempt ${attempt + 2}/${maxRetries + 1})...`
        );
        await projectSession.kill(); // Clear corrupted session
        await ctx.reply(`⚠️ Claude crashed, retrying...`);

        // Reset state for retry
        state = new StreamingState();
        statusCallback = createStatusCallback(ctx, state, projectAlias, voiceEnabled);
        continue;
      }

      // Final attempt failed or non-retryable error
      throw error;
    }
  }

  // Should never reach here, but TypeScript needs this
  throw new Error("Max retries exceeded");
}

/**
 * Handle common error patterns from message processing.
 * Returns true if error was handled (no further action needed).
 */
export async function handleMessageError(
  ctx: Context,
  error: unknown,
  projectSession: ProjectSession
): Promise<boolean> {
  const errorStr = String(error);

  if (errorStr.includes("abort") || errorStr.includes("cancel")) {
    // Check if it was an interrupt from a new message
    const wasInterrupt = projectSession.session.consumeInterruptFlag();
    if (!wasInterrupt) {
      await ctx.reply("🛑 Query stopped.");
    }
    return true;
  }

  // Generic error - show truncated message
  await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`);
  return true;
}
