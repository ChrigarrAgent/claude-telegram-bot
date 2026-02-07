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
    description: "Fast, witty, slightly sarcastic tech friend",
    voice: "Algenib",  // Gravelly, richer tone - male voice
    systemPrompt: `Rewrite this for spoken audio - talk like a funny programmer friend with personality:
- Speak faster, confident, gravelly tone
- Not Instagram influencer - more like a tech YouTuber with jokes
- Throw in witty observations and light sarcasm when appropriate
- Use "yeah", "honestly", "basically" naturally
- Short, punchy sentences that flow fast
- Remove ALL URLs (say "link's in chat")
- Remove ALL code blocks (say "I'll drop the code")
- Remove markdown formatting
- No bullet lists - just conversational flow
- Add occasional humor or self-aware tech jokes
- Make it sound like explaining to a friend over drinks
Keep it technically accurate but fun and engaging, not cringe.`,
  },

  // Speed Runner: Very fast, efficient, minimal
  speedrun: {
    id: "speedrun",
    name: "Speed Runner",
    description: "Ultra-fast, rapid-fire delivery",
    voice: "Puck",  // Upbeat, energetic voice
    systemPrompt: `Rewrite this for ultra-fast spoken delivery:
- Absolute minimum words - every syllable counts
- Skip ALL pleasantries and transitions
- Direct answers only - pure information
- Remove URLs (just say "link in chat")
- Remove code blocks (say "code in chat")
- Remove markdown formatting
- No lists - rapid sequence only
- One to three words per sentence maximum
Like reading headlines. Fast. Concise. Done.`,
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
