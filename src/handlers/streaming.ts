/**
 * Shared streaming callback for Claude Telegram Bot handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { InlineKeyboard } from "grammy";
import type { StatusCallback, StatusType } from "../types";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_LIMIT,
  STREAMING_THROTTLE_MS,
  BUTTON_LABEL_MAX_LENGTH,
} from "../config";

/**
 * Create inline keyboard for ask_user options.
 */
export function createAskUserKeyboard(
  requestId: string,
  options: string[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let idx = 0; idx < options.length; idx++) {
    const option = options[idx]!;
    // Truncate long options for button display
    const display =
      option.length > BUTTON_LABEL_MAX_LENGTH
        ? option.slice(0, BUTTON_LABEL_MAX_LENGTH) + "..."
        : option;
    const callbackData = `askuser:${requestId}:${idx}`;
    keyboard.text(display, callbackData).row();
  }
  return keyboard;
}

/**
 * Check for pending ask-user requests and send inline keyboards.
 */
export async function checkPendingAskUserRequests(
  ctx: Context,
  chatId: number
): Promise<boolean> {
  const glob = new Bun.Glob("ask-user-*.json");
  let buttonsSent = false;

  for await (const filename of glob.scan({ cwd: "/tmp", absolute: false })) {
    const filepath = `/tmp/${filename}`;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      // Only process pending requests for this chat
      if (data.status !== "pending") continue;
      if (String(data.chat_id) !== String(chatId)) continue;

      const question = data.question || "Please choose:";
      const options = data.options || [];
      const requestId = data.request_id || "";

      if (options.length > 0 && requestId) {
        const keyboard = createAskUserKeyboard(requestId, options);
        await ctx.reply(`❓ ${question}`, { reply_markup: keyboard });
        buttonsSent = true;

        // Mark as sent
        data.status = "sent";
        await Bun.write(filepath, JSON.stringify(data));
      }
    } catch (error) {
      console.warn(`Failed to process ask-user file ${filepath}:`, error);
    }
  }

  return buttonsSent;
}

/**
 * Tracks state for streaming message updates.
 */
export class StreamingState {
  // Consolidated streaming: ONE working message for all progress
  workingMessage: Message | null = null; // The single live-edited progress message
  workingContent: string[] = []; // Accumulated content (thinking, tools, progress)
  lastEditTime: number = 0; // Last edit time for throttling
  finalTextSegments: string[] = []; // Final text segments to send as separate message

  // Legacy fields for backward compatibility (not used in consolidated mode)
  textMessages = new Map<number, Message>();
  toolMessages: Message[] = [];
  lastEditTimes = new Map<number, number>();
  lastContent = new Map<number, string>();
  prefixAdded = false;
}

/**
 * Create a status callback for streaming updates - CONSOLIDATED MODE.
 * All progress (thinking, tools, intermediate text) goes into ONE live-edited message.
 * Final answer is sent as a separate clean message.
 */
