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

import { GOOGLE_TTS_API_KEY, TTS_MAX_CHARS } from "./config";
import { trackTTSUsage, isTTSDisabledByUsage } from "./tts-usage";
import { getVoiceProfile, type VoiceProfile } from "./voice-profiles";

/**
 * Synthesize text to speech using Gemini API with LLM rewrite.
 *
 * NEW APPROACH:
 * 1. Takes Claude's normal output (with markdown, URLs, etc.)
 * 2. Uses Gemini LLM to rewrite it for conversational speech
 * 3. Generates audio from the rewritten text
 *
 * This way Claude doesn't need voice-specific system prompts!
 *
 * @param text - Claude's normal output text
 * @param profileId - Voice profile ID (genz, speedrun)
 * @returns Audio buffer or error message
 */
export async function synthesizeVoice(
  text: string,
  profileId: string = "genz"
): Promise<Buffer | { error: string }> {
  if (!GOOGLE_TTS_API_KEY) {
    console.warn("[TTS] API key not configured");
    return { error: "TTS API key not configured" };
  }

  try {
    // Get voice profile settings
    const profile = getVoiceProfile(profileId);
    console.log(`[TTS-Gemini] Using voice: ${profile.voice} (${profile.name})`);

    // Truncate if too long
    const truncatedText = text.length > TTS_MAX_CHARS
      ? text.slice(0, TTS_MAX_CHARS) + "..."
      : text;

    // STEP 1: Use Gemini LLM to rewrite Claude's output for conversational speech
    // This removes markdown, URLs, rewrites in conversational tone matching the profile
    const rewritePrompt = profile.systemPrompt + `\n\nRewrite this message for spoken audio (conversational, no URLs, no markdown):\n\n${truncatedText}`;

    console.log(`[TTS-Gemini] Step 1: Rewriting text for speech...`);

    const rewriteResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GOOGLE_TTS_API_KEY,
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: rewritePrompt }]
          }]
        }),
      }
    );

    if (!rewriteResponse.ok) {
      const errorText = await rewriteResponse.text();
      console.error("[TTS-Gemini] Rewrite error:", rewriteResponse.status, errorText);
      return { error: `Gemini rewrite failed: ${rewriteResponse.status}` };
    }

    const rewriteData = await rewriteResponse.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>
        }
      }>
    };

    const speechText = rewriteData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!speechText) {
      console.error("[TTS-Gemini] No rewritten text returned");
      return { error: "Gemini failed to rewrite text" };
    }

    console.log(`[TTS-Gemini] Step 2: Generating audio from rewritten text...`);
    console.log(`[TTS-Gemini] Rewritten (${speechText.length} chars): ${speechText.slice(0, 100)}...`);

    // STEP 2: Generate TTS audio from the rewritten text
    const ttsPrompt = `Read this out loud: ${speechText}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GOOGLE_TTS_API_KEY,
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: ttsPrompt }]
          }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: profile.voice,
                }
              }
            }
          }
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[TTS-Gemini] TTS API error:", response.status, errorText);
      return { error: `TTS API error: ${response.status}` };
    }

    const data = await response.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: {
              data?: string;
              mimeType?: string;
            }
          }>
        }
      }>
    };

    // Extract audio from Gemini response
    const audioData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!audioData) {
      console.error("[TTS-Gemini] Response missing audio data");
      console.error("[TTS-Gemini] Full response:", JSON.stringify(data, null, 2));
      return { error: "No audio data in response" };
    }

    // Track usage for analytics (even though it's free)
    trackTTSUsage(speechText.length);

    console.log(`[TTS-Gemini] ✅ Success! Audio generated (${audioData.length} chars base64)`);

    // Decode base64 to buffer
    return Buffer.from(audioData, "base64");
  } catch (error) {
    console.error("[TTS-Gemini] Synthesis failed:", error);
    return { error: `TTS synthesis failed: ${error instanceof Error ? error.message : String(error)}` };
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
