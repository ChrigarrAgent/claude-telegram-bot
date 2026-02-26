# End-to-End Testing Plan for Claude Telegram Bot

## Overview

This plan outlines how to create comprehensive automated tests for the Telegram bot without requiring actual Telegram API calls. The tests will verify session continuity, project switching, resume functionality, and multi-chat scenarios.

## Testing Architecture

### Core Approach: grammy's `bot.handleUpdate()` + API Transformers

grammy provides two key testing mechanisms:

1. **`bot.handleUpdate(update)`** - Programmatically inject messages/updates as if they came from Telegram
2. **API Transformers** - Intercept outgoing API calls (like `sendMessage`) to record/mock responses

```typescript
// Inject a fake incoming message
await bot.handleUpdate({
  update_id: 1,
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 12345, type: "private" },
    from: { id: 12345, is_bot: false, first_name: "TestUser" },
    text: "Hello bot!"
  }
});

// Intercept outgoing API calls
bot.api.config.use((prev, method, payload, signal) => {
  recordedCalls.push({ method, payload });
  return { ok: true, result: true }; // Mock response
});
```

---

## Test Infrastructure

### 1. Test Helper: `TestBot` Class

```typescript
// tests/helpers/test-bot.ts

import { Bot, Context } from "grammy";
import type { Update, Message } from "grammy/types";

interface RecordedCall {
  method: string;
  payload: unknown;
  timestamp: number;
}

interface TestUser {
  id: number;
  username?: string;
  firstName: string;
}

export class TestBot {
  private bot: Bot;
  private updateId = 0;
  private messageId = 0;
  private recordedCalls: RecordedCall[] = [];

  constructor(bot: Bot) {
    this.bot = bot;
    this.installTransformer();
  }

  private installTransformer() {
    this.bot.api.config.use((prev, method, payload, signal) => {
      this.recordedCalls.push({
        method,
        payload,
        timestamp: Date.now()
      });

      // Return mock responses based on method
      return this.mockResponse(method, payload);
    });
  }

  private mockResponse(method: string, payload: unknown): any {
    switch (method) {
      case "sendMessage":
        return {
          ok: true,
          result: {
            message_id: ++this.messageId,
            date: Math.floor(Date.now() / 1000),
            chat: (payload as any).chat_id,
            text: (payload as any).text
          }
        };
      case "editMessageText":
        return { ok: true, result: true };
      case "deleteMessage":
        return { ok: true, result: true };
      case "sendChatAction":
        return { ok: true, result: true };
      default:
        return { ok: true, result: true };
    }
  }

  // Send a text message from a user
  async sendMessage(chatId: number, user: TestUser, text: string): Promise<void> {
    const update: Update = {
      update_id: ++this.updateId,
      message: {
        message_id: ++this.messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: "private" },
        from: {
          id: user.id,
          is_bot: false,
          first_name: user.firstName,
          username: user.username
        },
        text
      } as Message.TextMessage
    };

    await this.bot.handleUpdate(update);
  }

  // Send a command (e.g., /start, /project)
  async sendCommand(chatId: number, user: TestUser, command: string, args?: string): Promise<void> {
    const text = args ? `/${command} ${args}` : `/${command}`;
    await this.sendMessage(chatId, user, text);
  }

  // Send a callback query (button click)
  async clickButton(chatId: number, user: TestUser, callbackData: string): Promise<void> {
    const update: Update = {
      update_id: ++this.updateId,
      callback_query: {
        id: String(this.updateId),
        from: {
          id: user.id,
          is_bot: false,
          first_name: user.firstName,
          username: user.username
        },
        chat_instance: String(chatId),
        data: callbackData,
        message: {
          message_id: this.messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: "private" },
          text: "Button message"
        } as Message.TextMessage
      }
    };

    await this.bot.handleUpdate(update);
  }

  // Get recorded API calls
  getCalls(): RecordedCall[] {
    return [...this.recordedCalls];
  }

  // Get calls by method
  getCallsByMethod(method: string): RecordedCall[] {
    return this.recordedCalls.filter(c => c.method === method);
  }

  // Get the last sendMessage call
  getLastReply(): RecordedCall | undefined {
    return this.recordedCalls.filter(c => c.method === "sendMessage").pop();
  }

  // Get all replies as text
  getReplies(): string[] {
    return this.getCallsByMethod("sendMessage")
      .map(c => (c.payload as any).text)
      .filter(Boolean);
  }

  // Clear recorded calls
  clearCalls(): void {
    this.recordedCalls = [];
  }

  // Reset state
  reset(): void {
    this.recordedCalls = [];
    this.updateId = 0;
    this.messageId = 0;
  }
}
```

