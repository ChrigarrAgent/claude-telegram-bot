/**
 * Voice message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { ALLOWED_USERS, TEMP_DIR, TRANSCRIPTION_AVAILABLE } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  transcribeVoice,
} from "../utils";
import { getProjectAlias } from "../project-aliases";
import { getSessionForChat, sendMessageWithRetry, handleMessageError } from "../helpers";

/**
 * Handle incoming voice messages.
 */
export async function handleVoice(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const voice = ctx.message?.voice;

  if (!userId || !voice || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check if transcription is available
  if (!TRANSCRIPTION_AVAILABLE) {
    await ctx.reply(
      "Voice transcription is not configured. Set OPENAI_API_KEY in .env"
    );
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

  // 4. Get project session for this chat
  const projectSession = await getSessionForChat(chatId);

  // 5. Mark processing started (allows /stop to work during transcription/classification)
  const stopProcessing = projectSession.session.startProcessing();

  let voicePath: string | null = null;

  try {
    // 7. Download voice file
    const file = await ctx.getFile();
    const timestamp = Date.now();
    voicePath = `${TEMP_DIR}/voice_${timestamp}.ogg`;

    // Download the file
    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
    );
    const buffer = await downloadRes.arrayBuffer();
    await Bun.write(voicePath, buffer);

    // 8. Transcribe
    const statusMsg = await ctx.reply("🎤 Transcribing...");

    const transcript = await transcribeVoice(voicePath);
    if (!transcript) {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        "❌ Transcription failed."
      );
      stopProcessing();
      return;
    }

    // 9. Show transcript with project context
    const projectAlias = getProjectAlias(projectSession.workingDir);
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      `🎤 <b>${projectAlias}</b>: "${transcript}"`,
      { parse_mode: "HTML" }
    );

    // 10. Set conversation title from transcript (if new session)
    if (!projectSession.isActive()) {
      const title =
        transcript.length > 50 ? transcript.slice(0, 47) + "..." : transcript;
      projectSession.session.conversationTitle = title;
    }

    // 11. Send to Claude with retry logic
    const { response } = await sendMessageWithRetry(
      projectSession,
      transcript,
      username,
      userId,
      ctx,
      chatId
    );

    // Update project activity
    projectSession.updateActivity();

    // 12. Audit log
    await auditLog(userId, username, "VOICE", transcript, response);
  } catch (error) {
    console.error("Error processing voice:", error);
    await handleMessageError(ctx, error, projectSession);
  } finally {
    stopProcessing();

    // Clean up voice file
    if (voicePath) {
      try {
        unlinkSync(voicePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
