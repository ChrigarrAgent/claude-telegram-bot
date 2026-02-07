# Voice Mode Implementation Plan

## Overview

Add voice output capability to the Telegram bot, allowing Claude's responses to be delivered as both text and voice messages when enabled.

## Requirements Summary

- **TTS Provider**: Google Cloud TTS (generous free tier)
- **Content Optimization**: System prompt enhancement (very concise, conceptual explanations)
- **Activation**: `/voice` global toggle command (affects all chats/projects)
- **Output**: Voice message sent alongside text response
- **Error Handling**: Graceful degradation (if TTS fails, text-only)
- **Scope**: Global on/off state (not per-chat, not per-project)

## Key Design Principles (Updated)

Based on user feedback, the implementation prioritizes:

1. **Simplicity**: Global toggle (`/voice`) - one command affects everything
   - "Voice mode turned on" / "Voice mode turned off" messages
   - No complex per-chat or per-project state management

2. **Concise Voice Output**: System prompt emphasizes:
   - VERY CONCISE summaries (but with all important info)
   - CONCEPTUAL explanations ("what changed") not file/line details
   - Explain what code DOES, not where it is
   - Natural speech, not technical documentation

3. **Generous Limits**: 3000 character limit (up from 1000)
   - Free tier provides plenty of headroom
   - System prompt guides Claude to stay brief naturally

4. **Global State**: Single boolean flag
   - Affects all future messages across all chats/projects
   - Persists until toggled again
   - Simplest possible state management

---

## Implementation Steps

### Step 1: Configuration Setup

**File: `src/config.ts`**

Add Google Cloud TTS configuration after existing transcription section:

```typescript
// ============== Voice Synthesis (TTS) ==============

export const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || "";
export const GOOGLE_TTS_VOICE = process.env.GOOGLE_TTS_VOICE || "en-US-Neural2-J";
export const GOOGLE_TTS_LANGUAGE = process.env.GOOGLE_TTS_LANGUAGE || "en-US";
export const TTS_AVAILABLE = GOOGLE_TTS_API_KEY.length > 0;
export const TTS_MAX_CHARS = 3000; // Truncate very long responses before TTS

// Voice-optimized system prompt addon
export const VOICE_MODE_PROMPT = `
VOICE MODE IS ENABLED: Your final summary/response will be converted to speech.

Requirements for voice output:
- Be VERY CONCISE but include all important information
- Provide CONCEPTUAL explanations (what changed, why it matters) NOT file-level details
- Explain what the code DOES, don't describe file names or line numbers
- Speak naturally as if explaining to a colleague
- The text version will have all code/formatting details, so focus on the high-level summary for voice

Example: Instead of "I modified src/utils.ts line 45 to add error handling", say "I added error handling to the voice synthesis function so it fails gracefully if the API is unavailable."
`;
```

**File: `.env.example`**

Add to OPTIONAL section:

```bash
# ==============================================================================
# OPTIONAL - Voice Mode (TTS)
# ==============================================================================

# Google Cloud TTS API key for voice responses
# Get from: https://console.cloud.google.com/apis/credentials
# Enable Text-to-Speech API first: https://console.cloud.google.com/apis/library/texttospeech.googleapis.com
# GOOGLE_TTS_API_KEY=AIza...

# Voice and language for TTS (optional, defaults shown)
# GOOGLE_TTS_VOICE=en-US-Neural2-J
# GOOGLE_TTS_LANGUAGE=en-US
```

---

### Step 2: Voice Synthesis Utility

**File: `src/utils.ts`**

Add after `transcribeVoice()` function:

```typescript
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

    const data = await response.json();
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
```

---

### Step 3: Voice Mode State Management

**File: `src/voice-mode-state.ts` (NEW FILE)**

Create new file to manage global voice mode state:

```typescript
/**
 * Voice mode state management.
 * Global on/off toggle (affects all chats and projects).
 */

let voiceModeEnabled = false;

export function isVoiceModeEnabled(): boolean {
  return voiceModeEnabled;
}

export function setVoiceMode(enabled: boolean): void {
  voiceModeEnabled = enabled;
}

export function toggleVoiceMode(): boolean {
  voiceModeEnabled = !voiceModeEnabled;
  return voiceModeEnabled;
}
```

---

### Step 4: Voice Command Handler

**File: `src/handlers/commands.ts`**

Add after `handleRetry()` function:

```typescript
/**
 * /voice - Toggle voice mode (TTS output) globally.
 */
export async function handleVoice(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Import voice mode state
  const { toggleVoiceMode } = await import("../voice-mode-state");
  const { TTS_AVAILABLE } = await import("../config");

  if (!TTS_AVAILABLE) {
    await ctx.reply(
      "❌ <b>Voice mode not available</b>\n\n" +
        "Set <code>GOOGLE_TTS_API_KEY</code> in your environment to enable voice responses.\n\n" +
        "Get an API key:\n" +
        "1. Go to https://console.cloud.google.com/\n" +
        "2. Enable Text-to-Speech API\n" +
        "3. Create API key in Credentials",
      { parse_mode: "HTML" }
    );
    return;
  }

  const newState = toggleVoiceMode();

  if (newState) {
    await ctx.reply("🔊 Voice mode turned on");
  } else {
    await ctx.reply("🔇 Voice mode turned off");
  }
}
```

