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
