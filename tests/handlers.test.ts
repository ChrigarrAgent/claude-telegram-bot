/**
 * Handler Integration Tests
 *
 * Tests the complete message handling pipeline including:
 * - Text handler routing
 * - Command handlers (status, resume, project)
 * - Project headers
 * - Callback handlers
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { sessionManager } from "../src/session-manager";
import { ClaudeSession } from "../src/session";
import type { Context } from "grammy";

// Mock Telegram context factory
function createMockContext(overrides: Partial<Context> = {}): Context {
  const messages: any[] = [];

  return {
    from: {
      id: 12345,
      is_bot: false,
      first_name: "Test",
      username: "testuser",
    },
    chat: {
      id: 67890,
      type: "private",
    },
    message: {
      message_id: 1,
      date: Date.now() / 1000,
      chat: { id: 67890, type: "private" },
      text: "test message",
    },
    callbackQuery: undefined,
    reply: async (text: string, options?: any) => {
      messages.push({ text, options });
      return {
        message_id: messages.length,
        date: Date.now() / 1000,
        chat: { id: 67890, type: "private" },
        text,
      };
    },
    replyWithChatAction: async (action: string) => {
      // Mock typing indicator
      return true;
    },
    answerCallbackQuery: async (options?: any) => {
      return true;
    },
    editMessageText: async (text: string, options?: any) => {
      messages.push({ type: "edit", text, options });
      return {
        message_id: 1,
        date: Date.now() / 1000,
        chat: { id: 67890, type: "private" },
        text,
      };
    },
    api: {
      editMessageText: async (chatId: any, messageId: any, text: any, options?: any) => {
        messages.push({ type: "api_edit", chatId, messageId, text, options });
        return {};
      },
      deleteMessage: async (chatId: any, messageId: any) => {
        messages.push({ type: "delete", chatId, messageId });
        return true;
      },
    },
    _mockMessages: messages,
    ...overrides,
  } as any;
}

// Global beforeEach for all handler tests
beforeEach(() => {
  // Clear session manager state before each test
  sessionManager["sessions"].clear();
  sessionManager["creationLocks"].clear();
  sessionManager["lastUsedPerChat"].clear();
  sessionManager.setCurrentProject("default");

  // Mock ClaudeSession.sendMessageStreaming globally
  ClaudeSession.prototype.sendMessageStreaming = async function (
    message: string
  ) {
    // Set session ID on first call
    if (!this.sessionId) {
      this.sessionId = `mock-session-${Date.now()}-${Math.random()}`;
    }
    return `Mock response to: ${message}`;
  };
});

describe("Text Handler", () => {

  test("routes message to correct project based on last-used", async () => {
    const chatId = 67890;

    // Set last-used to a specific project
    sessionManager.setLastUsed(chatId, "test-project");

    const { handleText } = await import("../src/handlers/text");
    const ctx = createMockContext({
      message: { text: "Hello" } as any,
    });

    await handleText(ctx);

    // Verify session was created for correct project
    const session = sessionManager.getSession("test-project");
    expect(session).not.toBe(null);
    expect(session?.isActive()).toBe(true);
  });

  test("creates default project session when no last-used", async () => {
    const { handleText } = await import("../src/handlers/text");
    const ctx = createMockContext({
      message: { text: "Hello" } as any,
    });

    await handleText(ctx);

    // Should create session for current working directory (default)
    const sessions = sessionManager.getAllSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.isActive()).toBe(true);
  });

  test("shows project header based on SHOW_PROJECT_HEADERS config", async () => {
    // Set config to always show headers
    const originalConfig = process.env.SHOW_PROJECT_HEADERS;
    process.env.SHOW_PROJECT_HEADERS = "always";

    sessionManager.setLastUsed(67890, "my-project");

    const { handleText } = await import("../src/handlers/text");
    const ctx = createMockContext({
      message: { text: "test" } as any,
    });

    await handleText(ctx);

    const messages = (ctx as any)._mockMessages;

    // Should have sent project header
    const headerMsg = messages.find((m: any) =>
      m.text?.includes("[my-project]")
    );
    expect(headerMsg).toBeDefined();

    // Restore config
    if (originalConfig) {
      process.env.SHOW_PROJECT_HEADERS = originalConfig;
    } else {
      delete process.env.SHOW_PROJECT_HEADERS;
    }
  });

  test("updates last-used project after message", async () => {
    const chatId = 67890;

    sessionManager.setLastUsed(chatId, "project-a");

    const { handleText } = await import("../src/handlers/text");
    const ctx = createMockContext({
      message: { text: "test" } as any,
    });

    await handleText(ctx);

    // Last-used should still be project-a
    expect(sessionManager.getLastUsed(chatId)).toBe("project-a");
  });
});

describe("Status Command", () => {

  test("shows no active sessions when empty", async () => {
    const { handleStatus } = await import("../src/handlers/commands");
    const ctx = createMockContext();

    await handleStatus(ctx);

    const messages = (ctx as any)._mockMessages;
    expect(messages.length).toBeGreaterThan(0);

    const statusMsg = messages[0]?.text;
    expect(statusMsg).toContain("No active sessions");
  });

  test("shows current project status", async () => {
    // Create a session for current project
    const session = await sessionManager.getOrCreateSession("current-project");
    session.session.sessionId = "test-session-id";
    sessionManager.setCurrentProject("current-project");

    const { handleStatus } = await import("../src/handlers/commands");
    const ctx = createMockContext();

    await handleStatus(ctx);

    const messages = (ctx as any)._mockMessages;
    const statusMsg = messages[0]?.text;

    expect(statusMsg).toContain("CURRENT: current-project");
    expect(statusMsg).toContain("test-sess"); // Truncated session ID
  });

  test("shows other projects section", async () => {
    // Create sessions for multiple projects
    await sessionManager.getOrCreateSession("project1");
    await sessionManager.getOrCreateSession("project2");
    const session3 = await sessionManager.getOrCreateSession("project3");
    session3.session.sessionId = "session3-id";

    sessionManager.setCurrentProject("project1");

    const { handleStatus } = await import("../src/handlers/commands");
    const ctx = createMockContext();

    await handleStatus(ctx);

    const messages = (ctx as any)._mockMessages;
    const statusMsg = messages[0]?.text;

    expect(statusMsg).toContain("OTHER PROJECTS");
    expect(statusMsg).toContain("project2");
    expect(statusMsg).toContain("project3");
  });

  test("shows idle time for projects", async () => {
    const session = await sessionManager.getOrCreateSession("idle-project");

    // Wait a bit to create idle time
    await new Promise((resolve) => setTimeout(resolve, 100));

    sessionManager.setCurrentProject("idle-project");

    const { handleStatus } = await import("../src/handlers/commands");
    const ctx = createMockContext();

    await handleStatus(ctx);

    const messages = (ctx as any)._mockMessages;
    const statusMsg = messages[0]?.text;

    // Should show some idle time (in seconds)
    expect(statusMsg).toContain("Last:");
  });
});

describe("Resume Command", () => {
  test("shows no sessions message when empty", async () => {
    // Mock getSessionList to return empty
    ClaudeSession.prototype.getSessionList = () => [];

    const { handleResume } = await import("../src/handlers/commands");
    const ctx = createMockContext();

    await handleResume(ctx);

    const messages = (ctx as any)._mockMessages;
    expect(messages[0]?.text).toContain("No saved sessions");
  });

  test("groups sessions by project", async () => {
    // Mock getSessionList to return sessions from different projects
    ClaudeSession.prototype.getSessionList = () => [
      {
        session_id: "session1",
        saved_at: new Date().toISOString(),
        working_dir: "/home/ubuntu/Projects/project-a",
        title: "Session for project A",
        project: "project-a",
      },
      {
        session_id: "session2",
        saved_at: new Date().toISOString(),
        working_dir: "/home/ubuntu/Projects/project-b",
        title: "Session for project B",
        project: "project-b",
      },
      {
        session_id: "session3",
        saved_at: new Date().toISOString(),
        working_dir: "/home/ubuntu/Projects/project-a",
        title: "Another session for project A",
        project: "project-a",
      },
    ];

    sessionManager.setCurrentProject("project-a");

    const { handleResume } = await import("../src/handlers/commands");
    const ctx = createMockContext();

    await handleResume(ctx);

    const messages = (ctx as any)._mockMessages;
    const resumeMsg = messages[0];

    expect(resumeMsg?.text).toContain("project-a");
    expect(resumeMsg?.text).toContain("project-b");

    // Should have inline keyboard with buttons
    expect(resumeMsg?.options?.reply_markup?.inline_keyboard).toBeDefined();
    const buttons = resumeMsg?.options?.reply_markup?.inline_keyboard;

    // Should have 3 buttons (one per session)
    expect(buttons.length).toBe(3);

    // Buttons should have correct callback data format
    const callbackData = buttons.map((row: any) => row[0]?.callback_data);
    expect(callbackData[0]).toContain("resume:session1:project-a");
    expect(callbackData[1]).toContain("resume:session2:project-b");
    expect(callbackData[2]).toContain("resume:session3:project-a");
  });

  test("shows current project first", async () => {
    ClaudeSession.prototype.getSessionList = () => [
      {
        session_id: "b-session",
        saved_at: new Date().toISOString(),
        working_dir: "/proj-b",
        title: "Project B",
        project: "proj-b",
      },
      {
        session_id: "a-session",
        saved_at: new Date().toISOString(),
        working_dir: "/proj-a",
        title: "Project A",
        project: "proj-a",
      },
    ];

    sessionManager.setCurrentProject("proj-a");

    const { handleResume } = await import("../src/handlers/commands");
    const ctx = createMockContext();

    await handleResume(ctx);

    const messages = (ctx as any)._mockMessages;
    const text = messages[0]?.text;

    // Current project should be marked
    expect(text).toMatch(/proj-a.*\(current\)/);
  });
});

describe("Project Command", () => {

  test("switches to new project and updates tracking", async () => {
    const { handleProject } = await import("../src/handlers/commands");
    const ctx = createMockContext({
      message: {
        text: "/project telegram-bot",
      } as any,
    });

    await handleProject(ctx);

    // Should update current project
    expect(sessionManager.getCurrentProject()).toBe("telegram-bot");

    // Should update last-used for this chat
    expect(sessionManager.getLastUsed(67890)).toBe("telegram-bot");

    const messages = (ctx as any)._mockMessages;
    expect(messages[0]?.text).toContain("Switched to");
  });

  test("switches and sends prompt immediately", async () => {
    ClaudeSession.prototype.sendMessageStreaming = async function (
      message: string
    ) {
      if (!this.sessionId) {
        this.sessionId = "new-session";
      }
      return `Response to: ${message}`;
    };

    const { handleProject } = await import("../src/handlers/commands");
    const ctx = createMockContext({
      message: {
        text: "/project telegram-bot What is the status?",
      } as any,
    });

    await handleProject(ctx);

    const messages = (ctx as any)._mockMessages;

    // Should have switched message
    expect(messages.some((m: any) => m.text?.includes("Switched to"))).toBe(
      true
    );

    // Should have sent prompt
    expect(messages.some((m: any) => m.text?.includes("Sending prompt"))).toBe(
      true
    );
  });
});

describe("Callback Handlers", () => {
  test("resume callback switches project and resumes session", async () => {
    ClaudeSession.prototype.resumeSession = (sessionId: string) => {
      return [true, "Session resumed successfully"];
    };

    const { handleCallback } = await import("../src/handlers/callback");
    const ctx = createMockContext({
      callbackQuery: {
        id: "callback1",
        from: { id: 12345 } as any,
        chat_instance: "instance",
        data: "resume:test-session-id:target-project",
      } as any,
    });

    await handleCallback(ctx);

    // Should update current project
    expect(sessionManager.getCurrentProject()).toBe("target-project");

    // Should update last-used
    expect(sessionManager.getLastUsed(67890)).toBe("target-project");
  });
});

describe("Message Pipeline Integration", () => {

  test("complete user workflow across multiple projects", async () => {
    const { handleText } = await import("../src/handlers/text");
    const { handleProject } = await import("../src/handlers/commands");
    const chatId = 67890;

    // Step 1: Send message to default project
    let ctx = createMockContext({
      chat: { id: chatId } as any,
      message: { text: "Hello" } as any,
    });

    await handleText(ctx);

    let sessions = sessionManager.getAllSessions();
    expect(sessions.length).toBe(1);
    const defaultSession = sessions[0];
    expect(defaultSession?.isActive()).toBe(true);

    // Step 2: Switch to project1
    ctx = createMockContext({
      chat: { id: chatId } as any,
      message: { text: "/project telegram-bot" } as any,
    });

    await handleProject(ctx);

    expect(sessionManager.getCurrentProject()).toBe("telegram-bot");
    expect(sessionManager.getLastUsed(chatId)).toBe("telegram-bot");

    // Step 3: Send message to project1
    ctx = createMockContext({
      chat: { id: chatId } as any,
      message: { text: "Test message" } as any,
    });

    await handleText(ctx);

    sessions = sessionManager.getAllSessions();
    expect(sessions.length).toBe(2); // default + telegram-bot

    // Step 4: Switch to project2
    ctx = createMockContext({
      chat: { id: chatId } as any,
      message: { text: "/project aegir" } as any,
    });

    await handleProject(ctx);

    expect(sessionManager.getCurrentProject()).toBe("aegir");

    // Step 5: Send message to project2
    ctx = createMockContext({
      chat: { id: chatId } as any,
      message: { text: "Another test" } as any,
    });

    await handleText(ctx);

    sessions = sessionManager.getAllSessions();
    expect(sessions.length).toBe(3); // default + telegram-bot + aegir

    // All sessions should be independent and active
    for (const sess of sessions) {
      expect(sess.isActive()).toBe(true);
      expect(sess.session.sessionId).toBeTruthy();
    }
  });

  test("rapid project switching", async () => {
    const { handleProject } = await import("../src/handlers/commands");
    const { handleText } = await import("../src/handlers/text");

    const projects = ["project-a", "project-b", "project-a", "project-c"];

    for (const proj of projects) {
      // Switch project
      let ctx = createMockContext({
        message: { text: `/project ${proj}` } as any,
      });
      await handleProject(ctx);

      // Send message
      ctx = createMockContext({
        message: { text: `Message to ${proj}` } as any,
      });
      await handleText(ctx);
    }

    // Should have 3 unique sessions (a, b, c)
    const sessions = sessionManager.getAllSessions();
    expect(sessions.length).toBe(3);

    const names = sessions.map((s) => s.projectName).sort();
    expect(names).toEqual(["project-a", "project-b", "project-c"]);
  });
});

describe("Concurrent Message Handling", () => {

  test("concurrent messages to different projects execute simultaneously", async () => {
    const { handleText } = await import("../src/handlers/text");

    // Set up last-used for different projects
    sessionManager.setLastUsed(1111, "project1");
    sessionManager.setLastUsed(2222, "project2");

    const ctx1 = createMockContext({
      chat: { id: 1111 } as any,
      message: { text: "msg1" } as any,
    });

    const ctx2 = createMockContext({
      chat: { id: 2222 } as any,
      message: { text: "msg2" } as any,
    });

    const start = Date.now();

    // Execute both simultaneously
    await Promise.all([handleText(ctx1), handleText(ctx2)]);

    const duration = Date.now() - start;

    // If sequential, would take ~100ms. Concurrent should be ~50-70ms
    expect(duration).toBeLessThan(90);

    // Both sessions should exist
    const sessions = sessionManager.getAllSessions();
    expect(sessions.length).toBe(2);
  });
});