Update help text in `handleStart()`:

```typescript
// Add to command list in /start response:
`/voice - Toggle voice responses 🆕\n`
```

---

### Step 5: Streaming Enhancement for Voice Output

**File: `src/handlers/streaming.ts`**

#### 5.1 Add InputFile import

```typescript
import { InlineKeyboard, InputFile } from "grammy";
```

#### 5.2 Add voice helper function

After `sendLongMessage()`, add:

```typescript
/**
 * Send a voice message for the given text.
 * Fails gracefully if TTS unavailable or errors occur.
 */
async function sendVoiceMessage(ctx: Context, text: string): Promise<void> {
  try {
    const { synthesizeVoice } = await import("../utils");
    const audioBuffer = await synthesizeVoice(text);

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
    const { synthesizeVoice } = await import("../utils");
    const audioBuffer = await synthesizeVoice(text);

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
```

#### 5.3 Update `createStatusCallback()` signature

```typescript
export function createStatusCallback(
  ctx: Context,
  state: StreamingState,
  projectAlias: string = "default",
  voiceEnabled: boolean = false  // NEW PARAMETER
): StatusCallback {
```

In the `done` event handler, after sending final text:

```typescript
if (statusType === "done") {
  // Update working message
  state.workingContent.push("✅ <b>Complete</b>");
  await updateWorkingMessage(ctx, state, projectAlias);

  // Send final answer
  if (state.finalTextSegments.length > 0) {
    const finalText = state.finalTextSegments.join("\n\n");
    await sendLongMessage(ctx, finalText, projectAlias);

    // NEW: Voice mode - synthesize and send voice message
    if (voiceEnabled) {
      await sendVoiceMessage(ctx, finalText);
    }
  }
}
```

#### 5.4 Update `createBotApiStatusCallback()` signature

```typescript
export function createBotApiStatusCallback(
  api: Api,
  chatId: number,
  projectAlias: string = "default",
  voiceEnabled: boolean = false  // NEW PARAMETER
): StatusCallback {
```

In the `done` event handler:

```typescript
if (statusType === "done") {
  state.workingContent.push("✅ <b>Complete</b>");
  await updateWorkingMessageViaApi(api, chatId, state, projectAlias);

  if (state.finalTextSegments.length > 0) {
    const finalText = state.finalTextSegments.join("\n\n");
    await sendLongMessageViaApi(api, chatId, finalText, projectAlias);

    // NEW: Voice mode
    if (voiceEnabled) {
      await sendVoiceMessageViaApi(api, chatId, finalText);
    }
  }
}
```

---

### Step 6: System Prompt Integration

**File: `src/session.ts`**

In `sendMessageStreaming()`, before creating SDK options:

```typescript
// Check if voice mode is enabled globally
const { isVoiceModeEnabled } = await import("./voice-mode-state");
const { VOICE_MODE_PROMPT } = await import("./config");
const systemPrompt = isVoiceModeEnabled()
  ? SYSTEM_PROMPT + "\n\n" + VOICE_MODE_PROMPT
  : SYSTEM_PROMPT;

// Build SDK options
const options: Options = {
  model: "claude-sonnet-4-5",
  cwd: workingDir || getWorkingDir(),
  settingSources: ["user", "project"],
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  systemPrompt: systemPrompt,  // <-- Use conditional prompt
  mcpServers: MCP_SERVERS,
  // ...
};
```

---

### Step 7: Handler Integration

**File: `src/helpers.ts`**

Update `sendMessageWithRetry()` signature:

```typescript
export async function sendMessageWithRetry(
  projectSession: ProjectSession,
  message: string,
  username: string,
  userId: number,
  ctx: Context,
  chatId: number,
  maxRetries = 1,
  voiceEnabled = false  // NEW PARAMETER
): Promise<SendMessageResult> {
  const projectAlias = getProjectAlias(projectSession.workingDir);
  let state = new StreamingState();
  let statusCallback = createStatusCallback(ctx, state, projectAlias, voiceEnabled);  // PASS VOICE STATE

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
      // ... existing retry logic ...

      // Reset for retry
      state = new StreamingState();
      statusCallback = createStatusCallback(ctx, state, projectAlias, voiceEnabled);  // PASS VOICE STATE
      continue;
    }
  }

  throw new Error("Max retries exceeded");
}
```

**File: `src/handlers/text.ts`**

Get voice state and pass to retry function:

```typescript
// Get global voice mode state
const { isVoiceModeEnabled } = await import("../voice-mode-state");
const voiceEnabled = isVoiceModeEnabled();

// Send message with retry logic
const { response, state } = await sendMessageWithRetry(
  projectSession,
  messageToSend,
  username,
  userId,
  ctx,
  chatId!,
  1,
  voiceEnabled  // NEW PARAMETER
);
```

**Similar changes for:**
- `src/handlers/voice.ts`
- `src/handlers/photo.ts`
- `src/handlers/document.ts`

