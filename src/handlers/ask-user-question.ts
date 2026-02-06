/**
 * AskUserQuestion handler for Claude Telegram Bot.
 *
 * Handles interactive button questions from the AskUserQuestion tool format
 * used by GSD and similar Claude Code plugins.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sessionManager } from "../session-manager";
import { BUTTON_LABEL_MAX_LENGTH } from "../config";
import { escapeHtml } from "../formatting";
import type {
  AskUserQuestion,
  AskUserQuestionInput,
  AskUserQuestionOption,
  PendingAskUserQuestion,
} from "../types";

// Question timeout in milliseconds (10 minutes)
const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Type guard to check if tool input is AskUserQuestion format.
 */
export function isAskUserQuestionInput(
  toolInput: unknown
): toolInput is AskUserQuestionInput {
  if (!toolInput || typeof toolInput !== "object") return false;

  const input = toolInput as Record<string, unknown>;
  if (!Array.isArray(input.questions)) return false;
  if (input.questions.length === 0) return false;

  // Validate each question has required fields
  for (const q of input.questions) {
    if (typeof q !== "object" || q === null) return false;
    const question = q as Record<string, unknown>;
    if (typeof question.question !== "string") return false;
    if (typeof question.header !== "string") return false;
    if (typeof question.multiSelect !== "boolean") return false;
    if (!Array.isArray(question.options)) return false;

    // Validate options
    for (const opt of question.options) {
      if (typeof opt !== "object" || opt === null) return false;
      const option = opt as Record<string, unknown>;
      if (typeof option.label !== "string") return false;
      if (typeof option.description !== "string") return false;
    }
  }

  return true;
}

/**
 * Generate a unique request ID.
 */
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Truncate text to max length, adding ellipsis if needed.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Format a question message with project name, header, and options.
 */
export function formatQuestionMessage(
  question: AskUserQuestion,
  projectAlias: string,
  selectedIndices?: Set<number>
): string {
  const lines: string[] = [];

  // Project and header headline
  lines.push(`<b>${escapeHtml(projectAlias)}</b> | <b>${escapeHtml(question.header)}</b>`);
  lines.push("");

  // Question text
  lines.push(escapeHtml(question.question));
  lines.push("");

  // Options with descriptions
  lines.push("<b>Options:</b>");
  question.options.forEach((opt, idx) => {
    const isSelected = selectedIndices?.has(idx) ?? false;
    const checkmark = isSelected ? " [selected]" : "";
    const label = escapeHtml(opt.label);
    const desc = escapeHtml(opt.description);
    lines.push(`  - <b>${label}</b>${checkmark} - ${desc}`);
  });

  return lines.join("\n");
}

/**
 * Create inline keyboard for a question.
 */
export function createQuestionKeyboard(
  question: AskUserQuestion,
  selectedIndices: Set<number>,
  requestId: string,
  questionIndex: number
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const buttonsPerRow = 2;
  let rowButtons = 0;

  // Add option buttons
  question.options.forEach((opt, optIdx) => {
    const isSelected = selectedIndices.has(optIdx);
    const prefix = question.multiSelect && isSelected ? "\u2713 " : "";
    const label = truncate(prefix + opt.label, BUTTON_LABEL_MAX_LENGTH);
    const callbackData = `askuserq:${requestId}:${questionIndex}:${optIdx}`;

    keyboard.text(label, callbackData);
    rowButtons++;

    if (rowButtons >= buttonsPerRow) {
      keyboard.row();
      rowButtons = 0;
    }
  });

  // End current row if needed
  if (rowButtons > 0) {
    keyboard.row();
  }

  // For multi-select, add Done and Clear buttons
  if (question.multiSelect) {
    keyboard.text("\u2705 Done", `askuserq:${requestId}:${questionIndex}:done`);
    keyboard.text("\u274C Clear", `askuserq:${requestId}:${questionIndex}:clear`);
    keyboard.row();
  }

  // Always add "Other" button for free text input
  keyboard.text("\u270F\uFE0F Other", `askuserq:${requestId}:${questionIndex}:other`);

  return keyboard;
}

/**
 * Display AskUserQuestion(s) to the user with interactive buttons.
 * Returns true if questions were displayed successfully.
 */
export async function displayAskUserQuestions(
  ctx: Context,
  input: AskUserQuestionInput,
  projectName: string,
  projectAlias: string,
  chatId: number
): Promise<boolean> {
  if (!input.questions || input.questions.length === 0) {
    return false;
  }

  const requestId = generateRequestId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUESTION_TIMEOUT_MS);

  // Create pending question state
  const pending: PendingAskUserQuestion = {
    requestId,
    projectName,
    chatId,
    messageIds: [],
    questions: input.questions,
    currentQuestionIndex: 0,
    selectedIndices: new Map(),
    awaitingFreeText: false,
    createdAt: now,
    expiresAt,
  };

  // Initialize selection sets for each question
  for (let i = 0; i < input.questions.length; i++) {
    pending.selectedIndices.set(i, new Set());
  }

  // Store pending state
  sessionManager.setPendingQuestion(projectName, pending);

  // Send the first question
  const question = input.questions[0]!;
  const messageText = formatQuestionMessage(
    question,
    projectAlias,
    pending.selectedIndices.get(0)
  );
  const keyboard = createQuestionKeyboard(
    question,
    pending.selectedIndices.get(0)!,
    requestId,
    0
  );

  try {
    const msg = await ctx.reply(messageText, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    pending.messageIds.push(msg.message_id);
    return true;
  } catch (error) {
    console.error("Failed to display AskUserQuestion:", error);
    sessionManager.clearPendingQuestion(projectName);
    return false;
  }
}

/**
 * Handle free text response to a pending question.
 * Called from text handler when user types a response.
 */
export async function handleFreeTextQuestionResponse(
  ctx: Context,
  text: string,
  pending: PendingAskUserQuestion
): Promise<void> {
  // Clear the awaitingFreeText flag
  pending.awaitingFreeText = false;

  // Format the response
  const question = pending.questions[pending.currentQuestionIndex];
  const header = question?.header || "Response";

  // Try to delete the "Please type your response" message if we can
  // (We don't track this message ID currently, so this is best-effort)

  // Update the original question message to show the response
  if (pending.messageIds.length > 0) {
    const lastMsgId = pending.messageIds[pending.messageIds.length - 1]!;
    try {
      await ctx.api.editMessageText(
        pending.chatId,
        lastMsgId,
        `\u2713 <b>${escapeHtml(header)}:</b> ${escapeHtml(text)}`,
        { parse_mode: "HTML" }
      );
    } catch (error) {
      console.debug("Failed to edit question message after free text:", error);
    }
  }

  // Clear the pending question
  sessionManager.clearPendingQuestion(pending.projectName);

  // Note: The text will be sent to Claude by the text handler
  // since we don't return early from that handler
}

/**
 * Get selections as formatted text for sending to Claude.
 */
export function formatSelectionsForClaude(
  question: AskUserQuestion,
  selectedIndices: Set<number>
): string {
  const selectedLabels: string[] = [];
  for (const idx of selectedIndices) {
    if (idx >= 0 && idx < question.options.length) {
      selectedLabels.push(question.options[idx]!.label);
    }
  }
  return selectedLabels.join(", ");
}