### 2. Test Helper: Mock Claude Session

```typescript
// tests/helpers/mock-claude-session.ts

import { ClaudeSession } from "../../src/session";

export function createMockClaudeSession(): ClaudeSession {
  const session = new ClaudeSession();

  // Mock sendMessageStreaming to return predictable responses
  session.sendMessageStreaming = async (
    message: string,
    username: string,
    userId: number,
    statusCallback: any,
    chatId?: number,
    ctx?: any
  ): Promise<string> => {
    // Simulate session ID being set on first message
    if (!session.sessionId) {
      session.sessionId = `mock-session-${Date.now()}`;
    }

    // Call status callback to simulate streaming
    await statusCallback("text", `Mock response to: ${message}`, 0);
    await statusCallback("done", "");

    session.lastMessage = message;
    session.lastActivity = new Date();

    return `Mock response to: ${message}`;
  };

  return session;
}
```

### 3. Bot Factory for Tests

```typescript
// tests/helpers/create-test-bot.ts

import { Bot } from "grammy";
import { sessionManager } from "../../src/session-manager";

export async function createTestBot(): Promise<Bot> {
  // Create bot with empty token (we won't make real API calls)
  const bot = new Bot("test-token");

  // Register all handlers (import from actual source)
  const { registerHandlers } = await import("../../src/handlers");
  registerHandlers(bot);

  return bot;
}

export function resetTestState(): void {
  // Clear session manager state
  sessionManager["sessions"].clear();
  sessionManager["creationLocks"].clear();
  sessionManager["lastUsedPerChat"].clear();
  sessionManager.setCurrentProject("default");
}
```

---

## Test Scenarios

### Category 1: Session Continuity (Same Project)

```typescript
// tests/e2e/session-continuity.test.ts

describe("Session Continuity", () => {
  let testBot: TestBot;
  let bot: Bot;
  const user = { id: 12345, firstName: "Test", username: "testuser" };
  const chatId = 12345;

  beforeEach(async () => {
    resetTestState();
    bot = await createTestBot();
    testBot = new TestBot(bot);
  });

  describe("Same project, multiple messages", () => {
    test("second message continues same session", async () => {
      // First message - creates new session
      await testBot.sendMessage(chatId, user, "Hello, first message");

      const projectSession = sessionManager.getSession("default");
      const firstSessionId = projectSession?.session.sessionId;
      expect(firstSessionId).toBeTruthy();

      // Second message - should continue same session
      await testBot.sendMessage(chatId, user, "Second message");

      const secondSessionId = projectSession?.session.sessionId;
      expect(secondSessionId).toBe(firstSessionId);
    });

    test("session persists across 10 messages", async () => {
      // Send 10 messages
      for (let i = 1; i <= 10; i++) {
        await testBot.sendMessage(chatId, user, `Message ${i}`);
      }

      const projectSession = sessionManager.getSession("default");
      expect(projectSession?.session.sessionId).toBeTruthy();

      // All messages should have used the same session
      // (We'd verify this by checking the session wasn't recreated)
      expect(sessionManager.getAllSessions().length).toBe(1);
    });

    test("interrupted message doesn't break continuity", async () => {
      // First message
      await testBot.sendMessage(chatId, user, "First message");
      const sessionId = sessionManager.getSession("default")?.session.sessionId;

      // Interrupt with ! prefix
      await testBot.sendMessage(chatId, user, "!Interrupt");

      // Third message should still continue
      await testBot.sendMessage(chatId, user, "Third message");

      const finalSessionId = sessionManager.getSession("default")?.session.sessionId;
      expect(finalSessionId).toBe(sessionId);
    });
  });
});
```

### Category 2: Project Switching