export function createStatusCallback(
  ctx: Context,
  state: StreamingState,
  projectAlias: string = "default"
): StatusCallback {
  return async (statusType: StatusType, content: string, segmentId?: number) => {
    try {
      const now = Date.now();

      // Create working message on first event
      if (!state.workingMessage) {
        state.workingMessage = await ctx.reply(
          `🔄 <b>${projectAlias}:</b> Working...`,
          { parse_mode: "HTML" }
        );
      }

      if (statusType === "thinking") {
        // Add thinking to working content
        const preview = content.length > 400 ? content.slice(0, 400) + "..." : content;
        const escaped = escapeHtml(preview);
        state.workingContent.push(`🧠 <i>${escaped}</i>`);

        // Update working message (throttled)
        if (now - state.lastEditTime > STREAMING_THROTTLE_MS) {
          await updateWorkingMessage(ctx, state, projectAlias);
        }
      } else if (statusType === "tool") {
        // Add tool to working content (already has HTML)
        state.workingContent.push(content);

        // Update working message (throttled)
        if (now - state.lastEditTime > STREAMING_THROTTLE_MS) {
          await updateWorkingMessage(ctx, state, projectAlias);
        }
      } else if (statusType === "text" && segmentId !== undefined) {
        // Intermediate text - add to working content with truncation
        const preview = content.length > 300 ? content.slice(0, 300) + "..." : content;
        const escaped = escapeHtml(preview);
        state.workingContent.push(`📝 ${escaped}`);

        // Update working message (throttled)
        if (now - state.lastEditTime > STREAMING_THROTTLE_MS) {
          await updateWorkingMessage(ctx, state, projectAlias);
        }
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        // Store final text segment for later
        if (content) {
          state.finalTextSegments.push(content);
        }
      } else if (statusType === "done") {
        // Send final answer as separate clean message
        if (state.finalTextSegments.length > 0) {
          const finalText = state.finalTextSegments.join("\n\n");
          const htmlContent = convertMarkdownToHtml(finalText);
          const formatted = `<b>${projectAlias}:</b> ${htmlContent}`;

          try {
            await ctx.reply(formatted, { parse_mode: "HTML" });
          } catch (htmlError) {
            console.debug("HTML reply failed for final answer, escaping:", htmlError);
            const escaped = escapeHtml(finalText);
            await ctx.reply(`<b>${projectAlias}:</b> ${escaped}`, { parse_mode: "HTML" });
          }
        }

        // Update working message one last time with "Complete" status
        state.workingContent.push("✅ <b>Complete</b>");
        await updateWorkingMessage(ctx, state, projectAlias);
      }
    } catch (error) {
      console.error("Status callback error:", error);
    }
  };
}

/**
 * Helper function to update the working message with accumulated content.
 */
async function updateWorkingMessage(
  ctx: Context,
  state: StreamingState,
  projectAlias: string
): Promise<void> {
  if (!state.workingMessage) return;

  const content = state.workingContent.join("\n\n");
  const fullMessage = `🔄 <b>${projectAlias}:</b> Working...\n\n${content}`;

  // Truncate if too long (Telegram limit)
  const truncated = fullMessage.length > TELEGRAM_MESSAGE_LIMIT
    ? fullMessage.slice(0, TELEGRAM_MESSAGE_LIMIT - 100) + "\n\n<i>... (truncated)</i>"
    : fullMessage;

  try {
    await ctx.api.editMessageText(
      state.workingMessage.chat.id,
      state.workingMessage.message_id,
      truncated,
      { parse_mode: "HTML" }
    );
    state.lastEditTime = Date.now();
  } catch (error) {
    console.debug("Failed to update working message:", error);
  }
}

