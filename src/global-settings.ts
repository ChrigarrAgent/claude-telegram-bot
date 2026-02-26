/**
 * Global bot settings (not per-chat).
 *
 * These settings apply across all chats (DMs and groups).
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";

const GLOBAL_SETTINGS_FILE = `${homedir()}/.claude/telegram-global-settings.json`;

interface GlobalSettings {
  voiceLanguage?: string; // Global language for all voice responses (e.g., "de-DE", "en-US")
}

let settingsCache: GlobalSettings = {};
let cacheLoaded = false;

/**
 * Load global settings from disk.
 */
function loadSettings(): GlobalSettings {
  if (cacheLoaded) return settingsCache;

  if (!existsSync(GLOBAL_SETTINGS_FILE)) {
    settingsCache = {};
    cacheLoaded = true;
    return settingsCache;
  }

  try {
    settingsCache = JSON.parse(readFileSync(GLOBAL_SETTINGS_FILE, "utf-8"));
    cacheLoaded = true;
  } catch (error) {
    console.error("Failed to load global settings:", error);
    settingsCache = {};
    cacheLoaded = true;
  }

  return settingsCache;
}

/**
 * Save global settings to disk (atomic write).
 */
function saveSettings(): void {
  try {
    writeFileSync(GLOBAL_SETTINGS_FILE, JSON.stringify(settingsCache, null, 2));
  } catch (error) {
    console.error("Failed to save global settings:", error);
  }
}

/**
 * Get global voice language.
 * Returns undefined if not set (use profile's default language).
 */
export function getGlobalVoiceLanguage(): string | undefined {
  loadSettings();
  return settingsCache.voiceLanguage;
}

/**
 * Set global voice language (applies to all chats).
 */
export function setGlobalVoiceLanguage(language: string): void {
  loadSettings();
  settingsCache.voiceLanguage = language;
  saveSettings();
}

/**
 * Clear global voice language (revert to profile defaults).
 */
export function clearGlobalVoiceLanguage(): void {
  loadSettings();
  delete settingsCache.voiceLanguage;
  saveSettings();
}