```typescript
// tests/e2e/project-switching.test.ts

describe("Project Switching", () => {
  let testBot: TestBot;
  let bot: Bot;
  const user = { id: 12345, firstName: "Test", username: "testuser" };
  const chatId = 12345;

  beforeEach(async () => {
    resetTestState();
    bot = await createTestBot();
    testBot = new TestBot(bot);
  });

  describe("Switch to new project", () => {
    test("/project command creates new project session", async () => {
      // Start in default project
      await testBot.sendMessage(chatId, user, "Hello in default");
      expect(sessionManager.getLastUsed(chatId)).toBe("default");

      // Switch to project-a
      await testBot.sendCommand(chatId, user, "project", "project-a");

      // Verify switch happened
      expect(sessionManager.getLastUsed(chatId)).toBe("project-a");
      expect(sessionManager.getCurrentProject()).toBe("project-a");
    });

    test("message after switch goes to new project", async () => {
      // Start conversation in default
      await testBot.sendMessage(chatId, user, "Hello default");

      // Switch to project-a
      await testBot.sendCommand(chatId, user, "project", "project-a");

      // Send message - should go to project-a
      await testBot.sendMessage(chatId, user, "Hello project-a");

      // Verify message was routed to project-a
      const projectA = sessionManager.getSession("project-a");
      expect(projectA?.session.lastMessage).toBe("Hello project-a");
    });
  });

  describe("Switch back to previous project", () => {
    test("returning to project resumes its session", async () => {
      // Send message to project-a
      await testBot.sendCommand(chatId, user, "project", "project-a");
      await testBot.sendMessage(chatId, user, "First message in A");
      const sessionIdA = sessionManager.getSession("project-a")?.session.sessionId;

      // Switch to project-b
      await testBot.sendCommand(chatId, user, "project", "project-b");
      await testBot.sendMessage(chatId, user, "Message in B");

      // Switch back to project-a
      await testBot.sendCommand(chatId, user, "project", "project-a");
      await testBot.sendMessage(chatId, user, "Back in A");

      // Session should be the same
      const resumedSessionId = sessionManager.getSession("project-a")?.session.sessionId;
      expect(resumedSessionId).toBe(sessionIdA);
    });

    test("both projects maintain separate contexts", async () => {
      // Work in project-a
      await testBot.sendCommand(chatId, user, "project", "project-a");
      await testBot.sendMessage(chatId, user, "A context message");

      // Work in project-b
      await testBot.sendCommand(chatId, user, "project", "project-b");
      await testBot.sendMessage(chatId, user, "B context message");

      // Both should have separate sessions
      const sessionA = sessionManager.getSession("project-a");
      const sessionB = sessionManager.getSession("project-b");

      expect(sessionA?.session.sessionId).not.toBe(sessionB?.session.sessionId);
      expect(sessionA?.session.lastMessage).toBe("A context message");
      expect(sessionB?.session.lastMessage).toBe("B context message");
    });
  });

  describe("@project syntax routing", () => {
    test("@project-a routes directly to project", async () => {
      // Use @-syntax to route
      await testBot.sendMessage(chatId, user, "@project-a Do something");

      // Should be routed to project-a
      expect(sessionManager.getLastUsed(chatId)).toBe("project-a");
    });

    test("@project preserves session across messages", async () => {
      await testBot.sendMessage(chatId, user, "@myproject First");
      const sessionId = sessionManager.getSession("myproject")?.session.sessionId;

      await testBot.sendMessage(chatId, user, "@myproject Second");
      const sessionId2 = sessionManager.getSession("myproject")?.session.sessionId;

      expect(sessionId2).toBe(sessionId);
    });
  });
});
```

### Category 3: Session Resume After Restart

```typescript
// tests/e2e/session-resume.test.ts

describe("Session Resume", () => {
  let testBot: TestBot;
  let bot: Bot;
  const user = { id: 12345, firstName: "Test", username: "testuser" };
  const chatId = 12345;

  describe("Resume via /resume command", () => {
    test("resume restores session ID", async () => {
      // Create a session with known ID
      const projectSession = await sessionManager.getOrCreateSession("test-project");
      projectSession.session.sessionId = "known-session-id-12345";
      projectSession.session.saveSession();

      // Clear in-memory state (simulate restart)
      resetTestState();

      // Create fresh bot
      bot = await createTestBot();
      testBot = new TestBot(bot);

      // Resume via callback
      await testBot.clickButton(chatId, user, "resume:known-session-id-12345:test-project");

      // Verify session was restored
      const restored = sessionManager.getSession("test-project");
      expect(restored?.session.sessionId).toBe("known-session-id-12345");
    });

    test("message after resume continues session", async () => {
      // Setup: create and save session
      const projectSession = await sessionManager.getOrCreateSession("resumable");
      projectSession.session.sessionId = "resume-me-123";
      projectSession.session.saveSession();
      sessionManager.setLastUsed(chatId, "resumable");

      // Simulate restart
      resetTestState();
      bot = await createTestBot();
      testBot = new TestBot(bot);

      // Resume
      await testBot.clickButton(chatId, user, "resume:resume-me-123:resumable");

      // Send follow-up message
      await testBot.sendMessage(chatId, user, "Continue conversation");

      // Session should still be the same
      const session = sessionManager.getSession("resumable");
      expect(session?.session.sessionId).toBe("resume-me-123");
    });
  });

  describe("Auto-resume after crash", () => {
    test("crash recovery restores active sessions", async () => {
      // Simulate heartbeat file left from crash
      const heartbeatData = {
        pid: 12345,
        started_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
        sessions: [{
          chat_id: chatId,
          project_name: "crashed-project",
          session_id: "crashed-session-id",
          was_running: true
        }]
      };

      await Bun.write("/tmp/claude-telegram-heartbeat.json", JSON.stringify(heartbeatData));

      // Bot startup should detect and restore
      // (This requires importing startup logic)

      // Verify restoration
      const restored = sessionManager.getSession("crashed-project");
      expect(restored?.session.sessionId).toBe("crashed-session-id");
    });
  });
});
```

