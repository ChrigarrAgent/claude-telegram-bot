/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { TELEGRAM_TOKEN, WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "./config";
import { sessionManager } from "./session-manager";
import { unlinkSync, readFileSync, existsSync } from "fs";
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
} from "./handlers";

// Create bot instance
const bot = new Bot(TELEGRAM_TOKEN);

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

    // Get last-used project for this chat (defaults to 'default' if none)
    const projectName = sessionManager.getLastUsed(chatId) || 'default';

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

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Claude Telegram Bot - TypeScript Edition");
console.log("=".repeat(50));
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);
console.log("Starting bot...");

// Get bot info first
const botInfo = await bot.api.getMe();
console.log(`Bot started: @${botInfo.username}`);

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

// Start with concurrent runner (commands work immediately)
const runner = run(bot);

// Graceful shutdown
const stopRunner = () => {
  if (runner.isRunning()) {
    console.log("Stopping bot...");
    runner.stop();
  }
};

process.on("SIGINT", () => {
  console.log("Received SIGINT");
  stopRunner();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM");
  stopRunner();
  process.exit(0);
});