// Legacy callback for backward compatibility - keeping old implementation below
function createLegacyStatusCallback(
  ctx: Context,
  state: StreamingState,
  projectAlias: string = "default"
): StatusCallback {
  return async (statusType: StatusType, content: string, segmentId?: number) => {
    try {
      if (statusType === "thinking") {
        // Show thinking inline, compact (first 500 chars)
        const preview =
          content.length > 500 ? content.slice(0, 500) + "..." : content;
        const escaped = escapeHtml(preview);
        const thinkingMsg = await ctx.reply(`<b>${projectAlias}:</b> 🧠 <i>${escaped}</i>`, {
          parse_mode: "HTML",
        });
        state.toolMessages.push(thinkingMsg);
      } else if (statusType === "tool") {
        // Add project prefix to tool messages
        const toolContent = `<b>${projectAlias}:</b> ${content}`;
        const toolMsg = await ctx.reply(toolContent, { parse_mode: "HTML" });
        state.toolMessages.push(toolMsg);
      } else if (statusType === "text" && segmentId !== undefined) {
        const now = Date.now();
        const lastEdit = state.lastEditTimes.get(segmentId) || 0;

        if (!state.textMessages.has(segmentId)) {
          // New segment - create message
          // First truncate if needed
          const display =
            content.length > TELEGRAM_SAFE_LIMIT
              ? content.slice(0, TELEGRAM_SAFE_LIMIT) + "..."
              : content;
          // Convert markdown to HTML first
          const htmlContent = convertMarkdownToHtml(display);
          // Then add project prefix (won't be escaped)
          const formatted = `<b>${projectAlias}:</b> ${htmlContent}`;
          try {
            const msg = await ctx.reply(formatted, { parse_mode: "HTML" });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          } catch (htmlError) {
            // HTML parse failed - escape the original content and retry with HTML mode
            console.debug("HTML reply failed, escaping and retrying:", htmlError);
            const escaped = escapeHtml(display);
            const fallback = `<b>${projectAlias}:</b> ${escaped}`;
            const msg = await ctx.reply(fallback, { parse_mode: "HTML" });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, fallback);
          }
          state.lastEditTimes.set(segmentId, now);
        } else if (now - lastEdit > STREAMING_THROTTLE_MS) {
          // Update existing segment message (throttled)
          const msg = state.textMessages.get(segmentId)!;
          // First truncate if needed
          const display =
            content.length > TELEGRAM_SAFE_LIMIT
              ? content.slice(0, TELEGRAM_SAFE_LIMIT) + "..."
              : content;
          // Convert markdown to HTML first
          const htmlContent = convertMarkdownToHtml(display);
          // Then add project prefix (won't be escaped)
          const formatted = `<b>${projectAlias}:</b> ${htmlContent}`;
          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }
          try {
            await ctx.api.editMessageText(
              msg.chat.id,
              msg.message_id,
              formatted,
              {
                parse_mode: "HTML",
              }
            );
            state.lastContent.set(segmentId, formatted);
          } catch (htmlError) {
            console.debug("HTML edit failed, escaping and retrying:", htmlError);
            try {
              // Escape the original content and retry with HTML mode
              const escaped = escapeHtml(display);
              const fallback = `<b>${projectAlias}:</b> ${escaped}`;
              await ctx.api.editMessageText(
                msg.chat.id,
                msg.message_id,
                fallback,
                { parse_mode: "HTML" }
              );
              state.lastContent.set(segmentId, fallback);
            } catch (editError) {
              console.debug("Edit message failed completely:", editError);
            }
          }
          state.lastEditTimes.set(segmentId, now);
        }
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        if (state.textMessages.has(segmentId) && content) {
          const msg = state.textMessages.get(segmentId)!;
          // Convert markdown to HTML first
          const htmlContent = convertMarkdownToHtml(content);
          // Then add project prefix (won't be escaped)
          const formatted = `<b>${projectAlias}:</b> ${htmlContent}`;

          // Skip if content unchanged
          if (formatted === state.lastContent.get(segmentId)) {
            return;
          }

          if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
            try {
              await ctx.api.editMessageText(
                msg.chat.id,
                msg.message_id,
                formatted,
                {
                  parse_mode: "HTML",
                }
              );
            } catch (error) {
              console.debug("Failed to edit final message:", error);
            }
          } else {
            // Too long - delete and split
            try {
              await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
            } catch (error) {
              console.debug("Failed to delete message for splitting:", error);
            }
            for (let i = 0; i < formatted.length; i += TELEGRAM_SAFE_LIMIT) {
              const chunk = formatted.slice(i, i + TELEGRAM_SAFE_LIMIT);
              try {
                await ctx.reply(chunk, { parse_mode: "HTML" });
              } catch (htmlError) {
                console.debug(
                  "HTML chunk failed, escaping and retrying:",
                  htmlError
                );
                // Escape and retry with HTML mode
                const chunkText = chunk.replace(/<b>.*?:<\/b>\s*/, ''); // Remove prefix temporarily
                const escaped = escapeHtml(chunkText);
                const fallback = i === 0 ? `<b>${projectAlias}:</b> ${escaped}` : escaped;
                await ctx.reply(fallback, { parse_mode: "HTML" });
              }
            }
          }
        }
      } else if (statusType === "done") {
        // Delete tool messages - text messages stay
        for (const toolMsg of state.toolMessages) {
          try {
            await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
          } catch (error) {
            console.debug("Failed to delete tool message:", error);
          }
        }
      }
    } catch (error) {
      console.error("Status callback error:", error);
    }
  };
}
