/**
 * Safety confirmation system for Claude Telegram Bot.
 *
 * Handles dangerous commands and file operations through Telegram inline buttons.
 * Similar to ask_user system but for security confirmations.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { randomBytes } from "crypto";

export interface SafetyRequest {
  request_id: string;
  chat_id: number;
  status: "pending" | "sent" | "allowed" | "denied";
  type: "command" | "file_operation";
  action: string; // The command or operation description
  details: string; // Full command or file path
  timestamp: string;
}

/**
 * Create a unique request ID.
 */
function generateRequestId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Request confirmation for a dangerous operation.
 * Returns the request ID.
 */
export async function requestSafetyConfirmation(
  ctx: Context,
  chatId: number,
  type: "command" | "file_operation",
  action: string,
  details: string
): Promise<string> {
  const requestId = generateRequestId();

  const request: SafetyRequest = {
    request_id: requestId,
    chat_id: chatId,
    status: "pending",
    type,
    action,
    details,
    timestamp: new Date().toISOString(),
  };

  // Save request to temp file
  const filepath = `/tmp/safety-confirm-${requestId}.json`;
  await Bun.write(filepath, JSON.stringify(request, null, 2));

  // Create inline keyboard
  const keyboard = new InlineKeyboard()
    .text("✅ Allow", `safety:${requestId}:allow`)
    .text("❌ Skip", `safety:${requestId}:deny`);

  // Send confirmation message
  const emoji = type === "command" ? "⚠️" : "🔒";
  await ctx.reply(
    `${emoji} <b>Safety Confirmation Required</b>\n\n` +
    `<b>Action:</b> ${escapeHtml(action)}\n` +
    `<b>Details:</b> <code>${escapeHtml(details)}</code>\n\n` +
    `Choose an option:`,
    {
      parse_mode: "HTML",
      reply_markup: keyboard
    }
  );

  return requestId;
}

/**
 * Wait for user's safety confirmation decision.
 * Polls the temp file until status changes from "pending".
 * Returns true if allowed, false if denied.
 * Throws error on timeout.
 */
export async function waitForSafetyDecision(
  requestId: string,
  timeoutMs = 300000 // 5 minutes default
): Promise<boolean> {
  const filepath = `/tmp/safety-confirm-${requestId}.json`;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const file = Bun.file(filepath);
      if (await file.exists()) {
        const text = await file.text();
        const request: SafetyRequest = JSON.parse(text);

        if (request.status === "allowed") {
          // Clean up file
          await Bun.write(filepath, ""); // Clear content
          return true;
        }

        if (request.status === "denied") {
          // Clean up file
          await Bun.write(filepath, "");
          return false;
        }
      }
    } catch (error) {
      console.warn(`Error checking safety confirmation file: ${error}`);
    }

    // Poll every 500ms
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Timeout - auto-deny for safety
  console.warn(`Safety confirmation timeout for request ${requestId}`);
  try {
    await Bun.write(filepath, "");
  } catch {}
  throw new Error("Safety confirmation timeout - operation cancelled");
}

/**
 * Update safety request status (called by callback handler).
 */
export async function updateSafetyRequest(
  requestId: string,
  decision: "allowed" | "denied"
): Promise<boolean> {
  const filepath = `/tmp/safety-confirm-${requestId}.json`;

  try {
    const file = Bun.file(filepath);
    if (!(await file.exists())) {
      console.warn(`Safety request file not found: ${requestId}`);
      return false;
    }

    const text = await file.text();
    const request: SafetyRequest = JSON.parse(text);

    request.status = decision;
    await Bun.write(filepath, JSON.stringify(request, null, 2));

    return true;
  } catch (error) {
    console.error(`Failed to update safety request ${requestId}:`, error);
    return false;
  }
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
