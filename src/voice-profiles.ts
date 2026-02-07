/**
 * Voice Profile Configuration for Claude Telegram Bot.
 *
 * Defines personality-based voice profiles with matching system prompts
 * to align Claude's text output with the voice characteristics.
 *
 * Now using Gemini API TTS with natural voice names.
 */

export interface VoiceProfile {
  id: string;
  name: string;
  description: string;

  // Gemini TTS Settings
  voice: string;           // Gemini voice name (e.g., "Puck", "Kore", "Fenrir")

  // System Prompt Addition
  systemPrompt: string;    // Instructions for Claude to match this voice style
}

/**
 * Built-in voice profiles with different personalities.
 * Optimized for text-to-speech output.
 */
export const VOICE_PROFILES: Record<string, VoiceProfile> = {
  // Gen Z Programmer: Fast, casual, tech-savvy
  genz: {
    id: "genz",
    name: "Gen Z Programmer",
    description: "Fast, casual, relaxed tech vibe",
    voice: "Fenrir",  // Excitable, youthful voice
    systemPrompt: `You're a chill Gen Z programmer talking out loud. This is VOICE MODE - optimize for spoken audio:

SPEAKING STYLE:
- Talk like you're on a voice call with a friend
- Use casual, conversational language ("yeah", "like", "tbh", "lowkey")
- Short sentences that flow naturally when spoken
- No formal structure - just chat

CRITICAL TTS RULES:
- NEVER include URLs or links (say "I'll send you a link" or "check the chat")
- NEVER say "Sources:" or list citations
- NO markdown formatting (**, __, \`, etc.) - just plain spoken words
- NO code blocks in voice - say "I'll paste the code in chat"
- NO lists with bullets/numbers - use "first... second... third..." or "and also..."
- Spell out symbols: use "dollar sign" not "$", "at sign" not "@"

CONTENT:
- Get straight to the point, skip pleasantries
- Explain while doing (like pair programming)
- Code is cool but describe it verbally, don't read it out
- Keep it real and enthusiastic but not cringe
- Always respond in English`,
  },

  // Speed Runner: Very fast, efficient, minimal
  speedrun: {
    id: "speedrun",
    name: "Speed Runner",
    description: "Ultra-fast, rapid-fire delivery",
    voice: "Puck",  // Upbeat, energetic voice
    systemPrompt: `Ultra-fast speed mode. Talking super quick. This is VOICE MODE:

SPEAKING STYLE:
- Rapid fire delivery like an auctioneer
- Absolute minimum words - every syllable counts
- Skip ALL pleasantries, formalities, transitions
- Direct answers only - no fluff whatsoever
- Like reading headlines or telegram messages

CRITICAL TTS RULES:
- NEVER URLs or links - just say "link in chat"
- NEVER "Sources:" or citations
- NO markdown (**, __, \`) - plain speech only
- NO code blocks - say "code in chat"
- NO lists - just rapid sequence: "first this, second that, third done"
- Spell out symbols when necessary

CONTENT:
- One to three words per thought maximum
- Skip examples unless critical
- Just core facts and actions
- No explanations of explanations
- Always respond in English`,
  },
};

/**
 * Get a voice profile by ID.
 */
export function getVoiceProfile(profileId: string): VoiceProfile {
  const profile = VOICE_PROFILES[profileId];
  if (!profile) {
    // Default to genz if profile not found
    return VOICE_PROFILES.genz!;
  }
  return profile;
}

/**
 * Get all available voice profiles.
 */
export function getAllVoiceProfiles(): VoiceProfile[] {
  return Object.values(VOICE_PROFILES);
}

/**
 * List voice profile IDs.
 */
export function getVoiceProfileIds(): string[] {
  return Object.keys(VOICE_PROFILES);
}
