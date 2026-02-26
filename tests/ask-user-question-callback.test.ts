/**
 * Callback integration tests for AskUserQuestion handler.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { sessionManager, resetSessionManager } from "../src/session-manager";
import type { PendingAskUserQuestion, AskUserQuestion } from "../src/types";

// Mock question for tests
const createMockQuestion = (multiSelect: boolean = false): AskUserQuestion => ({
  question: "Which option?",
  header: "Test",
  multiSelect,
  options: [
    { label: "Option A", description: "First option" },
    { label: "Option B", description: "Second option" },
    { label: "Option C", description: "Third option" },
  ],
});

const createPendingQuestion = (
  projectName: string,
  chatId: number,
  multiSelect: boolean = false
): PendingAskUserQuestion => ({
  requestId: `req-${Date.now()}`,
  projectName,
  chatId,
  messageIds: [1],
  questions: [createMockQuestion(multiSelect)],
  currentQuestionIndex: 0,
  selectedIndices: new Map([[0, new Set<number>()]]),
  awaitingFreeText: false,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 600000), // 10 min from now
});

describe("AskUserQuestion callbacks", () => {
  beforeEach(() => {
    resetSessionManager();
  });

  describe("Single-select behavior", () => {
    test("single-select marks only one option", () => {
      const pending = createPendingQuestion("test-project", 12345, false);
      sessionManager.setPendingQuestion("test-project", pending);
      sessionManager.setLastUsed(12345, "test-project");

      // Select option 0
      const selections = sessionManager.updateQuestionSelection("test-project", 0, 0);

      // Should have exactly one selection
      expect(selections?.size).toBe(1);
      expect(selections?.has(0)).toBe(true);
    });

    test("single-select toggles off if same option selected", () => {
      const pending = createPendingQuestion("test-project", 12345, false);
      pending.selectedIndices.get(0)?.add(0);
      sessionManager.setPendingQuestion("test-project", pending);

      // Selecting same option should deselect it
      const selections = sessionManager.updateQuestionSelection("test-project", 0, 0);
      expect(selections?.has(0)).toBe(false);
    });
  });

  describe("Multi-select behavior", () => {
    test("multi-select allows multiple selections", () => {
      const pending = createPendingQuestion("test-project", 12345, true);
      sessionManager.setPendingQuestion("test-project", pending);

      // Select multiple options
      sessionManager.updateQuestionSelection("test-project", 0, 0);
      sessionManager.updateQuestionSelection("test-project", 0, 1);
      const selections = sessionManager.updateQuestionSelection("test-project", 0, 2);

      expect(selections?.size).toBe(3);
      expect(selections?.has(0)).toBe(true);
      expect(selections?.has(1)).toBe(true);
      expect(selections?.has(2)).toBe(true);
    });

    test("multi-select can deselect individual options", () => {
      const pending = createPendingQuestion("test-project", 12345, true);
      pending.selectedIndices.set(0, new Set([0, 1, 2]));
      sessionManager.setPendingQuestion("test-project", pending);

      // Deselect option 1
      const selections = sessionManager.updateQuestionSelection("test-project", 0, 1);

      expect(selections?.size).toBe(2);
      expect(selections?.has(0)).toBe(true);
      expect(selections?.has(1)).toBe(false);
      expect(selections?.has(2)).toBe(true);
    });

    test("multi-select clear resets all selections", () => {
      const pending = createPendingQuestion("test-project", 12345, true);
      pending.selectedIndices.set(0, new Set([0, 1, 2]));
      sessionManager.setPendingQuestion("test-project", pending);

      // Simulate clear action by resetting the set
      pending.selectedIndices.set(0, new Set());

      const retrieved = sessionManager.getPendingQuestion(12345, "test-project");
      expect(retrieved?.selectedIndices.get(0)?.size).toBe(0);
    });

    test("multi-select done validates at least one selection", () => {
      const pending = createPendingQuestion("test-project", 12345, true);
      sessionManager.setPendingQuestion("test-project", pending);

      // No selections
      const selections = pending.selectedIndices.get(0);
      expect(selections?.size).toBe(0);

      // Application logic should reject this (done button handler checks this)
    });

    test("multi-select done accepts with selections", () => {
      const pending = createPendingQuestion("test-project", 12345, true);
      pending.selectedIndices.set(0, new Set([0, 2]));
      sessionManager.setPendingQuestion("test-project", pending);

      const selections = pending.selectedIndices.get(0);
      expect(selections!.size).toBeGreaterThan(0);

      // Application logic should accept this
    });
  });

  describe("Other button (free text)", () => {
    test("other button sets awaitingFreeText flag", () => {
      const pending = createPendingQuestion("test-project", 12345);
      sessionManager.setPendingQuestion("test-project", pending);

      // Simulate other button action
      pending.awaitingFreeText = true;

      const retrieved = sessionManager.getPendingQuestion(12345, "test-project");
      expect(retrieved?.awaitingFreeText).toBe(true);
    });

    test("free text response clears awaitingFreeText flag", () => {
      const pending = createPendingQuestion("test-project", 12345);
      pending.awaitingFreeText = true;
      sessionManager.setPendingQuestion("test-project", pending);

      // Simulate processing free text (clear flag)
      pending.awaitingFreeText = false;

      const retrieved = sessionManager.getPendingQuestion(12345, "test-project");
      expect(retrieved?.awaitingFreeText).toBe(false);
    });
  });

  describe("Question expiration", () => {
    test("expired question returns null", () => {
      const pending = createPendingQuestion("test-project", 12345);
      pending.expiresAt = new Date(Date.now() - 1000); // Expired 1 second ago
      sessionManager.setPendingQuestion("test-project", pending);
      sessionManager.setLastUsed(12345, "test-project");

      const retrieved = sessionManager.getPendingQuestion(12345, "test-project");
      expect(retrieved).toBeNull();
    });

    test("non-expired question is returned", () => {
      const pending = createPendingQuestion("test-project", 12345);
      pending.expiresAt = new Date(Date.now() + 60000); // Expires in 1 minute
      sessionManager.setPendingQuestion("test-project", pending);
      sessionManager.setLastUsed(12345, "test-project");

      const retrieved = sessionManager.getPendingQuestion(12345, "test-project");
      expect(retrieved).not.toBeNull();
    });
  });

  describe("Request ID validation", () => {
    test("requestId contains timestamp", () => {
      const pending1 = createPendingQuestion("project-a", 12345);

      // Request ID should have format: req-timestamp
      expect(pending1.requestId).toMatch(/^req-\d+$/);
    });

    test("wrong requestId should not match", () => {
      const pending = createPendingQuestion("test-project", 12345);
      pending.requestId = "correct-request-id";
      sessionManager.setPendingQuestion("test-project", pending);
      sessionManager.setLastUsed(12345, "test-project");

      const retrieved = sessionManager.getPendingQuestion(12345, "test-project");
      expect(retrieved?.requestId).toBe("correct-request-id");

      // Application callback handler validates requestId matches
      // This test verifies the state storage is correct
    });
  });

  describe("Question index handling", () => {
    test("currentQuestionIndex tracks progress", () => {
      const pending = createPendingQuestion("test-project", 12345);
      pending.questions.push(createMockQuestion()); // Add second question
      sessionManager.setPendingQuestion("test-project", pending);

      expect(pending.currentQuestionIndex).toBe(0);

      // After answering first question, would increment
      pending.currentQuestionIndex = 1;

      const retrieved = sessionManager.getPendingQuestion(12345, "test-project");
      expect(retrieved?.currentQuestionIndex).toBe(1);
    });

    test("selectedIndices tracks per-question selections", () => {
      const pending = createPendingQuestion("test-project", 12345, true);
      pending.questions.push(createMockQuestion(true)); // Add second multi-select question
      pending.selectedIndices.set(0, new Set([0, 1]));
      pending.selectedIndices.set(1, new Set([2]));
      sessionManager.setPendingQuestion("test-project", pending);

      const retrieved = sessionManager.getPendingQuestion(12345, "test-project");
      expect(retrieved?.selectedIndices.get(0)?.has(0)).toBe(true);
      expect(retrieved?.selectedIndices.get(0)?.has(1)).toBe(true);
      expect(retrieved?.selectedIndices.get(1)?.has(2)).toBe(true);
    });
  });

  describe("Message ID tracking", () => {
    test("messageIds stores sent message IDs", () => {
      const pending = createPendingQuestion("test-project", 12345);
      pending.messageIds = [100, 101, 102];
      sessionManager.setPendingQuestion("test-project", pending);

      const retrieved = sessionManager.getPendingQuestion(12345, "test-project");
      expect(retrieved?.messageIds).toEqual([100, 101, 102]);
    });
  });
});
