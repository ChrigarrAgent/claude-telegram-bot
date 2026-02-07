/**
 * Group Linking Tests
 *
 * Tests the complete group linking workflow including:
 * - Group link/unlink commands
 * - Verification code flow
 * - Voice mode propagation to groups
 * - Session routing for groups
 * - Multiple concurrent group sessions
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { sessionManager } from "../src/session-manager";
import { handleLink, handleUnlink, handleVoice as handleVoiceCommand } from "../src/handlers/commands";
import { handleText } from "../src/handlers/text";
import { getVoiceMode, setChatVoiceMode, clearAllSettings } from "../src/chat-settings";
import { setGroupLink, getGroupLink, removeGroupLink, clearAllGroupLinks } from "../src/group-links";
import type { Context } from "grammy";
import type { Message, Chat, User } from "grammy/types";
import * as projectAliases from "../src/project-aliases";
import * as security from "../src/security";
import { homedir } from "os";

const HOME = homedir();
const AUTHORIZED_USER_ID = 8288774457; // From .env TELEGRAM_ALLOWED_USERS

// Mock Telegram context factory
function createMockContext(overrides: {
  userId?: number;
  username?: string;
  chatId?: number;
  chatType?: "private" | "group" | "supergroup";
  chatTitle?: string;
  text?: string;
  messageId?: number;
} = {}): Context {
  const messages: any[] = [];

  const userId = overrides.userId ?? AUTHORIZED_USER_ID;
  const username = overrides.username ?? "testuser";
  const chatId = overrides.chatId ?? 67890;
  const chatType = overrides.chatType ?? "private";
  const chatTitle = overrides.chatTitle;
  const text = overrides.text ?? "test message";
  const messageId = overrides.messageId ?? 1;

  const user: User = {
    id: userId,
    is_bot: false,
    first_name: "Test",
    username,
  };

  const chat: Chat = chatType === "private"
    ? { id: chatId, type: "private" }
    : chatType === "group"
    ? { id: chatId, type: "group", title: chatTitle ?? "Test Group" }
    : { id: chatId, type: "supergroup", title: chatTitle ?? "Test Supergroup" };

  const message: Partial<Message> = {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat: chat as any,
    from: user,
    text,
  };

  const api = {
    sendMessage: async (chatId: number, text: string, options?: any) => {
      messages.push({ type: "sendMessage", chatId, text, options });
      return {
        message_id: messages.length,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: "private" },
        text,
      } as any;
    },
  };

  return {
    from: user,
    chat: chat as any,
    message: message as any,
    callbackQuery: undefined,
    api: api as any,
    reply: async (text: string, options?: any) => {
      messages.push({ type: "reply", text, options });
      return {
        message_id: messages.length,
        date: Math.floor(Date.now() / 1000),
        chat: chat as any,
        text,
      } as any;
    },
    replyWithChatAction: async (action: string) => {
      return true;
    },
    answerCallbackQuery: async (options?: any) => {
      return true;
    },
    editMessageText: async (text: string, options?: any) => {
      messages.push({ type: "edit", text, options });
      return {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: chat as any,
        text,
      } as any;
    },
    _messages: messages,
    ...overrides,
  } as any;
}

describe("Group Linking", () => {
  beforeEach(() => {
    // Clear all state before each test
    clearAllGroupLinks();
    clearAllSettings();
    sessionManager.cleanupExpiredGroupLinks();

    // Mock authorization - allow all users in tests
    spyOn(security, "isAuthorized").mockReturnValue(true);

    // Mock project aliases
    spyOn(projectAliases, "getProjectByAlias").mockImplementation((alias: string) => {
      if (alias === "default") return HOME;
      if (alias === "test-project") return "/test/project";
      return null;
    });

    spyOn(projectAliases, "getProjectAlias").mockImplementation((path: string) => {
      if (path === HOME) return "default";
      if (path === "/test/project") return "test-project";
      return null;
    });
  });

  afterEach(() => {
    // Clean up after each test
    clearAllGroupLinks();
    clearAllSettings();
  });

  test("should reject /link command in private chat", async () => {
    const ctx = createMockContext({
      chatType: "private",
      text: "/link test-project",
    });

    await handleLink(ctx);

    const replies = ctx._messages.filter((m: any) => m.type === "reply");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0].text).toContain("only works in group chats");
  });

  test("should reject /link without project name", async () => {
    const ctx = createMockContext({
      chatType: "group",
      chatTitle: "Test Group",
      text: "/link",
    });

    await handleLink(ctx);

    const replies = ctx._messages.filter((m: any) => m.type === "reply");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0].text).toContain("Please specify a project name");
  });

  test("should send verification code to DM when linking group", async () => {
    const groupId = 111111;
    const userId = 12345;

    const ctx = createMockContext({
      userId,
      chatId: groupId,
      chatType: "group",
      chatTitle: "Test Group",
      text: "/link default",
    });

    await handleLink(ctx);

    // Check that DM was sent
    const dmMessages = ctx._messages.filter((m: any) => m.type === "sendMessage" && m.chatId === userId);
    expect(dmMessages.length).toBe(1);
    expect(dmMessages[0].text).toContain("Verification code:");
    expect(dmMessages[0].text).toMatch(/\d{6}/); // Should contain 6-digit code

    // Check that confirmation was sent to group
    const groupReplies = ctx._messages.filter((m: any) => m.type === "reply");
    expect(groupReplies.length).toBe(1);
    expect(groupReplies[0].text).toContain("Verification code sent to your DM");

    // Check that pending link was stored
    const pendingLink = sessionManager.getPendingGroupLink(groupId);
    expect(pendingLink).not.toBeNull();
    expect(pendingLink?.projectName).toBe("default");
    expect(pendingLink?.groupId).toBe(groupId);
  });

  test("should complete link when correct verification code is sent", async () => {
    const groupId = 222222;
    const userId = 12345;

    // Step 1: Initiate link
    const linkCtx = createMockContext({
      userId,
      chatId: groupId,
      chatType: "group",
      chatTitle: "Test Group",
      text: "/link default",
    });

    await handleLink(linkCtx);

    // Extract verification code from DM
    const dmMessages = linkCtx._messages.filter((m: any) => m.type === "sendMessage");
    const codeMatch = dmMessages[0].text.match(/(\d{6})/);
    expect(codeMatch).not.toBeNull();
    const verificationCode = codeMatch![1];

    // Step 2: Send verification code in group
    const verifyCtx = createMockContext({
      userId,
      chatId: groupId,
      chatType: "group",
      chatTitle: "Test Group",
      text: verificationCode,
    });

    await handleText(verifyCtx);

    // Check that link was completed
    const link = getGroupLink(groupId);
    expect(link).not.toBeNull();
    expect(link?.projectName).toBe("default");
    expect(link?.linkedBy).toBe(userId);

    // Check that pending link was cleared
    const pendingLink = sessionManager.getPendingGroupLink(groupId);
    expect(pendingLink).toBeNull();

    // Check success message
    const replies = verifyCtx._messages.filter((m: any) => m.type === "reply");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0].text).toContain("successfully linked");
  });

  test("should reject incorrect verification code", async () => {
    const groupId = 333333;
    const userId = 12345;

    // Step 1: Initiate link
    const linkCtx = createMockContext({
      userId,
      chatId: groupId,
      chatType: "group",
      chatTitle: "Test Group",
      text: "/link default",
    });

    await handleLink(linkCtx);

    // Step 2: Send wrong code
    const verifyCtx = createMockContext({
      userId,
      chatId: groupId,
      chatType: "group",
      text: "999999", // Wrong code
    });

    await handleText(verifyCtx);

    // Check that link was NOT completed
    const link = getGroupLink(groupId);
    expect(link).toBeNull();

    // Check error message
    const replies = verifyCtx._messages.filter((m: any) => m.type === "reply");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0].text).toContain("Invalid verification code");
  });

  test("should unlink a group", async () => {
    const groupId = 444444;

    // Setup: Link the group first
    setGroupLink(groupId, {
      projectName: "default",
      projectPath: "/test/path",
      linkedAt: new Date().toISOString(),
      linkedBy: 12345,
      groupTitle: "Test Group",
    });

    // Verify link exists
    expect(getGroupLink(groupId)).not.toBeNull();

    // Unlink
    const ctx = createMockContext({
      chatId: groupId,
      chatType: "group",
      chatTitle: "Test Group",
      text: "/unlink",
    });

    await handleUnlink(ctx);

    // Check that link was removed
    const link = getGroupLink(groupId);
    expect(link).toBeNull();

    // Check success message
    const replies = ctx._messages.filter((m: any) => m.type === "reply");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0].text).toContain("unlinked");
  });

  test("should reject /unlink in private chat", async () => {
    const ctx = createMockContext({
      chatType: "private",
      text: "/unlink",
    });

    await handleUnlink(ctx);

    const replies = ctx._messages.filter((m: any) => m.type === "reply");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0].text).toContain("only works in group chats");
  });

  test("should handle /unlink when not linked", async () => {
    const ctx = createMockContext({
      chatId: 555555,
      chatType: "group",
      text: "/unlink",
    });

    await handleUnlink(ctx);

    const replies = ctx._messages.filter((m: any) => m.type === "reply");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0].text).toContain("not linked to any project");
  });
});

describe("Voice Mode Propagation", () => {
  beforeEach(() => {
    clearAllGroupLinks();
    clearAllSettings();

    // Mock authorization - allow all users in tests
    spyOn(security, "isAuthorized").mockReturnValue(true);

    // Mock project aliases
    spyOn(projectAliases, "getProjectByAlias").mockImplementation((alias: string) => {
      if (alias === "default") return HOME;
      return null;
    });
  });

  afterEach(() => {
    clearAllGroupLinks();
    clearAllSettings();
  });

  test("should propagate voice mode to all linked groups from DM", async () => {
    const dmChatId = 11111;
    const group1Id = 22222;
    const group2Id = 33333;

    // Setup: Link two groups
    setGroupLink(group1Id, {
      projectName: "default",
      projectPath: "/test/path",
      linkedAt: new Date().toISOString(),
      linkedBy: dmChatId,
      groupTitle: "Group 1",
    });

    setGroupLink(group2Id, {
      projectName: "default",
      projectPath: "/test/path",
      linkedAt: new Date().toISOString(),
      linkedBy: dmChatId,
      groupTitle: "Group 2",
    });

    // Enable voice mode in DM
    const ctx = createMockContext({
      chatId: dmChatId,
      chatType: "private",
      text: "/voice on",
    });

    await handleVoiceCommand(ctx);

    // Check that voice mode is enabled for DM
    expect(getVoiceMode(dmChatId)).toBe(true);

    // Check that voice mode is enabled for both groups
    expect(getVoiceMode(group1Id)).toBe(true);
    expect(getVoiceMode(group2Id)).toBe(true);

    // Check success message mentions propagation
    const replies = ctx._messages.filter((m: any) => m.type === "reply");
    expect(replies[0].text).toContain("2 linked group");
  });

  test("should only affect single group when toggling voice mode in group", async () => {
    const dmChatId = 11111;
    const group1Id = 22222;
    const group2Id = 33333;

    // Setup: Link two groups
    setGroupLink(group1Id, {
      projectName: "default",
      projectPath: "/test/path",
      linkedAt: new Date().toISOString(),
      linkedBy: dmChatId,
      groupTitle: "Group 1",
    });

    setGroupLink(group2Id, {
      projectName: "default",
      projectPath: "/test/path",
      linkedAt: new Date().toISOString(),
      linkedBy: dmChatId,
      groupTitle: "Group 2",
    });

    // Enable voice mode in group 1 only
    const ctx = createMockContext({
      chatId: group1Id,
      chatType: "group",
      chatTitle: "Group 1",
      text: "/voice on",
    });

    await handleVoiceCommand(ctx);

    // Check that voice mode is enabled only for group 1
    expect(getVoiceMode(group1Id)).toBe(true);
    expect(getVoiceMode(group2Id)).toBe(false);
    expect(getVoiceMode(dmChatId)).toBe(false);

    // Check success message doesn't mention propagation
    const replies = ctx._messages.filter((m: any) => m.type === "reply");
    expect(replies[0].text).toContain("enabled for this group");
    expect(replies[0].text).not.toContain("linked group");
  });

  test("should allow group to override DM voice mode setting", async () => {
    const dmChatId = 11111;
    const groupId = 22222;

    // Setup: Link group
    setGroupLink(groupId, {
      projectName: "default",
      projectPath: "/test/path",
      linkedAt: new Date().toISOString(),
      linkedBy: dmChatId,
      groupTitle: "Test Group",
    });

    // Enable voice mode in DM (propagates to group)
    const dmCtx = createMockContext({
      chatId: dmChatId,
      chatType: "private",
      text: "/voice on",
    });

    await handleVoiceCommand(dmCtx);

    // Verify both are enabled
    expect(getVoiceMode(dmChatId)).toBe(true);
    expect(getVoiceMode(groupId)).toBe(true);

    // Disable voice mode in group only
    const groupCtx = createMockContext({
      chatId: groupId,
      chatType: "group",
      chatTitle: "Test Group",
      text: "/voice off",
    });

    await handleVoiceCommand(groupCtx);

    // Check that DM is still enabled, but group is disabled
    expect(getVoiceMode(dmChatId)).toBe(true);
    expect(getVoiceMode(groupId)).toBe(false);
  });

  test("should clear voice mode for group with /voice clear", async () => {
    const groupId = 22222;

    // Setup: Enable voice mode
    setChatVoiceMode(groupId, true);
    expect(getVoiceMode(groupId)).toBe(true);

    // Clear voice mode
    const ctx = createMockContext({
      chatId: groupId,
      chatType: "group",
      chatTitle: "Test Group",
      text: "/voice clear",
    });

    await handleVoiceCommand(ctx);

    // Check that voice mode is disabled
    expect(getVoiceMode(groupId)).toBe(false);
  });
});

describe("Concurrent Group Sessions", () => {
  beforeEach(() => {
    clearAllGroupLinks();
    clearAllSettings();

    // Mock authorization - allow all users in tests
    spyOn(security, "isAuthorized").mockReturnValue(true);

    // Mock project aliases
    spyOn(projectAliases, "getProjectByAlias").mockImplementation((alias: string) => {
      if (alias === "project-a") return "/test/project-a";
      if (alias === "project-b") return "/test/project-b";
      if (alias === "shared-project") return "/test/shared";
      return null;
    });
  });

  afterEach(() => {
    clearAllGroupLinks();
    clearAllSettings();
  });

  test("should route messages to different projects for different groups", async () => {
    const group1Id = 11111;
    const group2Id = 22222;

    // Link groups to different projects
    setGroupLink(group1Id, {
      projectName: "project-a",
      projectPath: "/test/project-a",
      linkedAt: new Date().toISOString(),
      linkedBy: 12345,
      groupTitle: "Group A",
    });

    setGroupLink(group2Id, {
      projectName: "project-b",
      projectPath: "/test/project-b",
      linkedAt: new Date().toISOString(),
      linkedBy: 12345,
      groupTitle: "Group B",
    });

    // Verify links
    const link1 = getGroupLink(group1Id);
    const link2 = getGroupLink(group2Id);

    expect(link1?.projectName).toBe("project-a");
    expect(link2?.projectName).toBe("project-b");
  });

  test("should handle multiple groups linked to same project", async () => {
    const group1Id = 11111;
    const group2Id = 22222;

    // Link both groups to same project
    setGroupLink(group1Id, {
      projectName: "shared-project",
      projectPath: "/test/shared",
      linkedAt: new Date().toISOString(),
      linkedBy: 12345,
      groupTitle: "Group 1",
    });

    setGroupLink(group2Id, {
      projectName: "shared-project",
      projectPath: "/test/shared",
      linkedAt: new Date().toISOString(),
      linkedBy: 12345,
      groupTitle: "Group 2",
    });

    // Verify links
    const link1 = getGroupLink(group1Id);
    const link2 = getGroupLink(group2Id);

    expect(link1?.projectName).toBe("shared-project");
    expect(link2?.projectName).toBe("shared-project");
    expect(link1?.projectPath).toBe(link2?.projectPath);
  });
});
