/**
 * Shared streaming callback for Claude Telegram Bot handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import type { Context } from "grammy";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import { InlineKeyboard, InputFile } from "grammy";
import type { StatusCallback, StatusType } from "../types";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_LIMIT,
  STREAMING_THROTTLE_MS,
  BUTTON_LABEL_MAX_LENGTH,
} from "../config";

/**
 * Send a long message, splitting into multiple messages if needed.
 * Handles Telegram's 4096 character limit gracefully.
 */
async function sendLongMessage(
  ctx: Context,
  text: string,
  projectAlias: string
): Promise<void> {
  const htmlContent = convertMarkdownToHtml(text);
  const prefix = `<b>${projectAlias}:</b> `;
  const formatted = prefix + htmlContent;

  // If it fits in one message, send it
  if (formatted.length <= TELEGRAM_SAFE_LIMIT) {
    try {
      await ctx.reply(formatted, { parse_mode: "HTML" });
      return;
    } catch (htmlError: any) {
      // If HTML fails (not length), try escaped
      if (!htmlError?.description?.includes("too long")) {
        console.warn("HTML reply failed, escaping:", htmlError?.description);
        const escaped = escapeHtml(text);
        const fallback = prefix + escaped;
        if (fallback.length <= TELEGRAM_SAFE_LIMIT) {
          await ctx.reply(fallback, { parse_mode: "HTML" });
          return;
        }
      }
      // Fall through to splitting
    }
  }

  // Message is too long - split it
  // Split by double newlines (paragraphs) first for cleaner breaks
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    const testChunk = currentChunk ? currentChunk + "\n\n" + para : para;
    // Leave room for prefix on first chunk and some buffer
    const maxLen = chunks.length === 0 ? TELEGRAM_SAFE_LIMIT - prefix.length - 50 : TELEGRAM_SAFE_LIMIT - 50;

    if (testChunk.length <= maxLen) {
      currentChunk = testChunk;
    } else {
      // Current chunk is full, save it
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      // If this paragraph itself is too long, split it by lines
      if (para.length > maxLen) {
        const lines = para.split("\n");
        currentChunk = "";
        for (const line of lines) {
          const testLine = currentChunk ? currentChunk + "\n" + line : line;
          if (testLine.length <= maxLen) {
            currentChunk = testLine;
          } else {
            if (currentChunk) chunks.push(currentChunk);
            // If single line is too long, hard split
            if (line.length > maxLen) {
              for (let i = 0; i < line.length; i += maxLen) {
                chunks.push(line.slice(i, i + maxLen));
              }
              currentChunk = "";
            } else {
              currentChunk = line;
            }
          }
        }
      } else {
        currentChunk = para;
      }
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk);
  }

  // Send each chunk
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const isFirst = i === 0;
    const chunkPrefix = isFirst ? prefix : "";
    const partIndicator = chunks.length > 1 ? ` <i>(${i + 1}/${chunks.length})</i>` : "";

    try {
      const htmlChunk = convertMarkdownToHtml(chunk);
      await ctx.reply(chunkPrefix + htmlChunk + partIndicator, { parse_mode: "HTML" });
    } catch (htmlError) {
      // Fallback to escaped text
      const escaped = escapeHtml(chunk);
      await ctx.reply(chunkPrefix + escaped + partIndicator, { parse_mode: "HTML" });
    }

    // Small delay between chunks to maintain order
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

/**
 * Send a voice message for the given text.
 * Fails gracefully if TTS unavailable or errors occur.
 */
async function sendVoiceMessage(ctx: Context, text: string): Promise<void> {
  try {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const { getVoiceProfile } = await import("../chat-settings");
    const { synthesizeVoice } = await import("../utils");

    const profileId = getVoiceProfile(chatId);
    const audioBuffer = await synthesizeVoice(text, profileId);

    if (!audioBuffer) {
      console.warn("Voice synthesis failed, skipping voice message");
      return;
    }

    // Send voice message via Telegram
    await ctx.replyWithVoice(
      new InputFile(audioBuffer, "response.ogg"),
      { caption: "🔊 Voice response" }
    );
  } catch (error) {
    console.error("Failed to send voice message:", error);
    // Fail silently - text message was already sent successfully
  }
}

/**
 * Send a voice message via Bot API (no ctx needed).
 */
