/**
 * File sending utilities for Claude Telegram Bot.
 *
 * Allows Claude to send files back to the user via Telegram.
 */

import { existsSync, statSync } from "fs";
import { resolve, isAbsolute, basename } from "path";
import { InputFile } from "grammy";
import type { Context, Api } from "grammy";
import { ALLOWED_PATHS } from "./config";

/**
 * Parse [SEND_FILE: path] markers from text.
 * Returns {cleanText, filePaths} where cleanText has markers removed.
 */
export function parseFileSendMarkers(text: string): { cleanText: string; filePaths: string[] } {
  const pattern = /\[SEND_FILE:\s*([^\]]+)\]/g;
  const filePaths: string[] = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const path = match[1]!.trim();
    filePaths.push(path);
  }

  // Remove markers from text
  const cleanText = text.replace(pattern, '').trim();

  return { cleanText, filePaths };
}

/**
 * Validate file path against security constraints.
 * Returns {valid, error, resolvedPath}
 */
export function validateFilePath(
  filePath: string,
  workingDir: string
): { valid: boolean; error?: string; resolvedPath?: string } {
  // Resolve relative paths against working directory
  const resolvedPath = isAbsolute(filePath)
    ? filePath
    : resolve(workingDir, filePath);

  // Check if file exists
  if (!existsSync(resolvedPath)) {
    return {
      valid: false,
      error: `File not found: ${filePath}`
    };
  }

  // Check if it's a file (not a directory)
  try {
    const stats = statSync(resolvedPath);
    if (!stats.isFile()) {
      return {
        valid: false,
        error: `Path is not a file: ${filePath}`
      };
    }
  } catch (error) {
    return {
      valid: false,
      error: `Cannot access file: ${filePath}`
    };
  }

  // Check if file is within allowed paths
  const isAllowed = ALLOWED_PATHS.some(allowedPath =>
    resolvedPath.startsWith(allowedPath)
  );

  if (!isAllowed) {
    return {
      valid: false,
      error: `File outside allowed directories: ${filePath}`
    };
  }

  return { valid: true, resolvedPath };
}

/**
 * Detect file type and return appropriate Telegram send method.
 */
export function detectFileType(filePath: string): 'photo' | 'video' | 'audio' | 'document' {
  const ext = filePath.toLowerCase().split('.').pop() || '';

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
  const videoExts = ['mp4', 'webm', 'avi', 'mov', 'mkv'];
  const audioExts = ['mp3', 'ogg', 'wav', 'm4a', 'flac'];

  if (imageExts.includes(ext)) return 'photo';
  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  return 'document';
}

/**
 * Send a file via Telegram using the appropriate method.
 * Returns true on success, false on failure.
 */
export async function sendFile(
  ctx: Context,
  filePath: string,
  workingDir: string,
  caption?: string
): Promise<boolean> {
  const validation = validateFilePath(filePath, workingDir);

  if (!validation.valid) {
    await ctx.reply(`⚠️ Cannot send file: ${validation.error}`);
    console.error(`[FILE-SEND] Validation failed: ${validation.error}`);
    return false;
  }

  const resolvedPath = validation.resolvedPath!;
  const fileType = detectFileType(resolvedPath);
  const fileName = basename(resolvedPath);

  try {
    const inputFile = new InputFile(resolvedPath);
    const options = caption ? { caption } : {};

    console.log(`[FILE-SEND] Sending ${fileType}: ${resolvedPath}`);

    switch (fileType) {
      case 'photo':
        await ctx.replyWithPhoto(inputFile, options);
        break;
      case 'video':
        await ctx.replyWithVideo(inputFile, options);
        break;
      case 'audio':
        await ctx.replyWithAudio(inputFile, options);
        break;
      case 'document':
      default:
        await ctx.replyWithDocument(inputFile, {
          ...options,
          caption: caption || fileName
        });
        break;
    }

    console.log(`[FILE-SEND] ✅ Successfully sent: ${fileName}`);
    return true;
  } catch (error) {
    console.error(`[FILE-SEND] ❌ Failed to send file:`, error);
    await ctx.reply(`⚠️ Failed to send file: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Send a file via Bot API (no ctx needed).
 * Returns true on success, false on failure.
 */
export async function sendFileViaApi(
  api: Api,
  chatId: number,
  filePath: string,
  workingDir: string,
  caption?: string
): Promise<boolean> {
  const validation = validateFilePath(filePath, workingDir);

  if (!validation.valid) {
    await api.sendMessage(chatId, `⚠️ Cannot send file: ${validation.error}`);
    console.error(`[FILE-SEND] Validation failed: ${validation.error}`);
    return false;
  }

  const resolvedPath = validation.resolvedPath!;
  const fileType = detectFileType(resolvedPath);
  const fileName = basename(resolvedPath);

  try {
    const inputFile = new InputFile(resolvedPath);
    const options = caption ? { caption } : {};

    console.log(`[FILE-SEND] Sending ${fileType} via API: ${resolvedPath}`);

    switch (fileType) {
      case 'photo':
        await api.sendPhoto(chatId, inputFile, options);
        break;
      case 'video':
        await api.sendVideo(chatId, inputFile, options);
        break;
      case 'audio':
        await api.sendAudio(chatId, inputFile, options);
        break;
      case 'document':
      default:
        await api.sendDocument(chatId, inputFile, {
          ...options,
          caption: caption || fileName
        });
        break;
    }

    console.log(`[FILE-SEND] ✅ Successfully sent via API: ${fileName}`);
    return true;
  } catch (error) {
    console.error(`[FILE-SEND] ❌ Failed to send file via API:`, error);
    await api.sendMessage(chatId, `⚠️ Failed to send file: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