### Category 4: Multi-Chat Scenarios

```typescript
// tests/e2e/multi-chat.test.ts

describe("Multi-Chat Scenarios", () => {
  let testBot: TestBot;
  let bot: Bot;

  const user1 = { id: 11111, firstName: "User1", username: "user1" };
  const user2 = { id: 22222, firstName: "User2", username: "user2" };
  const chat1 = 11111;
  const chat2 = 22222;

  beforeEach(async () => {
    resetTestState();
    bot = await createTestBot();
    testBot = new TestBot(bot);
  });

  describe("Different chats, different projects", () => {
    test("each chat maintains separate project context", async () => {
      // User1 works on project-x
      await testBot.sendCommand(chat1, user1, "project", "project-x");
      await testBot.sendMessage(chat1, user1, "Working on X");

      // User2 works on project-y
      await testBot.sendCommand(chat2, user2, "project", "project-y");
      await testBot.sendMessage(chat2, user2, "Working on Y");

      // Each chat should track different projects
      expect(sessionManager.getLastUsed(chat1)).toBe("project-x");
      expect(sessionManager.getLastUsed(chat2)).toBe("project-y");
    });

    test("messages in chat1 don't affect chat2", async () => {
      // Setup both chats
      await testBot.sendCommand(chat1, user1, "project", "shared-project");
      await testBot.sendCommand(chat2, user2, "project", "shared-project");

      // Send message from chat1
      await testBot.sendMessage(chat1, user1, "From chat 1");

      // Verify chat2 wasn't affected
      // (Both share the project but have separate tracking)
      expect(sessionManager.getLastUsed(chat1)).toBe("shared-project");
      expect(sessionManager.getLastUsed(chat2)).toBe("shared-project");
    });
  });

  describe("Same chat, different sessions", () => {
    test("/new clears session for current chat only", async () => {
      // Chat1 has active session
      await testBot.sendMessage(chat1, user1, "Chat 1 message");
      const session1Before = sessionManager.getSession("default")?.session.sessionId;

      // Chat1 runs /new
      await testBot.sendCommand(chat1, user1, "new");

      // Session should be cleared
      const session1After = sessionManager.getSession("default")?.session.sessionId;
      expect(session1After).toBeNull();
    });
  });
});
```

### Category 5: Command Behavior

```typescript
// tests/e2e/commands.test.ts

describe("Command Behavior", () => {
  let testBot: TestBot;
  let bot: Bot;
  const user = { id: 12345, firstName: "Test", username: "testuser" };
  const chatId = 12345;

  beforeEach(async () => {
    resetTestState();
    bot = await createTestBot();
    testBot = new TestBot(bot);
  });

  describe("/new command", () => {
    test("clears session for current project", async () => {
      await testBot.sendMessage(chatId, user, "Create session");
      expect(sessionManager.getSession("default")?.session.sessionId).toBeTruthy();

      await testBot.sendCommand(chatId, user, "new");

      expect(sessionManager.getSession("default")?.session.sessionId).toBeNull();
    });

    test("doesn't affect other projects", async () => {
      // Create sessions in two projects
      await testBot.sendCommand(chatId, user, "project", "project-a");
      await testBot.sendMessage(chatId, user, "A message");

      await testBot.sendCommand(chatId, user, "project", "project-b");
      await testBot.sendMessage(chatId, user, "B message");

      // Clear project-b
      await testBot.sendCommand(chatId, user, "new");

      // project-a should still have session
      const sessionA = sessionManager.getSession("project-a");
      expect(sessionA?.session.sessionId).toBeTruthy();
    });
  });

  describe("/stop command", () => {
    test("stops running query in current project", async () => {
      // Start a query (mock would simulate running state)
      await testBot.sendMessage(chatId, user, "Long query");

      // Stop it
      await testBot.sendCommand(chatId, user, "stop");

      // Verify stop was processed (check recorded calls)
      // The session.stop() should have been called
    });
  });

  describe("/status command", () => {
    test("shows all active sessions", async () => {
      // Create multiple sessions
      await testBot.sendCommand(chatId, user, "project", "proj-a");
      await testBot.sendMessage(chatId, user, "A");

      await testBot.sendCommand(chatId, user, "project", "proj-b");
      await testBot.sendMessage(chatId, user, "B");

      // Get status
      testBot.clearCalls();
      await testBot.sendCommand(chatId, user, "status");

      // Check response contains both projects
      const reply = testBot.getLastReply();
      const text = (reply?.payload as any)?.text || "";
      expect(text).toContain("proj-a");
      expect(text).toContain("proj-b");
    });
  });

  describe("/retry command", () => {
    test("retries last message in current project", async () => {
      await testBot.sendMessage(chatId, user, "Original message");

      testBot.clearCalls();
      await testBot.sendCommand(chatId, user, "retry");

      // Should have sent "Original message" again
      // (Check via mock Claude session)
    });
  });
});
```