async function sendVoiceMessageViaApi(
  api: Api,
  chatId: number,
  text: string
): Promise<void> {
  try {
    const { getVoiceProfile } = await import("../chat-settings");
    const { synthesizeVoice } = await import("../utils");

    const profileId = getVoiceProfile(chatId);
    const audioBuffer = await synthesizeVoice(text, profileId);

    if (!audioBuffer) {
      console.warn("Voice synthesis failed, skipping voice message");
      return;
    }

    await api.sendVoice(
      chatId,
      new InputFile(audioBuffer, "response.ogg"),
      { caption: "🔊 Voice response" }
    );
  } catch (error) {
    console.error("Failed to send voice message via API:", error);
  }
}

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
  projectAlias: string = "default",
  voiceEnabled: boolean = false
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
        // Show thinking preview (first ~300 chars) so user can see what Claude is working on
        const preview = content.length > 300 ? content.slice(0, 300) + "..." : content;
        const escaped = escapeHtml(preview);
        state.workingContent.push(`🧠 <i>${escaped}</i>`);
        // Update working message
        await updateWorkingMessage(ctx, state, projectAlias);
      } else if (statusType === "tool") {
        // Any previously accumulated text segments were intermediate reasoning
        // (text before tool calls = Claude thinking out loud, not the final answer)
        // Clear them so only text after the last tool call becomes the final message
        if (state.finalTextSegments.length > 0) {
          state.finalTextSegments = [];
        }

        // Add tool to working content (already has HTML)
        state.workingContent.push(content);

        // Force update on every tool event (important for visibility)
        await updateWorkingMessage(ctx, state, projectAlias);
      } else if (statusType === "text" && segmentId !== undefined) {
        // Intermediate text - skip adding to working message
        // (it clutters the progress view and the final answer will show it)
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        // Store final text segment for later
        if (content) {
          state.finalTextSegments.push(content);
        }
      } else if (statusType === "done") {
        // First update working message with "Complete" status
        state.workingContent.push("✅ <b>Complete</b>");
        await updateWorkingMessage(ctx, state, projectAlias);

        // Then send final answer as separate clean message(s)
        if (state.finalTextSegments.length > 0) {
          const finalText = state.finalTextSegments.join("\n\n");
          await sendLongMessage(ctx, finalText, projectAlias);

          // Voice mode - synthesize and send voice message
          if (voiceEnabled) {
            await sendVoiceMessage(ctx, finalText);
          }
        }
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

  const content = state.workingContent.join("\n");
  const fullMessage = `🔄 <b>${projectAlias}:</b>\n${content}`;

  // Truncate if too long (Telegram limit) - keep recent items
  let truncated = fullMessage;
  if (fullMessage.length > TELEGRAM_MESSAGE_LIMIT) {
    // Keep header and last items (most recent progress)
    const header = `🔄 <b>${projectAlias}:</b>\n<i>... earlier progress truncated ...</i>\n`;
    const availableSpace = TELEGRAM_MESSAGE_LIMIT - header.length - 50;

    // Take last N items that fit
    const items = state.workingContent.slice();
    let kept: string[] = [];
    let totalLen = 0;

    for (let i = items.length - 1; i >= 0 && totalLen < availableSpace; i--) {
      const item = items[i]!;
      if (totalLen + item.length + 1 <= availableSpace) {
        kept.unshift(item);
        totalLen += item.length + 1;
      } else {
        break;
      }
    }

    truncated = header + kept.join("\n");
  }

  try {
    await ctx.api.editMessageText(
      state.workingMessage.chat.id,
      state.workingMessage.message_id,
      truncated,
      { parse_mode: "HTML" }
    );
    state.lastEditTime = Date.now();
  } catch (error: any) {
    // Don't log "message is not modified" errors - that's expected
    if (!error?.description?.includes("message is not modified")) {
      console.warn("Failed to update working message:", error?.description || error);
    }
  }
}

/**
 * Send a long message via Bot API (no ctx needed), splitting if necessary.
 */
