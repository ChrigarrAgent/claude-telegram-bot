/**
 * Unit tests for AskUserQuestion handler.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  isAskUserQuestionInput,
  formatQuestionMessage,
  createQuestionKeyboard,
  formatSelectionsForClaude,
} from "../src/handlers/ask-user-question";
import { sessionManager, resetSessionManager } from "../src/session-manager";
import type { AskUserQuestion, PendingAskUserQuestion } from "../src/types";

describe("AskUserQuestion", () => {
  describe("isAskUserQuestionInput", () => {
    test("accepts valid single question input", () => {
      const input = {
        questions: [
          {
            question: "Which priority?",
            header: "Priority",
            multiSelect: false,
            options: [
              { label: "High", description: "For urgent tasks" },
              { label: "Low", description: "For non-urgent tasks" },
            ],
          },
        ],
      };
      expect(isAskUserQuestionInput(input)).toBe(true);
    });

    test("accepts valid multi-select question", () => {
      const input = {
        questions: [
          {
            question: "Which features?",
            header: "Features",
            multiSelect: true,
            options: [
              { label: "Auth", description: "Authentication" },
              { label: "API", description: "REST API" },
            ],
          },
        ],
      };
      expect(isAskUserQuestionInput(input)).toBe(true);
    });

    test("accepts multiple questions", () => {
      const input = {
        questions: [
          {
            question: "First question?",
            header: "Q1",
            multiSelect: false,
            options: [{ label: "A", description: "Option A" }],
          },
          {
            question: "Second question?",
            header: "Q2",
            multiSelect: true,
            options: [{ label: "B", description: "Option B" }],
          },
        ],
      };
      expect(isAskUserQuestionInput(input)).toBe(true);
    });

    test("rejects null input", () => {
      expect(isAskUserQuestionInput(null)).toBe(false);
    });

    test("rejects undefined input", () => {
      expect(isAskUserQuestionInput(undefined)).toBe(false);
    });

    test("rejects non-object input", () => {
      expect(isAskUserQuestionInput("string")).toBe(false);
      expect(isAskUserQuestionInput(123)).toBe(false);
    });

    test("rejects missing questions array", () => {
      expect(isAskUserQuestionInput({})).toBe(false);
      expect(isAskUserQuestionInput({ foo: "bar" })).toBe(false);
    });

    test("rejects empty questions array", () => {
      expect(isAskUserQuestionInput({ questions: [] })).toBe(false);
    });

    test("rejects invalid question structure - missing question text", () => {
      const input = {
        questions: [
          {
            header: "Priority",
            multiSelect: false,
            options: [{ label: "High", description: "Urgent" }],
          },
        ],
      };
      expect(isAskUserQuestionInput(input)).toBe(false);
    });

    test("rejects invalid question structure - missing header", () => {
      const input = {
        questions: [
          {
            question: "Which priority?",
            multiSelect: false,
            options: [{ label: "High", description: "Urgent" }],
          },
        ],
      };
      expect(isAskUserQuestionInput(input)).toBe(false);
    });

    test("rejects invalid question structure - missing multiSelect", () => {
      const input = {
        questions: [
          {
            question: "Which priority?",
            header: "Priority",
            options: [{ label: "High", description: "Urgent" }],
          },
        ],
      };
      expect(isAskUserQuestionInput(input)).toBe(false);
    });

    test("rejects invalid option structure - missing label", () => {
      const input = {
        questions: [
          {
            question: "Which priority?",
            header: "Priority",
            multiSelect: false,
            options: [{ description: "Urgent" }],
          },
        ],
      };
      expect(isAskUserQuestionInput(input)).toBe(false);
    });

    test("rejects invalid option structure - missing description", () => {
      const input = {
        questions: [
          {
            question: "Which priority?",
            header: "Priority",
            multiSelect: false,
            options: [{ label: "High" }],
          },
        ],
      };
      expect(isAskUserQuestionInput(input)).toBe(false);
    });
  });

  describe("formatQuestionMessage", () => {
    const sampleQuestion: AskUserQuestion = {
      question: "Which priority level should we use?",
      header: "Priority",
      multiSelect: false,
      options: [
        { label: "High", description: "For urgent tasks" },
        { label: "Medium", description: "For standard tasks" },
        { label: "Low", description: "For non-urgent items" },
      ],
    };

    test("includes project name in headline", () => {
      const result = formatQuestionMessage(sampleQuestion, "my-project");
      expect(result).toContain("<b>my-project</b>");
    });

    test("includes header in headline", () => {
      const result = formatQuestionMessage(sampleQuestion, "my-project");
      expect(result).toContain("<b>Priority</b>");
    });

    test("includes question text", () => {
      const result = formatQuestionMessage(sampleQuestion, "my-project");
      expect(result).toContain("Which priority level should we use?");
    });

    test("formats options with labels and descriptions", () => {
      const result = formatQuestionMessage(sampleQuestion, "my-project");
      expect(result).toContain("<b>High</b>");
      expect(result).toContain("For urgent tasks");
      expect(result).toContain("<b>Medium</b>");
      expect(result).toContain("For standard tasks");
    });

    test("shows selected state for multi-select", () => {
      const multiSelectQuestion: AskUserQuestion = {
        ...sampleQuestion,
        multiSelect: true,
      };
      const selectedIndices = new Set([0, 2]);
      const result = formatQuestionMessage(multiSelectQuestion, "my-project", selectedIndices);

      // High (index 0) and Low (index 2) should be marked as selected
      expect(result).toContain("[selected]");
    });

    test("escapes HTML in question text", () => {
      const questionWithHtml: AskUserQuestion = {
        ...sampleQuestion,
        question: "Use <script> tag?",
      };
      const result = formatQuestionMessage(questionWithHtml, "my-project");
      expect(result).toContain("&lt;script&gt;");
      expect(result).not.toContain("<script>");
    });

    test("escapes HTML in project name", () => {
      const result = formatQuestionMessage(sampleQuestion, "<script>evil</script>");
      expect(result).toContain("&lt;script&gt;");
    });
  });

  describe("createQuestionKeyboard", () => {
    const sampleQuestion: AskUserQuestion = {
      question: "Which priority?",
      header: "Priority",
      multiSelect: false,
      options: [
        { label: "High", description: "Urgent" },
        { label: "Medium", description: "Standard" },
        { label: "Low", description: "Non-urgent" },
      ],
    };

    test("creates keyboard with correct callback data format", () => {
      const keyboard = createQuestionKeyboard(
        sampleQuestion,
        new Set(),
        "req123",
        0
      );

      // Get the raw keyboard structure
      const rows = keyboard.inline_keyboard;

      // Should have option buttons + Other
      expect(rows.length).toBeGreaterThan(0);

      // Check first button callback format
      const firstButton = rows[0]![0]! as { text: string; callback_data: string };
      expect(firstButton.callback_data).toBe("askuserq:req123:0:0");
    });

    test("always includes Other button", () => {
      const keyboard = createQuestionKeyboard(
        sampleQuestion,
        new Set(),
        "req123",
        0
      );

      const rows = keyboard.inline_keyboard;
      const allButtons = rows.flat() as Array<{ text: string; callback_data: string }>;
      const otherButton = allButtons.find((btn) =>
        btn.text.includes("Other")
      );

      expect(otherButton).toBeDefined();
      expect(otherButton?.callback_data).toBe("askuserq:req123:0:other");
    });

    test("adds Done and Clear for multi-select", () => {
      const multiSelectQuestion: AskUserQuestion = {
        ...sampleQuestion,
        multiSelect: true,
      };

      const keyboard = createQuestionKeyboard(
        multiSelectQuestion,
        new Set(),
        "req123",
        0
      );

      const rows = keyboard.inline_keyboard;
      const allButtons = rows.flat() as Array<{ text: string; callback_data: string }>;

      const doneButton = allButtons.find((btn) => btn.text.includes("Done"));
      const clearButton = allButtons.find((btn) => btn.text.includes("Clear"));

      expect(doneButton).toBeDefined();
      expect(doneButton?.callback_data).toBe("askuserq:req123:0:done");
      expect(clearButton).toBeDefined();
      expect(clearButton?.callback_data).toBe("askuserq:req123:0:clear");
    });

    test("does not add Done/Clear for single-select", () => {
      const keyboard = createQuestionKeyboard(
        sampleQuestion,
        new Set(),
        "req123",
        0
      );

      const rows = keyboard.inline_keyboard;
      const allButtons = rows.flat() as Array<{ text: string; callback_data: string }>;

      const doneButton = allButtons.find((btn) => btn.text.includes("Done"));
      const clearButton = allButtons.find((btn) => btn.text.includes("Clear"));

      expect(doneButton).toBeUndefined();
      expect(clearButton).toBeUndefined();
    });

    test("shows checkmarks for selected options in multi-select", () => {
      const multiSelectQuestion: AskUserQuestion = {
        ...sampleQuestion,
        multiSelect: true,
      };

      const keyboard = createQuestionKeyboard(
        multiSelectQuestion,
        new Set([0, 2]), // High and Low selected
        "req123",
        0
      );

      const rows = keyboard.inline_keyboard;
      const allButtons = rows.flat() as Array<{ text: string; callback_data: string }>;

      // Find option buttons (exclude Done, Clear, Other)
      const optionButtons = allButtons.filter(
        (btn) =>
          !btn.text.includes("Done") &&
          !btn.text.includes("Clear") &&
          !btn.text.includes("Other")
      );

      // High (index 0) should have checkmark
      expect(optionButtons[0]?.text).toContain("\u2713");
      // Medium (index 1) should not have checkmark
      expect(optionButtons[1]?.text).not.toContain("\u2713");
      // Low (index 2) should have checkmark
      expect(optionButtons[2]?.text).toContain("\u2713");
    });

    test("truncates long option labels", () => {
      const longLabelQuestion: AskUserQuestion = {
        question: "Choose?",
        header: "Test",
        multiSelect: false,
        options: [
          {
            label: "This is a very long option label that exceeds the maximum allowed length for buttons",
            description: "Long option",
          },
        ],
      };

      const keyboard = createQuestionKeyboard(
        longLabelQuestion,
        new Set(),
        "req123",
        0
      );

      const rows = keyboard.inline_keyboard;
      const firstButton = rows[0]![0]!;

      // Button text should be truncated (max 30 chars based on BUTTON_LABEL_MAX_LENGTH)
      expect(firstButton.text.length).toBeLessThanOrEqual(30);
      expect(firstButton.text).toContain("...");
    });
  });

  describe("formatSelectionsForClaude", () => {
    const sampleQuestion: AskUserQuestion = {
      question: "Which features?",
      header: "Features",
      multiSelect: true,
      options: [
        { label: "Auth", description: "Authentication" },
        { label: "API", description: "REST API" },
        { label: "UI", description: "User Interface" },
      ],
    };

    test("formats single selection", () => {
      const result = formatSelectionsForClaude(sampleQuestion, new Set([0]));
      expect(result).toBe("Auth");
    });

    test("formats multiple selections", () => {
      const result = formatSelectionsForClaude(sampleQuestion, new Set([0, 2]));
      expect(result).toBe("Auth, UI");
    });

    test("returns empty string for no selections", () => {
      const result = formatSelectionsForClaude(sampleQuestion, new Set());
      expect(result).toBe("");
    });

    test("ignores invalid indices", () => {
      const result = formatSelectionsForClaude(sampleQuestion, new Set([0, 99]));
      expect(result).toBe("Auth");
    });
  });
});

describe("SessionManager pending questions", () => {
  beforeEach(() => {
    resetSessionManager();
  });

  test("stores and retrieves pending question", () => {
    const pending: PendingAskUserQuestion = {
      requestId: "req123",
      projectName: "test-project",
      chatId: 12345,
      messageIds: [1],
      questions: [
        {
          question: "Test?",
          header: "Test",
          multiSelect: false,
          options: [{ label: "A", description: "Option A" }],
        },
      ],
      currentQuestionIndex: 0,
      selectedIndices: new Map(),
      awaitingFreeText: false,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600000), // 10 min from now
    };

    sessionManager.setPendingQuestion("test-project", pending);

    // Set last used project for chat
    sessionManager.setLastUsed(12345, "test-project");

    const retrieved = sessionManager.getPendingQuestion(12345, "test-project");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.requestId).toBe("req123");
    expect(retrieved?.projectName).toBe("test-project");
  });

  test("isolates questions per project", () => {
    const pending1: PendingAskUserQuestion = {
      requestId: "req1",
      projectName: "project-a",
      chatId: 12345,
      messageIds: [1],
      questions: [],
      currentQuestionIndex: 0,
      selectedIndices: new Map(),
      awaitingFreeText: false,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600000),
    };

    const pending2: PendingAskUserQuestion = {
      requestId: "req2",
      projectName: "project-b",
      chatId: 12345,
      messageIds: [2],
      questions: [],
      currentQuestionIndex: 0,
      selectedIndices: new Map(),
      awaitingFreeText: false,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600000),
    };

    sessionManager.setPendingQuestion("project-a", pending1);
    sessionManager.setPendingQuestion("project-b", pending2);

    const retrieved1 = sessionManager.getPendingQuestion(12345, "project-a");
    const retrieved2 = sessionManager.getPendingQuestion(12345, "project-b");

    expect(retrieved1?.requestId).toBe("req1");
    expect(retrieved2?.requestId).toBe("req2");
  });

  test("handles question expiration", () => {
    const expiredPending: PendingAskUserQuestion = {
      requestId: "req-expired",
      projectName: "test-project",
      chatId: 12345,
      messageIds: [1],
      questions: [],
      currentQuestionIndex: 0,
      selectedIndices: new Map(),
      awaitingFreeText: false,
      createdAt: new Date(Date.now() - 700000), // 11 min ago
      expiresAt: new Date(Date.now() - 100000), // Already expired
    };

    sessionManager.setPendingQuestion("test-project", expiredPending);
    sessionManager.setLastUsed(12345, "test-project");

    const retrieved = sessionManager.getPendingQuestion(12345, "test-project");
    expect(retrieved).toBeNull();
  });

  test("toggles multi-select selections", () => {
    const pending: PendingAskUserQuestion = {
      requestId: "req123",
      projectName: "test-project",
      chatId: 12345,
      messageIds: [1],
      questions: [
        {
          question: "Features?",
          header: "Features",
          multiSelect: true,
          options: [
            { label: "A", description: "A" },
            { label: "B", description: "B" },
          ],
        },
      ],
      currentQuestionIndex: 0,
      selectedIndices: new Map([[0, new Set<number>()]]),
      awaitingFreeText: false,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600000),
    };

    sessionManager.setPendingQuestion("test-project", pending);

    // Select option 0
    let selections = sessionManager.updateQuestionSelection("test-project", 0, 0);
    expect(selections?.has(0)).toBe(true);

    // Select option 1
    selections = sessionManager.updateQuestionSelection("test-project", 0, 1);
    expect(selections?.has(0)).toBe(true);
    expect(selections?.has(1)).toBe(true);

    // Deselect option 0
    selections = sessionManager.updateQuestionSelection("test-project", 0, 0);
    expect(selections?.has(0)).toBe(false);
    expect(selections?.has(1)).toBe(true);
  });

  test("clears pending question", () => {
    const pending: PendingAskUserQuestion = {
      requestId: "req123",
      projectName: "test-project",
      chatId: 12345,
      messageIds: [1],
      questions: [],
      currentQuestionIndex: 0,
      selectedIndices: new Map(),
      awaitingFreeText: false,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600000),
    };

    sessionManager.setPendingQuestion("test-project", pending);
    sessionManager.setLastUsed(12345, "test-project");

    // Verify it exists
    expect(sessionManager.getPendingQuestion(12345, "test-project")).not.toBeNull();

    // Clear it
    sessionManager.clearPendingQuestion("test-project");

    // Verify it's gone
    expect(sessionManager.getPendingQuestion(12345, "test-project")).toBeNull();
  });

  test("returns null for non-existent pending question", () => {
    const result = sessionManager.getPendingQuestion(99999, "non-existent");
    expect(result).toBeNull();
  });

  test("returns null for wrong chat ID", () => {
    const pending: PendingAskUserQuestion = {
      requestId: "req123",
      projectName: "test-project",
      chatId: 12345,
      messageIds: [1],
      questions: [],
      currentQuestionIndex: 0,
      selectedIndices: new Map(),
      awaitingFreeText: false,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600000),
    };

    sessionManager.setPendingQuestion("test-project", pending);

    // Try to get with wrong chat ID
    const result = sessionManager.getPendingQuestion(99999, "test-project");
    expect(result).toBeNull();
  });
});