---

## Implementation Steps

### Phase 1: Test Infrastructure (Day 1)

1. **Create test helper files:**
   - `tests/helpers/test-bot.ts` - TestBot class
   - `tests/helpers/mock-claude-session.ts` - Mock session
   - `tests/helpers/create-test-bot.ts` - Bot factory

2. **Refactor source for testability:**
   - Export handler registration as a function
   - Ensure all handlers can work without real Telegram API
   - Add dependency injection points for ClaudeSession mocking

3. **Update package.json:**
   ```json
   {
     "scripts": {
       "test": "bun test",
       "test:e2e": "bun test tests/e2e",
       "test:watch": "bun test --watch"
     }
   }
   ```

### Phase 2: Core Tests (Day 2)

1. **Session continuity tests** - `tests/e2e/session-continuity.test.ts`
2. **Project switching tests** - `tests/e2e/project-switching.test.ts`

### Phase 3: Advanced Tests (Day 3)

1. **Session resume tests** - `tests/e2e/session-resume.test.ts`
2. **Multi-chat tests** - `tests/e2e/multi-chat.test.ts`
3. **Command tests** - `tests/e2e/commands.test.ts`

### Phase 4: Integration & CI (Day 4)

1. **Add GitHub Actions workflow** for automated testing
2. **Add test coverage reporting**
3. **Document testing patterns** in README

---

## Key Technical Considerations

### 1. Handler Export Pattern

Current handlers need refactoring to be testable:

```typescript
// src/handlers/index.ts (current)
export { handleText } from "./text";

// src/handlers/index.ts (testable)
export function registerHandlers(bot: Bot) {
  bot.command("start", handleStart);
  bot.command("new", handleNew);
  // ... etc
  bot.on("message:text", handleText);
}
```

### 2. Session Mocking

The ClaudeSession needs to be mockable:

```typescript
// In tests, replace the session factory
sessionManager["_createSession"] = async (projectName) => {
  const mockSession = createMockClaudeSession();
  return new ProjectSession(projectName, "/tmp", mockSession);
};
```

### 3. File System Isolation

Tests should use temp directories:

```typescript
// tests/setup.ts
process.env.SESSION_FILE = "/tmp/test-sessions.json";
process.env.HEARTBEAT_FILE = "/tmp/test-heartbeat.json";
```

### 4. Async Handling

Tests need proper async handling for grammy's middleware chain:

```typescript
test("handles message", async () => {
  await testBot.sendMessage(chatId, user, "Hello");
  // Allow middleware chain to complete
  await new Promise(resolve => setTimeout(resolve, 100));
  // Now check results
});
```

---

## Expected Test Coverage

| Category | Tests | Coverage |
|----------|-------|----------|
| Session Continuity | 5 | Same project, multiple messages |
| Project Switching | 8 | Switch, return, @-syntax |
| Session Resume | 4 | Manual resume, crash recovery |
| Multi-Chat | 4 | Separate contexts, isolation |
| Commands | 10 | /new, /stop, /status, etc. |
| **Total** | **31** | Core functionality |

---

## Running Tests

```bash
# Run all tests
bun test

# Run only e2e tests
bun test tests/e2e

# Run specific test file
bun test tests/e2e/session-continuity.test.ts

# Watch mode during development
bun test --watch

# With coverage
bun test --coverage
```
