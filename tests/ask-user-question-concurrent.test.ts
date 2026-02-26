/**
 * Concurrent project tests for AskUserQuestion handler.
 *
 * Tests that multiple projects can have independent pending questions
 * and that answering one doesn't affect another.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { sessionManager, resetSessionManager } from "../src/session-manager";
import type { PendingAskUserQuestion, AskUserQuestion } from "../src/types";

const createMockQuestion = (header: string): AskUserQuestion => ({
  question: `Question for ${header}?`,
  header,
  multiSelect: false,
  options: [
    { label: "Yes", description: "Confirm" },
    { label: "No", description: "Cancel" },
  ],
});

const createPendingQuestion = (
  projectName: string,
  chatId: number,
  requestId: string
): PendingAskUserQuestion => ({
  requestId,
  projectName,
  chatId,
  messageIds: [1],
  questions: [createMockQuestion(projectName)],
  currentQuestionIndex: 0,
  selectedIndices: new Map([[0, new Set<number>()]]),
  awaitingFreeText: false,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 600000),
});

describe("Concurrent project questions", () => {
  beforeEach(() => {
    resetSessionManager();
  });

  describe("Project isolation", () => {
    test("different projects have isolated pending questions", () => {
      const chatId = 12345;

      // Set up questions for two different projects
      const pendingA = createPendingQuestion("project-a", chatId, "req-a");
      const pendingB = createPendingQuestion("project-b", chatId, "req-b");

      sessionManager.setPendingQuestion("project-a", pendingA);
      sessionManager.setPendingQuestion("project-b", pendingB);

      // Both should exist independently
      const retrievedA = sessionManager.getPendingQuestion(chatId, "project-a");
      const retrievedB = sessionManager.getPendingQuestion(chatId, "project-b");

      expect(retrievedA).not.toBeNull();
      expect(retrievedB).not.toBeNull();
      expect(retrievedA?.requestId).toBe("req-a");
      expect(retrievedB?.requestId).toBe("req-b");
    });

    test("answering one project doesn't affect another", () => {
      const chatId = 12345;

      const pendingA = createPendingQuestion("project-a", chatId, "req-a");
      const pendingB = createPendingQuestion("project-b", chatId, "req-b");

      sessionManager.setPendingQuestion("project-a", pendingA);
      sessionManager.setPendingQuestion("project-b", pendingB);

      // "Answer" project-a by clearing it
      sessionManager.clearPendingQuestion("project-a");

      // Project-a should be gone
      expect(sessionManager.getPendingQuestion(chatId, "project-a")).toBeNull();

      // Project-b should still exist
      const retrievedB = sessionManager.getPendingQuestion(chatId, "project-b");
      expect(retrievedB).not.toBeNull();
      expect(retrievedB?.requestId).toBe("req-b");
    });

    test("selections are isolated per project", () => {
      const chatId = 12345;

      const pendingA = createPendingQuestion("project-a", chatId, "req-a");
      const pendingB = createPendingQuestion("project-b", chatId, "req-b");

      sessionManager.setPendingQuestion("project-a", pendingA);
      sessionManager.setPendingQuestion("project-b", pendingB);

      // Make selections in project-a
      sessionManager.updateQuestionSelection("project-a", 0, 0);

      // Make different selections in project-b
      sessionManager.updateQuestionSelection("project-b", 0, 1);

      // Verify selections are independent
      const selectionsA = sessionManager.getPendingQuestion(chatId, "project-a")
        ?.selectedIndices.get(0);
      const selectionsB = sessionManager.getPendingQuestion(chatId, "project-b")
        ?.selectedIndices.get(0);

      expect(selectionsA?.has(0)).toBe(true);
      expect(selectionsA?.has(1)).toBe(false);
      expect(selectionsB?.has(0)).toBe(false);
      expect(selectionsB?.has(1)).toBe(true);
    });
  });

  describe("Chat routing", () => {
    test("same chat can have questions in multiple projects", () => {
      const chatId = 12345;

      const pendingA = createPendingQuestion("project-a", chatId, "req-a");
      const pendingB = createPendingQuestion("project-b", chatId, "req-b");
      const pendingC = createPendingQuestion("project-c", chatId, "req-c");

      sessionManager.setPendingQuestion("project-a", pendingA);
      sessionManager.setPendingQuestion("project-b", pendingB);
      sessionManager.setPendingQuestion("project-c", pendingC);

      // All three should be retrievable by project name
      expect(sessionManager.getPendingQuestion(chatId, "project-a")?.requestId).toBe("req-a");
      expect(sessionManager.getPendingQuestion(chatId, "project-b")?.requestId).toBe("req-b");
      expect(sessionManager.getPendingQuestion(chatId, "project-c")?.requestId).toBe("req-c");
    });

    test("different chats can use the same project", () => {
      const chatId1 = 12345;
      const chatId2 = 67890;

      const pending1 = createPendingQuestion("shared-project", chatId1, "req-1");
      const pending2 = createPendingQuestion("shared-project", chatId2, "req-2");

      // When same project has different chat IDs, the second overwrites the first
      // This is expected behavior - only one pending question per project
      sessionManager.setPendingQuestion("shared-project", pending1);
      sessionManager.setPendingQuestion("shared-project", pending2);

      // Only the last one should exist
      const retrieved = sessionManager.getPendingQuestion(chatId2, "shared-project");
      expect(retrieved?.requestId).toBe("req-2");
      expect(retrieved?.chatId).toBe(chatId2);

      // Chat 1's question for this project is gone
      const retrieved1 = sessionManager.getPendingQuestion(chatId1, "shared-project");
      expect(retrieved1).toBeNull();
    });

    test("free text routes to correct project via last-used", () => {
      const chatId = 12345;

      const pendingA = createPendingQuestion("project-a", chatId, "req-a");
      pendingA.awaitingFreeText = true;

      sessionManager.setPendingQuestion("project-a", pendingA);
      sessionManager.setLastUsed(chatId, "project-a");

      // When no project specified, should find via last-used
      const retrieved = sessionManager.getPendingQuestion(chatId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.requestId).toBe("req-a");
      expect(retrieved?.awaitingFreeText).toBe(true);
    });

    test("free text routes correctly when multiple projects exist", () => {
      const chatId = 12345;

      const pendingA = createPendingQuestion("project-a", chatId, "req-a");
      const pendingB = createPendingQuestion("project-b", chatId, "req-b");
      pendingB.awaitingFreeText = true;

      sessionManager.setPendingQuestion("project-a", pendingA);
      sessionManager.setPendingQuestion("project-b", pendingB);

      // Set last-used to project-b (the one awaiting free text)
      sessionManager.setLastUsed(chatId, "project-b");

      // Should get project-b since it's last-used
      const retrieved = sessionManager.getPendingQuestion(chatId);
      expect(retrieved?.requestId).toBe("req-b");
      expect(retrieved?.awaitingFreeText).toBe(true);
    });
  });

  describe("Concurrent state changes", () => {
    test("updating one project's question index doesn't affect others", () => {
      const chatId = 12345;

      const pendingA = createPendingQuestion("project-a", chatId, "req-a");
      pendingA.questions.push(createMockQuestion("Q2"));
      const pendingB = createPendingQuestion("project-b", chatId, "req-b");

      sessionManager.setPendingQuestion("project-a", pendingA);
      sessionManager.setPendingQuestion("project-b", pendingB);

      // Advance project-a to next question
      pendingA.currentQuestionIndex = 1;

      // Project-b should still be at 0
      const retrievedB = sessionManager.getPendingQuestion(chatId, "project-b");
      expect(retrievedB?.currentQuestionIndex).toBe(0);

      // Project-a should be at 1
      const retrievedA = sessionManager.getPendingQuestion(chatId, "project-a");
      expect(retrievedA?.currentQuestionIndex).toBe(1);
    });

    test("clearing all questions for reset", () => {
      const chatId = 12345;

      sessionManager.setPendingQuestion("project-a", createPendingQuestion("project-a", chatId, "req-a"));
      sessionManager.setPendingQuestion("project-b", createPendingQuestion("project-b", chatId, "req-b"));
      sessionManager.setPendingQuestion("project-c", createPendingQuestion("project-c", chatId, "req-c"));

      // Reset should clear all
      resetSessionManager();

      expect(sessionManager.getPendingQuestion(chatId, "project-a")).toBeNull();
      expect(sessionManager.getPendingQuestion(chatId, "project-b")).toBeNull();
      expect(sessionManager.getPendingQuestion(chatId, "project-c")).toBeNull();
    });
  });

  describe("Edge cases", () => {
    test("get pending question with no projects set", () => {
      const result = sessionManager.getPendingQuestion(12345);
      expect(result).toBeNull();
    });

    test("get pending question with wrong chat ID", () => {
      const pending = createPendingQuestion("test-project", 12345, "req-1");
      sessionManager.setPendingQuestion("test-project", pending);

      // Try with different chat ID
      const result = sessionManager.getPendingQuestion(99999, "test-project");
      expect(result).toBeNull();
    });

    test("update selection returns null for non-existent project", () => {
      const result = sessionManager.updateQuestionSelection("non-existent", 0, 0);
      expect(result).toBeNull();
    });

    test("handles rapid selection updates", () => {
      const chatId = 12345;
      const pending = createPendingQuestion("test-project", chatId, "req-1");
      pending.questions[0]!.multiSelect = true;
      sessionManager.setPendingQuestion("test-project", pending);

      // Rapid fire selections
      for (let i = 0; i < 10; i++) {
        sessionManager.updateQuestionSelection("test-project", 0, 0);
      }

      // After 10 toggles (even), should be unselected
      const selections = sessionManager.getPendingQuestion(chatId, "test-project")
        ?.selectedIndices.get(0);
      expect(selections?.has(0)).toBe(false);

      // One more toggle
      sessionManager.updateQuestionSelection("test-project", 0, 0);

      // Now should be selected
      const selections2 = sessionManager.getPendingQuestion(chatId, "test-project")
        ?.selectedIndices.get(0);
      expect(selections2?.has(0)).toBe(true);
    });
  });
});
