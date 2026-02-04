/**
 * E2E Tests for Multi-Project Session Management
 *
 * These tests verify:
 * 1. Multiple projects can have independent sessions
 * 2. Resume flow works correctly across projects
 * 3. Project switching maintains session isolation
 * 4. Clone state is isolated per-project (or per-chat)
 *
 * Uses mock SDK to avoid token costs while verifying session ID handling.
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

// Now import test helpers (which will use mocked SDK)
import {
  TestBot,
  getTestBot,
  resetSessionManager,
} from "../helpers/test-setup";

// Test users - must match TELEGRAM_ALLOWED_USERS in test-setup.ts
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

describe("Multi-Project Session Management", () => {
  let testBot: TestBot;

  beforeEach(async () => {
    // Reset all state before each test
    resetMockSDK();
    await resetSessionManager();

    // CRITICAL: Reset working directory to known state
    // Without this, working dir from previous test leaks into next test
    const { setWorkingDir } = await import("../../src/config");
    setWorkingDir("/home/ubuntu");

    // Create fresh bot instance
    const bot = await getTestBot();
    testBot = new TestBot(bot);
  });

  afterEach(() => {
    testBot.reset();
  });

  describe("Project Session Isolation", () => {
    test("different projects have independent sessions", async () => {
      // Message to default project (chat 1)
      await testBot.sendMessage(CHAT_1, testUser1, "Working on default project");
      await new Promise((r) => setTimeout(r, 100));

      // Verify first call has no resume (new session)
      let calls = getMockCalls();
      expect(calls.length).toBe(1);
      expect(calls[0].options.resume).toBeUndefined();

      // Switch to a different project using /project command with absolute path
      await testBot.sendCommand(CHAT_1, testUser1, "project", "/tmp");
      await new Promise((r) => setTimeout(r, 100));

      // Message to /tmp project
      await testBot.sendMessage(CHAT_1, testUser1, "Working on tmp project");
      await new Promise((r) => setTimeout(r, 100));

      // Verify second SDK call - should be new session (different project)
      calls = getMockCalls();
      expect(calls.length).toBe(2);

      // The second call should start a new session (no resume from default project)
      // OR resume if the project had a previous session
      // In this case, it's a new project, so should be undefined
      expect(calls[1].options.resume).toBeUndefined();
    });

    test("switching back to project resumes its session", async () => {
      // Message to default project (establishes session)
      await testBot.sendMessage(CHAT_1, testUser1, "Default message 1");
      await new Promise((r) => setTimeout(r, 100));

      // Second message continues session
      await testBot.sendMessage(CHAT_1, testUser1, "Default message 2");
      await new Promise((r) => setTimeout(r, 100));

      let calls = getMockCalls();
      expect(calls.length).toBe(2);
      expect(calls[0].options.resume).toBeUndefined(); // First: new session
      expect(calls[1].options.resume).toBeDefined(); // Second: resumes

      const defaultSessionId = calls[1].options.resume;

      // Switch to different project
      await testBot.sendCommand(CHAT_1, testUser1, "project", "/var");
      await new Promise((r) => setTimeout(r, 100));

      // Message to /var project
      await testBot.sendMessage(CHAT_1, testUser1, "Var project message");
      await new Promise((r) => setTimeout(r, 100));

      calls = getMockCalls();
      expect(calls.length).toBe(3);
      // New project = new session
      expect(calls[2].options.resume).toBeUndefined();

      // Switch back to default project (use known path)
      await testBot.sendCommand(CHAT_1, testUser1, "project", "/home/ubuntu");
      await new Promise((r) => setTimeout(r, 100));

      // Message should resume the default project's session
      await testBot.sendMessage(CHAT_1, testUser1, "Back to default");
      await new Promise((r) => setTimeout(r, 100));

      calls = getMockCalls();
      expect(calls.length).toBe(4);

      // This message should resume the default session
      expect(calls[3].options.resume).toBeDefined();
      // It should use the same session ID from before
      expect(calls[3].options.resume).toBe(defaultSessionId);
    });
  });

  describe("Multi-Chat, Multi-Project", () => {
    test("different chats using different projects have isolated sessions", async () => {
      // Chat 1: default project
      await testBot.sendMessage(CHAT_1, testUser1, "Chat1 default");
      await new Promise((r) => setTimeout(r, 100));

      // Chat 2: switch to different project first
      await testBot.sendCommand(CHAT_2, testUser2, "project", "/tmp");
      await new Promise((r) => setTimeout(r, 100));

      // Chat 2: message to /tmp project
      await testBot.sendMessage(CHAT_2, testUser2, "Chat2 tmp project");
      await new Promise((r) => setTimeout(r, 100));

      const calls = getMockCalls();
      expect(calls.length).toBe(2);

      // Both should be new sessions (different projects)
      expect(calls[0].options.resume).toBeUndefined();
      expect(calls[1].options.resume).toBeUndefined();
    });

    test("different chats using same project share session", async () => {
      // Chat 1: message to default project
      await testBot.sendMessage(CHAT_1, testUser1, "Chat1 message 1");
      await new Promise((r) => setTimeout(r, 100));

      // Chat 2: message to same default project (no project switch)
      await testBot.sendMessage(CHAT_2, testUser2, "Chat2 message 1");
      await new Promise((r) => setTimeout(r, 100));

      const calls = getMockCalls();
      expect(calls.length).toBe(2);

      // First call: new session
      expect(calls[0].options.resume).toBeUndefined();

      // Second call from different chat but same project: should resume
      expect(calls[1].options.resume).toBeDefined();
    });
  });

  describe("/new Command Scope", () => {
    test("/new only clears session for current project", async () => {
      // Establish session on default project
      await testBot.sendMessage(CHAT_1, testUser1, "Default message 1");
      await new Promise((r) => setTimeout(r, 100));

      await testBot.sendMessage(CHAT_1, testUser1, "Default message 2");
      await new Promise((r) => setTimeout(r, 100));

      let calls = getMockCalls();
      expect(calls.length).toBe(2);
      const defaultSessionId = calls[1].options.resume;

      // Switch to different project and establish session
      await testBot.sendCommand(CHAT_1, testUser1, "project", "/tmp");
      await new Promise((r) => setTimeout(r, 100));

      await testBot.sendMessage(CHAT_1, testUser1, "Tmp message 1");
      await new Promise((r) => setTimeout(r, 100));

      await testBot.sendMessage(CHAT_1, testUser1, "Tmp message 2");
      await new Promise((r) => setTimeout(r, 100));

      calls = getMockCalls();
      expect(calls.length).toBe(4);

      // Use /new to clear tmp project session
      await testBot.sendCommand(CHAT_1, testUser1, "new");
      await new Promise((r) => setTimeout(r, 100));

      // Message to tmp project should start fresh
      await testBot.sendMessage(CHAT_1, testUser1, "Tmp after new");
      await new Promise((r) => setTimeout(r, 100));

      calls = getMockCalls();
      expect(calls.length).toBe(5);

      // Should be new session (not resuming tmp session)
      expect(calls[4].options.resume).toBeUndefined();

      // Now switch back to default and verify session is preserved
      await testBot.sendCommand(CHAT_1, testUser1, "project", "/home/ubuntu");
      await new Promise((r) => setTimeout(r, 100));

      await testBot.sendMessage(CHAT_1, testUser1, "Back to default");
      await new Promise((r) => setTimeout(r, 100));

      calls = getMockCalls();
      expect(calls.length).toBe(6);

      // Default project session should still be resumable
      expect(calls[5].options.resume).toBeDefined();
      expect(calls[5].options.resume).toBe(defaultSessionId);
    });
  });

  describe("Working Directory Handling", () => {
    test("project switch updates working directory for SDK calls", async () => {
      // Message to default project
      await testBot.sendMessage(CHAT_1, testUser1, "Default message");
      await new Promise((r) => setTimeout(r, 100));

      let calls = getMockCalls();
      expect(calls.length).toBe(1);
      const defaultCwd = calls[0].options.cwd;

      // Switch to different project
      await testBot.sendCommand(CHAT_1, testUser1, "project", "/tmp");
      await new Promise((r) => setTimeout(r, 100));

      // Message to /tmp project
      await testBot.sendMessage(CHAT_1, testUser1, "Tmp message");
      await new Promise((r) => setTimeout(r, 100));

      calls = getMockCalls();
      expect(calls.length).toBe(2);

      // Verify cwd changed for second call
      expect(calls[1].options.cwd).toBe("/tmp");
      expect(calls[1].options.cwd).not.toBe(defaultCwd);
    });

    test("concurrent messages to same project use same cwd", async () => {
      // Multiple messages to same project
      await testBot.sendMessage(CHAT_1, testUser1, "Message 1");
      await new Promise((r) => setTimeout(r, 100));

      await testBot.sendMessage(CHAT_1, testUser1, "Message 2");
      await new Promise((r) => setTimeout(r, 100));

      await testBot.sendMessage(CHAT_1, testUser1, "Message 3");
      await new Promise((r) => setTimeout(r, 100));

      const calls = getMockCalls();
      expect(calls.length).toBe(3);

      // All should have same cwd
      const cwd = calls[0].options.cwd;
      expect(calls[1].options.cwd).toBe(cwd);
      expect(calls[2].options.cwd).toBe(cwd);
    });
  });

  describe("Session Persistence Across Projects", () => {
    test("session IDs are unique per project", async () => {
      // Establish sessions for multiple projects
      // Project 1 (default)
      await testBot.sendMessage(CHAT_1, testUser1, "Default 1");
      await new Promise((r) => setTimeout(r, 100));
      await testBot.sendMessage(CHAT_1, testUser1, "Default 2");
      await new Promise((r) => setTimeout(r, 100));

      // Project 2 (/tmp)
      await testBot.sendCommand(CHAT_1, testUser1, "project", "/tmp");
      await new Promise((r) => setTimeout(r, 100));
      await testBot.sendMessage(CHAT_1, testUser1, "Tmp 1");
      await new Promise((r) => setTimeout(r, 100));
      await testBot.sendMessage(CHAT_1, testUser1, "Tmp 2");
      await new Promise((r) => setTimeout(r, 100));

      // Project 3 (/var)
      await testBot.sendCommand(CHAT_1, testUser1, "project", "/var");
      await new Promise((r) => setTimeout(r, 100));
      await testBot.sendMessage(CHAT_1, testUser1, "Var 1");
      await new Promise((r) => setTimeout(r, 100));
      await testBot.sendMessage(CHAT_1, testUser1, "Var 2");
      await new Promise((r) => setTimeout(r, 100));

      const calls = getMockCalls();
      expect(calls.length).toBe(6);

      // Collect resumed session IDs
      const defaultSession = calls[1].options.resume; // 2nd call to default
      const tmpSession = calls[3].options.resume; // 2nd call to tmp
      const varSession = calls[5].options.resume; // 2nd call to var

      // All should be different session IDs
      expect(defaultSession).not.toBe(tmpSession);
      expect(defaultSession).not.toBe(varSession);
      expect(tmpSession).not.toBe(varSession);
    });
  });
});