async function sendLongMessageViaApi(
  api: Api,
  chatId: number,
  text: string,
  projectAlias: string
): Promise<void> {
  const htmlContent = convertMarkdownToHtml(text);
  const prefix = `<b>${projectAlias}:</b> `;
  const formatted = prefix + htmlContent;

  if (formatted.length <= TELEGRAM_SAFE_LIMIT) {
    try {
      await api.sendMessage(chatId, formatted, { parse_mode: "HTML" });
      return;
    } catch (htmlError: any) {
      if (!htmlError?.description?.includes("too long")) {
        console.warn("HTML reply failed, escaping:", htmlError?.description);
        const escaped = escapeHtml(text);
        const fallback = prefix + escaped;
        if (fallback.length <= TELEGRAM_SAFE_LIMIT) {
          await api.sendMessage(chatId, fallback, { parse_mode: "HTML" });
          return;
        }
      }
    }
  }

  // Message is too long - split it
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    const testChunk = currentChunk ? currentChunk + "\n\n" + para : para;
    const maxLen = chunks.length === 0 ? TELEGRAM_SAFE_LIMIT - prefix.length - 50 : TELEGRAM_SAFE_LIMIT - 50;

    if (testChunk.length <= maxLen) {
      currentChunk = testChunk;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      if (para.length > maxLen) {
        const lines = para.split("\n");
        currentChunk = "";
        for (const line of lines) {
          const testLine = currentChunk ? currentChunk + "\n" + line : line;
          if (testLine.length <= maxLen) {
            currentChunk = testLine;
          } else {
            if (currentChunk) chunks.push(currentChunk);
            if (line.length > maxLen) {
              for (let i = 0; i < line.length; i += maxLen) {
                chunks.push(line.slice(i, i + maxLen));
              }
              currentChunk = "";
            } else {
              currentChunk = line;
            }
          }
        }
      } else {
        currentChunk = para;
      }
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk);
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const isFirst = i === 0;
    const chunkPrefix = isFirst ? prefix : "";
    const partIndicator = chunks.length > 1 ? ` <i>(${i + 1}/${chunks.length})</i>` : "";

    try {
      const htmlChunk = convertMarkdownToHtml(chunk);
      await api.sendMessage(chatId, chunkPrefix + htmlChunk + partIndicator, { parse_mode: "HTML" });
    } catch (htmlError) {
      const escaped = escapeHtml(chunk);
      await api.sendMessage(chatId, chunkPrefix + escaped + partIndicator, { parse_mode: "HTML" });
    }

    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

/**
 * Create a consolidated status callback using Bot API directly (no ctx needed).
 * Used for auto-continue after restart and process completion handlers.
 * Mirrors createStatusCallback behavior: one working message for progress,
 * final answer sent as separate message.
 */
export function createBotApiStatusCallback(
  api: Api,
  chatId: number,
  projectAlias: string = "default",
  voiceEnabled: boolean = false
): StatusCallback {
  const state = new StreamingState();

  return async (statusType: StatusType, content: string, segmentId?: number) => {
    try {
      // Create working message on first event
      if (!state.workingMessage) {
        state.workingMessage = await api.sendMessage(
          chatId,
          `🔄 <b>${projectAlias}:</b> Working...`,
          { parse_mode: "HTML" }
        );
      }

      if (statusType === "thinking") {
        const preview = content.length > 300 ? content.slice(0, 300) + "..." : content;
        const escaped = escapeHtml(preview);
        state.workingContent.push(`🧠 <i>${escaped}</i>`);
        await updateWorkingMessageViaApi(api, chatId, state, projectAlias);
      } else if (statusType === "tool") {
        if (state.finalTextSegments.length > 0) {
          state.finalTextSegments = [];
        }
        state.workingContent.push(content);
        await updateWorkingMessageViaApi(api, chatId, state, projectAlias);
      } else if (statusType === "text" && segmentId !== undefined) {
        // Intermediate text - skip (same as consolidated mode)
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        if (content) {
          state.finalTextSegments.push(content);
        }
      } else if (statusType === "done") {
        state.workingContent.push("✅ <b>Complete</b>");
        await updateWorkingMessageViaApi(api, chatId, state, projectAlias);

        if (state.finalTextSegments.length > 0) {
          const finalText = state.finalTextSegments.join("\n\n");
          await sendLongMessageViaApi(api, chatId, finalText, projectAlias);

          // Voice mode - synthesize and send voice message
          if (voiceEnabled) {
            await sendVoiceMessageViaApi(api, chatId, finalText);
          }
        }
      }
    } catch (error) {
      console.error("Bot API status callback error:", error);
    }
  };
}

/**
 * Helper to update the working message via Bot API (no ctx needed).
 */
async function updateWorkingMessageViaApi(
  api: Api,
  chatId: number,
  state: StreamingState,
  projectAlias: string
): Promise<void> {
  if (!state.workingMessage) return;

  const content = state.workingContent.join("\n");
  const fullMessage = `🔄 <b>${projectAlias}:</b>\n${content}`;

  let truncated = fullMessage;
  if (fullMessage.length > TELEGRAM_MESSAGE_LIMIT) {
    const header = `🔄 <b>${projectAlias}:</b>\n<i>... earlier progress truncated ...</i>\n`;
    const availableSpace = TELEGRAM_MESSAGE_LIMIT - header.length - 50;

    const items = state.workingContent.slice();
    let kept: string[] = [];
    let totalLen = 0;

    for (let i = items.length - 1; i >= 0 && totalLen < availableSpace; i--) {
      const item = items[i]!;
      if (totalLen + item.length + 1 <= availableSpace) {
        kept.unshift(item);
        totalLen += item.length + 1;
      } else {
        break;
      }
    }

    truncated = header + kept.join("\n");
  }

  try {
    await api.editMessageText(
      chatId,
      state.workingMessage.message_id,
      truncated,
      { parse_mode: "HTML" }
    );
    state.lastEditTime = Date.now();
  } catch (error: any) {
    if (!error?.description?.includes("message is not modified")) {
      console.warn("Failed to update working message:", error?.description || error);
    }
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
