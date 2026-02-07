/**
 * TTS Usage Tracking for Claude Telegram Bot.
 *
 * Tracks Google Cloud Text-to-Speech API usage to stay within free tier limits.
 * Free tier: 1 million characters/month for Standard voices
 *            4 million characters/month for WaveNet/Neural2 voices (first year)
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";

const USAGE_FILE = `${homedir()}/.claude/telegram-tts-usage.json`;

// Configurable limits (characters per month)
const DEFAULT_MONTHLY_LIMIT = 1_000_000; // 1M characters (conservative)
const WARNING_THRESHOLD = 0.85; // Warn at 85%
const AUTO_DISABLE_THRESHOLD = 0.98; // Auto-disable at 98%

interface UsageData {
  month: string; // Format: "YYYY-MM"
  charactersUsed: number;
  requestCount: number;
  lastUpdated: string; // ISO timestamp
  monthlyLimit: number;
  disabled: boolean; // Auto-disabled when limit reached
}

let usageCache: UsageData | null = null;

/**
 * Get current month key (YYYY-MM).
 */
function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Load usage data from disk.
 */
function loadUsage(): UsageData {
  if (usageCache && usageCache.month === getCurrentMonth()) {
    return usageCache;
  }

  if (!existsSync(USAGE_FILE)) {
    usageCache = {
      month: getCurrentMonth(),
      charactersUsed: 0,
      requestCount: 0,
      lastUpdated: new Date().toISOString(),
      monthlyLimit: DEFAULT_MONTHLY_LIMIT,
      disabled: false,
    };
    saveUsage();
    return usageCache;
  }

  try {
    const data = JSON.parse(readFileSync(USAGE_FILE, "utf-8")) as UsageData;

    // Reset if new month
    if (data.month !== getCurrentMonth()) {
      console.log(`[TTS-USAGE] New month detected. Resetting usage from ${data.month} to ${getCurrentMonth()}`);
      usageCache = {
        month: getCurrentMonth(),
        charactersUsed: 0,
        requestCount: 0,
        lastUpdated: new Date().toISOString(),
        monthlyLimit: data.monthlyLimit || DEFAULT_MONTHLY_LIMIT,
        disabled: false,
      };
      saveUsage();
      return usageCache;
    }

    usageCache = data;
    return usageCache;
  } catch (error) {
    console.error("[TTS-USAGE] Failed to load usage data:", error);
    usageCache = {
      month: getCurrentMonth(),
      charactersUsed: 0,
      requestCount: 0,
      lastUpdated: new Date().toISOString(),
      monthlyLimit: DEFAULT_MONTHLY_LIMIT,
      disabled: false,
    };
    saveUsage();
    return usageCache;
  }
}

/**
 * Save usage data to disk.
 */
function saveUsage(): void {
  if (!usageCache) return;

  try {
    writeFileSync(USAGE_FILE, JSON.stringify(usageCache, null, 2));
  } catch (error) {
    console.error("[TTS-USAGE] Failed to save usage data:", error);
  }
}

/**
 * Track TTS usage (call this after successful API request).
 */
export function trackTTSUsage(characters: number): void {
  const usage = loadUsage();
  usage.charactersUsed += characters;
  usage.requestCount += 1;
  usage.lastUpdated = new Date().toISOString();

  const percentUsed = (usage.charactersUsed / usage.monthlyLimit) * 100;

  // Auto-disable if threshold reached
  if (percentUsed >= AUTO_DISABLE_THRESHOLD * 100 && !usage.disabled) {
    usage.disabled = true;
    console.warn(
      `[TTS-USAGE] ⚠️ AUTO-DISABLED: Reached ${percentUsed.toFixed(1)}% of monthly limit ` +
      `(${usage.charactersUsed.toLocaleString()}/${usage.monthlyLimit.toLocaleString()} chars)`
    );
  } else if (percentUsed >= WARNING_THRESHOLD * 100) {
    console.warn(
      `[TTS-USAGE] ⚠️ WARNING: ${percentUsed.toFixed(1)}% of monthly limit used ` +
      `(${usage.charactersUsed.toLocaleString()}/${usage.monthlyLimit.toLocaleString()} chars)`
    );
  }

  saveUsage();
}

/**
 * Check if TTS should be disabled due to usage limits.
 */
export function isTTSDisabledByUsage(): boolean {
  const usage = loadUsage();
  return usage.disabled;
}

/**
 * Get current usage statistics.
 */
export function getTTSUsageStats(): {
  charactersUsed: number;
  requestCount: number;
  monthlyLimit: number;
  percentUsed: number;
  remainingCharacters: number;
  disabled: boolean;
  month: string;
  willAutoDisableAt: number;
} {
  const usage = loadUsage();
  const percentUsed = (usage.charactersUsed / usage.monthlyLimit) * 100;
  const remainingCharacters = Math.max(0, usage.monthlyLimit - usage.charactersUsed);
  const willAutoDisableAt = Math.floor(usage.monthlyLimit * AUTO_DISABLE_THRESHOLD);

  return {
    charactersUsed: usage.charactersUsed,
    requestCount: usage.requestCount,
    monthlyLimit: usage.monthlyLimit,
    percentUsed,
    remainingCharacters,
    disabled: usage.disabled,
    month: usage.month,
    willAutoDisableAt,
  };
}

/**
 * Manually enable/disable TTS (overrides auto-disable).
 */
export function setTTSDisabled(disabled: boolean): void {
  const usage = loadUsage();
  usage.disabled = disabled;
  saveUsage();
  console.log(`[TTS-USAGE] Manually ${disabled ? 'disabled' : 'enabled'} TTS`);
}

/**
 * Update monthly limit (e.g., if user upgrades to paid tier).
 */
export function setMonthlyLimit(limit: number): void {
  const usage = loadUsage();
  usage.monthlyLimit = limit;

  // Re-check if should be disabled
  const percentUsed = (usage.charactersUsed / usage.monthlyLimit) * 100;
  if (percentUsed < AUTO_DISABLE_THRESHOLD * 100) {
    usage.disabled = false;
  }

  saveUsage();
  console.log(`[TTS-USAGE] Updated monthly limit to ${limit.toLocaleString()} characters`);
}

/**
 * Reset usage (for testing or manual reset).
 */
export function resetTTSUsage(): void {
  usageCache = {
    month: getCurrentMonth(),
    charactersUsed: 0,
    requestCount: 0,
    lastUpdated: new Date().toISOString(),
    monthlyLimit: usageCache?.monthlyLimit || DEFAULT_MONTHLY_LIMIT,
    disabled: false,
  };
  saveUsage();
  console.log("[TTS-USAGE] Usage reset");
}
