/**
 * Chat-specific settings with persistence.
 *
 * Simple per-chat settings (no hierarchical resolution).
 * Voice mode propagates from DM to all linked groups.
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";

const SETTINGS_FILE = `${homedir()}/.claude/telegram-chat-settings.json`;

interface ChatSettings {
  voiceMode?: boolean;
  voiceProfile?: string;  // Voice profile ID (default, genz, mentor, etc.)
  // Future: language?: string, etc.
}

// Simple map: chatId → settings
type SettingsData = Record<string, ChatSettings>;

let settingsCache: SettingsData = {};
let cacheLoaded = false;

/**
 * Load settings from disk.
 */
function loadSettings(): SettingsData {
  if (cacheLoaded) return settingsCache;

  if (!existsSync(SETTINGS_FILE)) {
    settingsCache = {};
    cacheLoaded = true;
    return settingsCache;
  }

  try {
    settingsCache = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    cacheLoaded = true;
  } catch (error) {
    console.error("Failed to load chat settings:", error);
    settingsCache = {};
    cacheLoaded = true;
  }

  return settingsCache;
}

/**
 * Save settings to disk (atomic write).
 */
function saveSettings(): void {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settingsCache, null, 2));
  } catch (error) {
    console.error("Failed to save chat settings:", error);
  }
}

/**
 * Get voice mode for a chat.
 * Simple lookup - no hierarchical resolution needed!
 */
export function getVoiceMode(chatId: number): boolean {
  loadSettings();
  return settingsCache[chatId.toString()]?.voiceMode ?? false;
}

/**
 * Set voice mode for a chat.
 */
export function setChatVoiceMode(chatId: number, enabled: boolean): void {
  loadSettings();

  if (!settingsCache[chatId.toString()]) {
    settingsCache[chatId.toString()] = {};
  }

  settingsCache[chatId.toString()]!.voiceMode = enabled;
  saveSettings();
}

/**
 * Clear voice mode setting (revert to default false).
 */
export function clearChatVoiceMode(chatId: number): void {
  loadSettings();
  delete settingsCache[chatId.toString()];
  saveSettings();
}

/**
 * Get voice profile for a chat.
 */
export function getVoiceProfile(chatId: number): string {
  loadSettings();
  return settingsCache[chatId.toString()]?.voiceProfile ?? "default";
}

/**
 * Set voice profile for a chat.
 */
export function setVoiceProfile(chatId: number, profileId: string): void {
  loadSettings();

  if (!settingsCache[chatId.toString()]) {
    settingsCache[chatId.toString()] = {};
  }

  settingsCache[chatId.toString()]!.voiceProfile = profileId;
  saveSettings();
}

/**
 * Clear all settings (for testing).
 */
export function clearAllSettings(): void {
  settingsCache = {};
  cacheLoaded = true;
  saveSettings();
}
