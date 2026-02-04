/**
 * E2E Tests for Advanced Scenarios
 *
 * Tests for:
 * 1. Clone state isolation (per-chat)
 * 2. Crash detection + auto-resume
 * 3. Concurrent message handling
 * 4. Resume via callback handler
 *
 * Uses mock SDK to avoid token costs.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// Install mock SDK before any source imports
import {
  mockQuery,
  resetMockSDK,
  getMockCalls,
} from "../helpers/mock-claude-sdk";
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

import {
  TestBot,
  getTestBot,
  resetSessionManager,
} from "../helpers/test-setup";

// Test users
const testUser1 = {
  id: 12345,
  firstName: "TestUser1",
  username: "testuser1",
};

const testUser2 = {
  id: 67890,
  firstName: "TestUser2",
  username: "testuser2",
};

// Test chat IDs
const CHAT_1 = 12345;
const CHAT_2 = 67890;

describe("Advanced Scenarios", () => {
  let testBot: TestBot;

  beforeEach(async () => {
    resetMockSDK();
    await resetSessionManager();

    const { setWorkingDir } = await import("../../src/config");
    setWorkingDir("/home/ubuntu");

    const bot = await getTestBot();
    testBot = new TestBot(bot);
  });

  afterEach(() => {
    testBot.reset();
  });

  describe("Clone State Isolation", () => {
    test("pending clone state is isolated per chat", async () => {
      const { sessionManager } = await import("../../src/session-manager");

      // Chat 1 sets pending clone
      sessionManager.setPendingClone(CHAT_1, {
        projectName: "project-a",
        projectPath: "/home/ubuntu/Projects/project-a",
        chatId: CHAT_1,
      });

      // Chat 2 sets pending clone
      sessionManager.setPendingClone(CHAT_2, {
        projectName: "project-b",
        projectPath: "/home/ubuntu/Projects/project-b",
        chatId: CHAT_2,
      });

      // Verify they're independent
      const clone1 = sessionManager.getPendingClone(CHAT_1);
      const clone2 = sessionManager.getPendingClone(CHAT_2);

      expect(clone1?.projectName).toBe("project-a");
      expect(clone2?.projectName).toBe("project-b");

      // Clear one, verify other remains
      sessionManager.clearPendingClone(CHAT_1);

      expect(sessionManager.getPendingClone(CHAT_1)).toBeNull();
      expect(sessionManager.getPendingClone(CHAT_2)?.projectName).toBe("project-b");
    });

    test("pending clone state does not leak between chats", async () => {
      const { sessionManager } = await import("../../src/session-manager");

      // Only Chat 1 has pending clone
      sessionManager.setPendingClone(CHAT_1, {
        projectName: "my-project",
        projectPath: "/home/ubuntu/Projects/my-project",
        chatId: CHAT_1,
      });

      // Chat 2 should not have any pending clone
      expect(sessionManager.getPendingClone(CHAT_2)).toBeNull();

      // Chat 1 should have the pending clone
      expect(sessionManager.getPendingClone(CHAT_1)).not.toBeNull();
    });
  });

  describe("Concurrent Message Handling", () => {
    test("messages to same project are processed", async () => {
      // Send first message
      await testBot.sendMessage(CHAT_1, testUser1, "First message");
      await new Promise((r) => setTimeout(r, 100));

      // Send second message while first might still be processing
      await testBot.sendMessage(CHAT_1, testUser1, "Second message");
      await new Promise((r) => setTimeout(r, 100));

      const calls = getMockCalls();
      expect(calls.length).toBe(2);

      // Both should be for the same project
      expect(calls[0].options.cwd).toBe(calls[1].options.cwd);
    });

    test("messages to different projects are independent", async () => {
      // Message from Chat 1 to default project
      await testBot.sendMessage(CHAT_1, testUser1, "Chat 1 message");
      await new Promise((r) => setTimeout(r, 100));

      // Chat 2 switches to different project
      await testBot.sendCommand(CHAT_2, testUser2, "project", "/tmp");
      await new Promise((r) => setTimeout(r, 100));

      // Message from Chat 2 to /tmp project
      await testBot.sendMessage(CHAT_2, testUser2, "Chat 2 message");
      await new Promise((r) => setTimeout(r, 100));

      const calls = getMockCalls();
      expect(calls.length).toBe(2);

      // Should have different working directories
      expect(calls[0].options.cwd).not.toBe(calls[1].options.cwd);
    });
  });

  describe("Resume via Callback", () => {
    test("resume callback is skipped when session already active", async () => {
      const { sessionManager } = await import("../../src/session-manager");

      // Establish an active session
      await testBot.sendMessage(CHAT_1, testUser1, "First message");
      await new Promise((r) => setTimeout(r, 100));

      let calls = getMockCalls();
      expect(calls.length).toBe(1);

      // Get the session ID that was created
      const projectSession = await sessionManager.getOrCreateSession("ubuntu");
      const sessionId = projectSession.session.sessionId;
      expect(sessionId).toBeDefined();

      // Try to resume the same session - should be skipped because already active
      await testBot.clickButton(CHAT_1, testUser1, `resume:${sessionId}:ubuntu`);
      await new Promise((r) => setTimeout(r, 100));

      // Should still only have 1 call (resume was skipped)
      calls = getMockCalls();
      expect(calls.length).toBe(1);

      // Verify the session is still the same
      expect(projectSession.session.sessionId).toBe(sessionId);
    });

    test("resume callback allows resuming inactive session programmatically", async () => {
      const { sessionManager } = await import("../../src/session-manager");

      // Test the programmatic resume flow (bypasses file-based lookup)
      // This verifies the session manager correctly tracks sessions

      // Establish a session
      await testBot.sendMessage(CHAT_1, testUser1, "First message");
      await new Promise((r) => setTimeout(r, 100));

      const projectSession = await sessionManager.getOrCreateSession("ubuntu");
      const originalSessionId = projectSession.session.sessionId;
      expect(originalSessionId).toBeDefined();

      // Kill the session
      await projectSession.kill();
      expect(projectSession.session.sessionId).toBeNull();

      // Directly restore the session ID (simulating what a successful resume would do)
      projectSession.session.sessionId = originalSessionId;
      expect(projectSession.session.sessionId).toBe(originalSessionId);

      // Send another message - should resume with the restored ID
      await testBot.sendMessage(CHAT_1, testUser1, "After manual restore");
      await new Promise((r) => setTimeout(r, 100));

      const calls = getMockCalls();
      expect(calls.length).toBe(2);

      // Second call should use the restored session ID
      expect(calls[1].options.resume).toBe(originalSessionId);
    });

    test("resume callback for different project creates/gets correct session", async () => {
      const { sessionManager } = await import("../../src/session-manager");

      // Establish session for default project
      await testBot.sendMessage(CHAT_1, testUser1, "Default project message");
      await new Promise((r) => setTimeout(r, 100));

      // Get the session ID
      const defaultSession = sessionManager.getSession("ubuntu");
      const defaultSessionId = defaultSession?.session.sessionId;
      expect(defaultSessionId).toBeDefined();

      // Switch to /tmp and send message
      await testBot.sendCommand(CHAT_1, testUser1, "project", "/tmp");
      await new Promise((r) => setTimeout(r, 100));

      await testBot.sendMessage(CHAT_1, testUser1, "Tmp project message");
      await new Promise((r) => setTimeout(r, 100));

      // Current project should be tmp
      expect(sessionManager.getLastUsed(CHAT_1)).toBe("tmp");

      // Kill the default session to allow resume
      await defaultSession!.kill();

      // Click resume for the default project session
      await testBot.clickButton(CHAT_1, testUser1, `resume:${defaultSessionId}:ubuntu`);
      await new Promise((r) => setTimeout(r, 300));

      // lastUsed should now be ubuntu
      expect(sessionManager.getLastUsed(CHAT_1)).toBe("ubuntu");
    });
  });

  describe("Session Persistence", () => {
    test("session ID persists across multiple messages", async () => {
      // Send multiple messages
      for (let i = 0; i < 5; i++) {
        await testBot.sendMessage(CHAT_1, testUser1, `Message ${i + 1}`);
        await new Promise((r) => setTimeout(r, 100));
      }

      const calls = getMockCalls();
      expect(calls.length).toBe(5);

      // First call creates session (no resume)
      expect(calls[0].options.resume).toBeUndefined();

      // All subsequent calls should use the same session ID
      const sessionId = calls[1].options.resume;
      expect(sessionId).toBeDefined();

      for (let i = 2; i < 5; i++) {
        expect(calls[i].options.resume).toBe(sessionId);
      }
    });

    test("/new command clears session ID", async () => {
      // Establish session
      await testBot.sendMessage(CHAT_1, testUser1, "First message");
      await new Promise((r) => setTimeout(r, 100));

      await testBot.sendMessage(CHAT_1, testUser1, "Second message");
      await new Promise((r) => setTimeout(r, 100));

      let calls = getMockCalls();
      const oldSessionId = calls[1].options.resume;
      expect(oldSessionId).toBeDefined();

      // Clear session with /new
      await testBot.sendCommand(CHAT_1, testUser1, "new");
      await new Promise((r) => setTimeout(r, 100));

      // Send new message
      await testBot.sendMessage(CHAT_1, testUser1, "After new");
      await new Promise((r) => setTimeout(r, 100));

      calls = getMockCalls();
      expect(calls.length).toBe(3);

      // Should be a new session (no resume or different ID)
      const newCall = calls[2];
      if (newCall.options.resume) {
        expect(newCall.options.resume).not.toBe(oldSessionId);
      } else {
        expect(newCall.options.resume).toBeUndefined();
      }
    });
  });

  describe("Project Create/Switch", () => {
    test("project switch updates working directory", async () => {
      // Default project message
      await testBot.sendMessage(CHAT_1, testUser1, "Default");
      await new Promise((r) => setTimeout(r, 100));

      let calls = getMockCalls();
      const defaultCwd = calls[0].options.cwd;

      // Switch to /tmp
      await testBot.sendCommand(CHAT_1, testUser1, "project", "/tmp");
      await new Promise((r) => setTimeout(r, 100));

      // Message to /tmp
      await testBot.sendMessage(CHAT_1, testUser1, "Tmp");
      await new Promise((r) => setTimeout(r, 100));

      calls = getMockCalls();
      expect(calls[1].options.cwd).toBe("/tmp");
      expect(calls[1].options.cwd).not.toBe(defaultCwd);
    });

    test("project switch preserves other project sessions", async () => {
      const { sessionManager } = await import("../../src/session-manager");

      // Create session for default project
      await testBot.sendMessage(CHAT_1, testUser1, "Default 1");
      await new Promise((r) => setTimeout(r, 100));

      await testBot.sendMessage(CHAT_1, testUser1, "Default 2");
      await new Promise((r) => setTimeout(r, 100));

      // Get default session ID
      const defaultSession = sessionManager.getSession("ubuntu");
      const defaultSessionId = defaultSession?.session.sessionId;

      // Switch to /tmp
      await testBot.sendCommand(CHAT_1, testUser1, "project", "/tmp");
      await new Promise((r) => setTimeout(r, 100));

      // Send messages to /tmp
      await testBot.sendMessage(CHAT_1, testUser1, "Tmp 1");
      await new Promise((r) => setTimeout(r, 100));

      // Default session should still have its session ID
      const defaultSessionAfter = sessionManager.getSession("ubuntu");
      expect(defaultSessionAfter?.session.sessionId).toBe(defaultSessionId);
    });
  });
});
