/**
 * File Forwarding Module
 *
 * Handles saving files forwarded from Telegram without parsing,
 * and managing large responses that exceed Telegram's message limits.
 */

import { existsSync, mkdirSync, writeFileSync, statSync, readdirSync, unlinkSync } from "fs";
import { basename, join, resolve } from "path";
import { ALLOWED_PATHS } from "./config";

export interface ForwardedFile {
  originalName: string;
  savedPath: string;
  projectName: string;
  timestamp: Date;
  size: number;
}

export interface SavedResponse {
  filePath: string;
  fileName: string;
}

/**
 * Sanitize filename to prevent directory traversal and special character issues
 */
export function sanitizeFilename(filename: string): string {
  // Remove all directory components (handles ../, ..\, etc.)
  let safe = basename(filename);

  // Remove special characters, keep only alphanumeric, dots, dashes, underscores
  safe = safe.replace(/[^a-zA-Z0-9._-]/g, "_");

  // Remove leading dots (hidden files)
  safe = safe.replace(/^\.+/, "");

  // Limit length to 100 characters
  if (safe.length > 100) {
    const ext = safe.split(".").pop() || "";
    const nameWithoutExt = safe.slice(0, safe.lastIndexOf(".") > 0 ? safe.lastIndexOf(".") : safe.length);
    safe = nameWithoutExt.slice(0, 95 - ext.length) + "." + ext;
  }

  // Ensure not empty after sanitization
  if (!safe || safe === "_" || safe === ".") {
    safe = `file_${Date.now()}`;
  }

  return safe;
}

/**
 * Get the storage directory for a specific subdirectory type
 * Creates the directory if it doesn't exist
 */
export function getFileStorageDir(
  projectDir: string,
  subdir: "files" | "responses"
): string {
  const storageDir = join(projectDir, ".claude-bot", subdir);

  // Create directory if it doesn't exist
  if (!existsSync(storageDir)) {
    mkdirSync(storageDir, { recursive: true });
    console.log(`[FILE-FORWARD] Created storage directory: ${storageDir}`);
  }

  return storageDir;
}

/**
 * Validate that a path is within allowed directories
 */
function validatePath(targetPath: string): boolean {
  const resolvedTarget = resolve(targetPath);

  // Check if path is within any allowed directory
  const isAllowed = ALLOWED_PATHS.some((allowedPath) => {
    const resolvedAllowed = resolve(allowedPath);
    return resolvedTarget.startsWith(resolvedAllowed);
  });

  if (!isAllowed) {
    throw new Error(`Path outside allowed directories: ${targetPath}`);
  }

  return true;
}

/**
 * Save a file to the project directory
 *
 * @param sourcePath - Path to the source file (usually in /tmp)
 * @param originalName - Original filename from Telegram
 * @param projectDir - Project directory to save to
 * @param subdir - Subdirectory type ("files" or "responses")
 * @returns Absolute path to saved file
 */
export async function saveFileToProject(
  sourcePath: string,
  originalName: string,
  projectDir: string,
  subdir: "files" | "responses"
): Promise<string> {
  // Sanitize filename
  const safeName = sanitizeFilename(originalName);

  // Get storage directory
  const storageDir = getFileStorageDir(projectDir, subdir);

  // Create filename with timestamp prefix to ensure uniqueness
  const timestamp = Date.now();
  const fileName = `${timestamp}_${safeName}`;
  const targetPath = join(storageDir, fileName);

  // Validate target path is within allowed directories
  validatePath(targetPath);

  // Check if source file exists
  if (!existsSync(sourcePath)) {
    throw new Error(`Source file does not exist: ${sourcePath}`);
  }

  // Get file size
  const stats = statSync(sourcePath);
  const fileSize = stats.size;

  // Read source file
  const buffer = await Bun.file(sourcePath).arrayBuffer();

  // Write to target location (atomic operation)
  writeFileSync(targetPath, new Uint8Array(buffer));

  console.log(
    `[FILE-FORWARD] Saved ${subdir} file: ${safeName} → ${targetPath} (${(fileSize / 1024).toFixed(1)} KB)`
  );

  return targetPath;
}

/**
 * Check if a response should be saved to file based on character count
 */
export function shouldSaveResponseToFile(
  content: string,
  threshold: number = 3500
): boolean {
  return content.length > threshold;
}

/**
 * Save a response to file
 *
 * @param content - The response content to save
 * @param projectDir - Project directory
 * @param projectName - Project name (for logging)
 * @returns Object with file path and filename
 */
export async function saveResponseToFile(
  content: string,
  projectDir: string,
  projectName: string
): Promise<SavedResponse> {
  const timestamp = Date.now();
  const fileName = `${timestamp}_response.md`;
  const storageDir = getFileStorageDir(projectDir, "responses");
  const filePath = join(storageDir, fileName);

  // Validate path
  validatePath(filePath);

  // Write content to file
  writeFileSync(filePath, content, "utf-8");

  const fileSize = Buffer.from(content).length;
  console.log(
    `[RESPONSE-SAVE] Response too large (${content.length} chars), saved to: ${filePath} (${(fileSize / 1024).toFixed(1)} KB)`
  );

  return { filePath, fileName };
}

/**
 * Generate a summary of the response content
 * Extracts key points and creates a concise overview
 */
export function generateResponseSummary(content: string, maxLength: number = 800): string {
  // Split into paragraphs
  const paragraphs = content.split(/\n\n+/).filter(p => p.trim());

  if (paragraphs.length === 0) {
    return content.slice(0, maxLength);
  }

  // Extract first paragraph (often contains the summary)
  const firstPara = paragraphs[0] || "";

  // If first paragraph is short enough, use it
  if (firstPara.length <= maxLength) {
    return firstPara;
  }

  // Otherwise, try to split at sentence boundaries
  const sentences = firstPara.split(/[.!?]+\s+/);
  let summary = "";

  for (const sentence of sentences) {
    const testSummary = summary ? summary + ". " + sentence : sentence;
    if (testSummary.length <= maxLength) {
      summary = testSummary;
    } else {
      break;
    }
  }

  // If we got nothing, just truncate
  if (!summary) {
    summary = firstPara.slice(0, maxLength);
  }

  return summary + (summary.length < firstPara.length ? "..." : "");
}

/**
 * Clean up old files in a project directory
 *
 * @param projectDir - Project directory
 * @param maxAgeMs - Maximum age in milliseconds (files older than this are deleted)
 * @returns Number of files deleted
 */
export async function cleanupOldFiles(
  projectDir: string,
  maxAgeMs: number
): Promise<number> {
  let deletedCount = 0;
  const now = Date.now();

  // Clean up all subdirectories (files, responses, tables)
  for (const subdir of ["files", "responses", "tables"] as const) {
    const storageDir = join(projectDir, ".claude-bot", subdir);

    // Skip if directory doesn't exist
    if (!existsSync(storageDir)) {
      continue;
    }

    try {
      const files = readdirSync(storageDir);

      for (const file of files) {
        const filePath = join(storageDir, file);

        try {
          const stats = statSync(filePath);
          const age = now - stats.mtimeMs;

          if (age > maxAgeMs) {
            unlinkSync(filePath);
            deletedCount++;
            console.log(`[FILE-CLEANUP] Deleted old file: ${filePath} (age: ${(age / (24 * 60 * 60 * 1000)).toFixed(1)} days)`);
          }
        } catch (error) {
          console.error(`[FILE-CLEANUP] Error processing file ${filePath}:`, error);
        }
      }
    } catch (error) {
      console.error(`[FILE-CLEANUP] Error reading directory ${storageDir}:`, error);
    }
  }

  return deletedCount;
}
