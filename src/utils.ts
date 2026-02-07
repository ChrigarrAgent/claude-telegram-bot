/**
 * Utility functions for Claude Telegram Bot.
 *
 * Audit logging, voice transcription, typing indicator.
 */

import OpenAI from "openai";
import type { Chat } from "grammy/types";
import type { Context } from "grammy";
import type { AuditEvent } from "./types";
import {
  AUDIT_LOG_PATH,
  AUDIT_LOG_JSON,
  OPENAI_API_KEY,
  GROQ_API_KEY,
  TRANSCRIPTION_PROMPT,
  TRANSCRIPTION_AVAILABLE,
  TRANSCRIPTION_PROVIDER,
} from "./config";

// ============== Transcription Client ==============

let transcriptionClient: OpenAI | null = null;
let transcriptionModel = "whisper-1";

if (TRANSCRIPTION_PROVIDER === "groq" && GROQ_API_KEY) {
  // Groq Whisper - fast & cheap
  transcriptionClient = new OpenAI({
    apiKey: GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  });
  transcriptionModel = "whisper-large-v3-turbo";
  console.log("Voice transcription: Groq Whisper (fast)");
} else if (TRANSCRIPTION_PROVIDER === "openai" && OPENAI_API_KEY) {
  // OpenAI Whisper
  transcriptionClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  transcriptionModel = "whisper-1";
  console.log("Voice transcription: OpenAI Whisper");
} else {
  console.log("Voice transcription: Not configured");
}

// ============== Audit Logging ==============

async function writeAuditLog(event: AuditEvent): Promise<void> {
  try {
    let content: string;
    if (AUDIT_LOG_JSON) {
      content = JSON.stringify(event) + "\n";
    } else {
      // Plain text format for readability
      const lines = ["\n" + "=".repeat(60)];
      for (const [key, value] of Object.entries(event)) {
        let displayValue = value;
        if (
          (key === "content" || key === "response") &&
          String(value).length > 500
        ) {
          displayValue = String(value).slice(0, 500) + "...";
        }
        lines.push(`${key}: ${displayValue}`);
      }
      content = lines.join("\n") + "\n";
    }

    // Append to audit log file
    const fs = await import("fs/promises");
    await fs.appendFile(AUDIT_LOG_PATH, content);
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}

export async function auditLog(
  userId: number,
  username: string,
  messageType: string,
  content: string,
  response = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "message",
    user_id: userId,
    username,
    message_type: messageType,
    content,
  };
  if (response) {
    event.response = response;
  }
  await writeAuditLog(event);
}

export async function auditLogAuth(
  userId: number,
  username: string,
  authorized: boolean
): Promise<void> {
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    event: "auth",
    user_id: userId,
    username,
    authorized,
  });
}

export async function auditLogTool(
  userId: number,
  username: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  blocked = false,
  reason = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "tool_use",
    user_id: userId,
    username,
    tool_name: toolName,
    tool_input: toolInput,
    blocked,
  };
  if (blocked && reason) {
    event.reason = reason;
  }
  await writeAuditLog(event);
}

export async function auditLogError(
  userId: number,
  username: string,
  error: string,
  context = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "error",
    user_id: userId,
    username,
    error,
  };
  if (context) {
    event.context = context;
  }
  await writeAuditLog(event);
}

export async function auditLogRateLimit(
  userId: number,
  username: string,
  retryAfter: number
): Promise<void> {
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    event: "rate_limit",
    user_id: userId,
    username,
    retry_after: retryAfter,
  });
}

// ============== Voice Transcription ==============

export async function transcribeVoice(
  filePath: string
): Promise<string | null> {
  if (!transcriptionClient) {
    console.warn("Transcription client not available");
    return null;
  }

  try {
    const file = Bun.file(filePath);
    const transcript = await transcriptionClient.audio.transcriptions.create({
      model: transcriptionModel,
      file: file,
      prompt: TRANSCRIPTION_PROMPT,
    });
    return transcript.text;
  } catch (error) {
    console.error("Transcription failed:", error);
    return null;
  }
}

// ============== Voice Synthesis (TTS) ==============

import { GOOGLE_TTS_API_KEY, GOOGLE_TTS_VOICE, GOOGLE_TTS_LANGUAGE, TTS_MAX_CHARS } from "./config";

/**
 * Synthesize text to speech using Google Cloud TTS.
 * Returns OGG audio buffer or null on failure.
 * Gracefully handles errors (voice mode is optional feature).
 */
export async function synthesizeVoice(text: string): Promise<Buffer | null> {
  if (!GOOGLE_TTS_API_KEY) {
    console.warn("TTS API key not configured");
    return null;
  }

  try {
    // Truncate long text
    const truncatedText = text.length > TTS_MAX_CHARS
      ? text.slice(0, TTS_MAX_CHARS) + "..."
      : text;

    // Remove markdown formatting for better voice output
    const cleanedText = truncatedText
      .replace(/```[\s\S]*?```/g, "[code block]") // Remove code blocks
      .replace(/`([^`]+)`/g, "$1") // Remove inline code
      .replace(/\*\*([^*]+)\*\*/g, "$1") // Remove bold
      .replace(/\*([^*]+)\*/g, "$1") // Remove italics
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1") // Convert links to text
      .replace(/^#+\s+/gm, "") // Remove heading markers
      .replace(/^\s*[-*]\s+/gm, "") // Remove list markers
      .trim();

    if (!cleanedText) {
      console.warn("No text left after cleaning for TTS");
      return null;
    }

    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text: cleanedText },
          voice: {
            languageCode: GOOGLE_TTS_LANGUAGE,
            name: GOOGLE_TTS_VOICE,
          },
          audioConfig: {
            audioEncoding: "OGG_OPUS", // Telegram's preferred format
            speakingRate: 1.0,
            pitch: 0.0,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("TTS API error:", response.status, errorText);
      return null;
    }

    const data = await response.json() as { audioContent?: string };
    if (!data.audioContent) {
      console.error("TTS response missing audioContent");
      return null;
    }

    // Decode base64 to buffer
    return Buffer.from(data.audioContent, "base64");
  } catch (error) {
    console.error("TTS synthesis failed:", error);
    return null;
  }
}

// ============== Typing Indicator ==============

export interface TypingController {
  stop: () => void;
}

export function startTypingIndicator(ctx: Context): TypingController {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        await ctx.replyWithChatAction("typing");
      } catch (error) {
        console.debug("Typing indicator failed:", error);
      }
      await Bun.sleep(4000);
    }
  };

  // Start the loop
  loop();

  return {
    stop: () => {
      running = false;
    },
  };
}

// ============== Message Interrupt ==============

/**
 * Check for ! prefix and interrupt the given project session's running query.
 * Accepts the actual ClaudeSession to interrupt (not the legacy global singleton).
 */
export async function checkInterrupt(
  text: string,
  targetSession?: {
    isRunning: boolean;
    stop: () => Promise<"stopped" | "pending" | false>;
    markInterrupt: () => void;
    clearStopRequested: () => void;
  }
): Promise<string> {
  if (!text || !text.startsWith("!")) {
    return text;
  }

  const strippedText = text.slice(1).trimStart();

  if (targetSession && targetSession.isRunning) {
    console.log("! prefix - interrupting current project query");
    targetSession.markInterrupt();
    await targetSession.stop();
    // Wait for the abort to propagate and queryLock to release
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(100);
      if (!targetSession.isRunning) break;
    }
    // Clear stopRequested so the new message can proceed
    targetSession.clearStopRequested();
  }

  return strippedText;
}