---

### Step 8: Command Registration

**File: `src/index.ts`**

Add import:

```typescript
import {
  handleStart,
  handleNew,
  handleStop,
  handleStatus,
  handleResume,
  handleRestart,
  handleHandoff,
  handleTmux,
  handleProject,
  handleProjects,
  handleUsage,
  handleRetry,
  handleVoice  // NEW IMPORT
} from "./handlers/commands";
```

Register command:

```typescript
bot.command("voice", handleVoice);
```

Update auto-continue and process completion handlers to check voice state:

```typescript
// In autoContinueSession() and handleProcessCompletion()
const { isVoiceModeEnabled } = await import("./voice-mode-state");
const voiceEnabled = isVoiceModeEnabled();

const statusCallback = createBotApiStatusCallback(
  bot.api,
  chatId,
  projectAlias,
  voiceEnabled  // NEW PARAMETER
);
```

---

## Testing Checklist

### Setup
1. ✅ Get Google Cloud TTS API key
2. ✅ Enable Text-to-Speech API in Google Cloud Console
3. ✅ Add `GOOGLE_TTS_API_KEY` to `.env`
4. ✅ Restart bot

### Basic Functionality
1. ✅ `/voice` without API key → Shows setup instructions
2. ✅ `/voice` with API key → Enables voice mode with confirmation
3. ✅ `/voice` again → Disables voice mode
4. ✅ `/start` shows voice command in help

### Voice Output
1. ✅ Send message with voice ON → Receives text + voice
2. ✅ Voice message is OGG format
3. ✅ Voice has caption "🔊 Voice response"
4. ✅ Long response (>1000 chars) is truncated but works
5. ✅ Code blocks replaced with "[code block]" in voice
6. ✅ Markdown stripped from voice

### Error Handling
1. ✅ TTS API failure → Text sent, no crash
2. ✅ Invalid API key → Text sent, error logged
3. ✅ Voice mode OFF → No voice messages sent

### System Prompt
1. ✅ Voice ON → Claude's summaries are very concise and conceptual
2. ✅ Voice OFF → Normal Claude responses
3. ✅ Voice output focuses on "what changed" not file/line details

### Global State
1. ✅ Voice mode affects all chats and projects
2. ✅ `/voice` toggles globally for everyone
3. ✅ Toggle persists until changed again

---

## Edge Cases

### Long Responses
- Truncate at 3000 characters (configurable via `TTS_MAX_CHARS`)
- Text version is complete, voice is concise summary
- System prompt encourages Claude to keep voice responses brief

### Code-Heavy Responses
- Strip markdown and code blocks from voice synthesis
- System prompt guides Claude to provide conceptual explanations, not code details
- Voice explains "what changed" not "where it changed"

### TTS Failures
- All TTS wrapped in try-catch
- Failures logged but don't affect text delivery
- Voice is "best effort" addon

### Cost Management
- Generous free tier (1M+ characters available)
- Truncation at 3000 chars provides safety net
- Global toggle makes it easy to disable if needed

---

## Files to Modify

1. **src/config.ts** - Add TTS config and voice prompt
2. **src/utils.ts** - Add `synthesizeVoice()` function
3. **src/voice-mode-state.ts** - NEW FILE for state management
4. **src/handlers/commands.ts** - Add `/voice` command
5. **src/handlers/streaming.ts** - Add voice sending in `done` event
6. **src/session.ts** - Conditional system prompt
7. **src/helpers.ts** - Add `voiceEnabled` parameter to retry function
8. **src/handlers/text.ts** - Pass voice state to retry
9. **src/handlers/voice.ts** - Pass voice state to retry
10. **src/handlers/photo.ts** - Pass voice state to retry
11. **src/handlers/document.ts** - Pass voice state to retry
12. **src/index.ts** - Register `/voice` command, update auto-continue
13. **.env.example** - Document TTS env vars

---

## Rollback Plan

If issues arise:
1. **User-level**: Just run `/voice` to toggle off globally
2. **Config-level**: Set `GOOGLE_TTS_API_KEY=""` to disable TTS entirely
3. **Code-level**: Remove `bot.command("voice", handleVoice)` from index.ts
4. Voice mode degrades gracefully - text functionality always works regardless of voice state

---

## Future Enhancements

- Multi-language auto-detection (detect message language and use appropriate voice)
- Streaming TTS (start playing audio before full synthesis complete)
- Voice quality settings (fast/standard/premium voices)
- Caching common responses (reduce API calls for repeated summaries)
- Usage analytics (track TTS usage and costs)
- Per-chat or per-project preferences (if global toggle becomes limiting)

---

## Performance Impact

- **Memory**: Single boolean flag (negligible)
- **Network**: 1-3s latency for TTS + upload (up to ~200KB audio per response)
- **User Experience**: Voice appears 1-3s after text (non-blocking)

---

## Summary

This implementation adds voice output as an optional enhancement without disrupting existing text functionality. The design follows existing patterns (similar to voice input transcription), uses graceful degradation, and is fully backwards compatible.
