/**
 * Factory for creating test bot instances.
 *
 * Creates a grammy Bot with all handlers registered but doesn't start polling
 * or run startup logic. Use with TestBot wrapper for injecting fake messages.
 */

import { Bot } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import { sessionManager } from "../../src/session-manager";
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
} from "../../src/handlers";

/**
 * Create a bot instance configured with all handlers.
 * Does NOT start polling or run startup initialization.
 */
export function createTestBot(): Bot {
  // Provide botInfo directly to avoid calling getMe()
  const bot = new Bot("test-token-12345", {
    botInfo: {
      id: 123456789,
      is_bot: true,
      first_name: "TestBot",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    },
  });

  // Treat slash commands from forwarded messages as regular text
  bot.use(async (ctx, next) => {
    const msg = ctx.message;
    if (msg?.text?.startsWith("/")) {
      const isForwarded = !!(msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_date);
      if (isForwarded) {
        await handleText(ctx);
        return;
      }
    }
    await next();
  });

  // Sequentialize non-command messages per (chat, project)
  bot.use(
    sequentialize((ctx) => {
      if (ctx.message?.text?.startsWith("/")) return undefined;
      if (ctx.message?.text?.startsWith("!")) return undefined;
      if (ctx.callbackQuery) return undefined;

      const chatId = ctx.chat?.id;
      if (!chatId) return undefined;

      const projectName = sessionManager.getLastUsed(chatId) || 'default';
      return `${chatId}:${projectName}`;
    })
  );

  // Command handlers
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

  // Message handlers
  bot.on("message:text", handleText);
  bot.on("message:voice", handleVoice);
  bot.on("message:photo", handlePhoto);
  bot.on("message:document", handleDocument);

  // Callback queries
  bot.on("callback_query:data", handleCallback);

  // Error handler
  bot.catch((err) => {
    console.error("Test bot error:", err);
  });

  return bot;
}
