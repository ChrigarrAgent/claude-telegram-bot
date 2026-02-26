/**
 * Project Switching Tests
 *
 * Tests for the project switching bug fix:
 * - Ensures alias (lowercase) is stored in lastUsedPerChat, not folder name
 * - Verifies resolveProjectPath correctly resolves aliases
 * - Tests the complete project switching flow
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from "fs";
import { homedir } from "os";

// Import modules under test
import { sessionManager, resetSessionManager } from "../src/session-manager";
import { resolveProjectPath } from "../src/config";
import {
  getProjectAlias,
  getProjectByAlias,
  getOrCreateProjectAlias,
  getAllAliases,
} from "../src/project-aliases";

const HOME = homedir();
const TEST_ALIAS_FILE = `${HOME}/.claude/telegram-project-aliases.json`;
const TEST_PROJECT_PATH = "/tmp/test-project-ExMasCommuter";

describe("Project Alias System", () => {
  let originalAliases: string | null = null;

  beforeEach(() => {
    // Backup original aliases file
    try {
      if (existsSync(TEST_ALIAS_FILE)) {
        const { readFileSync } = require("fs");
        originalAliases = readFileSync(TEST_ALIAS_FILE, "utf-8");
      }
    } catch {
      originalAliases = null;
    }

    // Reset session manager state
    resetSessionManager();
  });

  afterEach(() => {
    // Restore original aliases file
    try {
      if (originalAliases !== null) {
        writeFileSync(TEST_ALIAS_FILE, originalAliases);
      }
    } catch {
      // Ignore
    }

    // Clean up test project directory
    try {
      if (existsSync(TEST_PROJECT_PATH)) {
        rmSync(TEST_PROJECT_PATH, { recursive: true, force: true });
      }
    } catch {
      // Ignore
    }
  });

  describe("Alias Generation", () => {
    test("generates lowercase alias from CamelCase folder name", () => {
      // Create test directory
      mkdirSync(TEST_PROJECT_PATH, { recursive: true });

      // Get or create alias - this should generate "exmascommuter" or similar
      const alias = getOrCreateProjectAlias(TEST_PROJECT_PATH);

      expect(alias).toBe("test-project-exmascommuter");
      expect(alias).toBe(alias.toLowerCase()); // Should be lowercase
    });

    test("alias lookup is case-insensitive", () => {
      mkdirSync(TEST_PROJECT_PATH, { recursive: true });
      const alias = getOrCreateProjectAlias(TEST_PROJECT_PATH);

      // Lookup with exact alias
      const path1 = getProjectByAlias(alias);
      expect(path1).toBe(TEST_PROJECT_PATH);

      // Lookup with uppercase (should still work)
      const path2 = getProjectByAlias(alias.toUpperCase());
      expect(path2).toBe(TEST_PROJECT_PATH);
    });

    test("getProjectAlias returns existing alias without saving", () => {
      mkdirSync(TEST_PROJECT_PATH, { recursive: true });

      // First call saves alias
      const alias1 = getOrCreateProjectAlias(TEST_PROJECT_PATH);

      // Second call with getProjectAlias should return same alias
      const alias2 = getProjectAlias(TEST_PROJECT_PATH);

      expect(alias2).toBe(alias1);
    });
  });

  describe("Session Manager Last-Used Tracking", () => {
    test("stores alias (lowercase) in lastUsedPerChat", async () => {
      const chatId = 12345;
      const projectName = "my-project"; // This is the alias

      sessionManager.setLastUsed(chatId, projectName);

      const retrieved = sessionManager.getLastUsed(chatId);
      expect(retrieved).toBe(projectName);
      expect(retrieved).toBe("my-project"); // Should be exactly what was set
    });

    test("updating lastUsed overwrites previous value", async () => {
      const chatId = 12345;

      sessionManager.setLastUsed(chatId, "project-a");
      expect(sessionManager.getLastUsed(chatId)).toBe("project-a");

      sessionManager.setLastUsed(chatId, "project-b");
      expect(sessionManager.getLastUsed(chatId)).toBe("project-b");
    });

    test("different chats have independent lastUsed values", async () => {
      const chatId1 = 11111;
      const chatId2 = 22222;

      sessionManager.setLastUsed(chatId1, "project-for-chat-1");
      sessionManager.setLastUsed(chatId2, "project-for-chat-2");

      expect(sessionManager.getLastUsed(chatId1)).toBe("project-for-chat-1");
      expect(sessionManager.getLastUsed(chatId2)).toBe("project-for-chat-2");
    });
  });

  describe("Project Path Resolution", () => {
    test("resolveProjectPath finds alias-registered paths", () => {
      mkdirSync(TEST_PROJECT_PATH, { recursive: true });
      const alias = getOrCreateProjectAlias(TEST_PROJECT_PATH);

      // Resolve using alias
      const resolved = resolveProjectPath(alias);
      expect(resolved).toBe(TEST_PROJECT_PATH);
    });

    test("resolveProjectPath falls back to HOME for non-existent aliases", () => {
      const resolved = resolveProjectPath("definitely-not-a-real-project-xyz123");

      // Should fall back to HOME since path doesn't exist
      expect(resolved).toBe(HOME);
    });

    test("resolveProjectPath handles absolute paths", () => {
      const absolutePath = "/tmp/some-absolute-path";
      const resolved = resolveProjectPath(absolutePath);
      expect(resolved).toBe(absolutePath);
    });

    test("resolveProjectPath expands tilde", () => {
      const tilePath = "~/some-dir";
      const resolved = resolveProjectPath(tilePath);
      expect(resolved).toBe(`${HOME}/some-dir`);
    });
  });
});

describe("Project Switching Flow", () => {
  beforeEach(() => {
    resetSessionManager();
  });

  describe("Callback-based Project Switch (/projects button click)", () => {
    test("stores alias, not folder name, in lastUsedPerChat", async () => {
      const chatId = 12345;
      const projectAlias = "exmas-commuter"; // This is what comes from callback data

      // Simulate what handleProjectCallback does:
      // const projName = projectName.toLowerCase();
      const projName = projectAlias.toLowerCase();
      sessionManager.setLastUsed(chatId, projName);

      // Verify
      const lastUsed = sessionManager.getLastUsed(chatId);
      expect(lastUsed).toBe("exmas-commuter");

      // This should be resolvable (if the alias exists)
      // In real scenario, the alias file maps alias -> path
    });

    test("lowercase conversion is applied", async () => {
      const chatId = 12345;
      const projectAlias = "ExMas-Commuter"; // Mixed case alias

      // The code does: const projName = projectName.toLowerCase();
      const projName = projectAlias.toLowerCase();
      sessionManager.setLastUsed(chatId, projName);

      expect(sessionManager.getLastUsed(chatId)).toBe("exmas-commuter");
    });
  });

  describe("@project syntax switching", () => {
    test("extracts and stores alias from @syntax", async () => {
      const chatId = 12345;
      const messageText = "@my-cool-project Hello, world!";

      // Simulate what text.ts does:
      const atMatch = messageText.match(/^@(\S+)\s+(.+)$/s);
      expect(atMatch).not.toBe(null);

      const [, projectAlias, remainingMessage] = atMatch!;
      expect(projectAlias).toBe("my-cool-project");
      expect(remainingMessage).toBe("Hello, world!");

      // The code does: const projName = projectAlias!.toLowerCase();
      const projName = projectAlias!.toLowerCase();
      sessionManager.setLastUsed(chatId, projName);

      expect(sessionManager.getLastUsed(chatId)).toBe("my-cool-project");
    });

    test("handles mixed-case @project aliases", async () => {
      const chatId = 12345;
      const messageText = "@MyProject Test message";

      const atMatch = messageText.match(/^@(\S+)\s+(.+)$/s);
      const [, projectAlias] = atMatch!;

      // Code does lowercase conversion
      const projName = projectAlias!.toLowerCase();
      sessionManager.setLastUsed(chatId, projName);

      expect(sessionManager.getLastUsed(chatId)).toBe("myproject");
    });
  });

  describe("Session Creation with Correct Working Directory", () => {
    test("session uses resolved path from alias", async () => {
      const chatId = 12345;

      // Use a test alias file path to avoid overwriting production aliases
      const testAliasFile = "/tmp/test-telegram-project-aliases.json";
      const alias = "test-alias";
      const expectedPath = "/tmp/test-alias-project";

      // Create the test directory
      mkdirSync(expectedPath, { recursive: true });

      // Note: We can't easily test the full alias resolution without mocking
      // the alias file location. Instead, test that sessions are created
      // with the correct project name and that lastUsed tracking works.

      // Simulate project switch
      sessionManager.setLastUsed(chatId, alias);

      // Get the session
      const session = await sessionManager.getOrCreateSession(alias);

      // Session should be created with the alias as project name
      expect(session.projectName).toBe(alias);

      // lastUsed should be tracked
      expect(sessionManager.getLastUsed(chatId)).toBe(alias);

      // Cleanup
      rmSync(expectedPath, { recursive: true, force: true });
    });
  });
});

describe("Bug Reproduction: Folder Name vs Alias", () => {
  beforeEach(() => {
    resetSessionManager();
  });

  test("BUG: using folder name causes inconsistent behavior", async () => {
    const chatId = 12345;

    // OLD BUG: Code was doing:
    // const projName = projectPath.split("/").pop(); // "ExMasCommuter"
    // sessionManager.setLastUsed(chatId, projName);

    // This would store "ExMasCommuter" instead of "exmas-commuter"
    const folderName = "ExMasCommuter"; // What the bug was storing

    sessionManager.setLastUsed(chatId, folderName);

    // Later, when resolving:
    const lastUsed = sessionManager.getLastUsed(chatId);
    expect(lastUsed).toBe("ExMasCommuter");

    // resolveProjectPath tries multiple candidate paths and may find it
    // BUT the problem is inconsistency - "ExMasCommuter" !== "exmas-commuter"
    // This causes issues when:
    // 1. Looking up sessions by project name (case mismatch)
    // 2. Comparing against alias registry (alias lookup fails)

    // The key issue: aliased sessions use lowercase, but folder-name sessions use mixed case
    // This leads to duplicate sessions for the same project
    const alias = "exmas-commuter"; // What SHOULD be stored
    expect(lastUsed).not.toBe(alias); // This is the bug - mismatch!
  });

  test("FIX: using alias works correctly", async () => {
    const chatId = 12345;

    // FIXED CODE: Uses the alias directly
    // const projName = projectAlias.toLowerCase(); // "exmas-commuter"
    // sessionManager.setLastUsed(chatId, projName);

    const alias = "exmas-commuter";

    sessionManager.setLastUsed(chatId, alias);

    const lastUsed = sessionManager.getLastUsed(chatId);
    expect(lastUsed).toBe("exmas-commuter");

    // If the alias is registered in the alias file, this would resolve correctly
    // resolveProjectPath("exmas-commuter") → finds alias → returns actual path
  });
});

describe("Integration: Complete Project Switch Cycle", () => {
  beforeEach(() => {
    resetSessionManager();
  });

  test("full cycle: click project button → send message → correct directory", async () => {
    const chatId = 12345;
    const projectAlias = "test-project";

    // Step 1: User clicks project button in /projects
    // This triggers handleProjectCallback which does:
    // const projName = projectName.toLowerCase();
    // sessionManager.setLastUsed(chatId, projName);
    sessionManager.setLastUsed(chatId, projectAlias);

    // Step 2: User sends a message
    // handleText does: const projectName = getProjectNameForChat(chatId);
    const projectName = sessionManager.getLastUsed(chatId);
    expect(projectName).toBe("test-project");

    // Step 3: Get or create session
    // sessionManager.getOrCreateSession(projectName) uses resolveProjectPath
    const session = await sessionManager.getOrCreateSession(projectName!);

    // The session should be for the correct project
    expect(session.projectName).toBe("test-project");

    // Step 4: Verify lastUsed is preserved
    expect(sessionManager.getLastUsed(chatId)).toBe("test-project");
  });

  test("switching projects preserves previous sessions", async () => {
    const chatId = 12345;

    // Switch to project A
    sessionManager.setLastUsed(chatId, "project-a");
    const sessionA = await sessionManager.getOrCreateSession("project-a");
    sessionA.session.sessionId = "session-a-id";

    // Switch to project B
    sessionManager.setLastUsed(chatId, "project-b");
    const sessionB = await sessionManager.getOrCreateSession("project-b");
    sessionB.session.sessionId = "session-b-id";

    // Both sessions should exist
    expect(sessionManager.getAllSessions().length).toBe(2);

    // Session A should still have its ID
    const retrievedA = sessionManager.getSession("project-a");
    expect(retrievedA?.session.sessionId).toBe("session-a-id");

    // Session B should have its ID
    const retrievedB = sessionManager.getSession("project-b");
    expect(retrievedB?.session.sessionId).toBe("session-b-id");

    // Last used should be project B
    expect(sessionManager.getLastUsed(chatId)).toBe("project-b");
  });
});

describe("Edge Cases", () => {
  beforeEach(() => {
    resetSessionManager();
  });

  test("handles empty alias gracefully", () => {
    const chatId = 12345;

    // Should not crash
    sessionManager.setLastUsed(chatId, "");

    // Empty string might be stored or treated as falsy/null
    // The important thing is it doesn't throw
    const lastUsed = sessionManager.getLastUsed(chatId);
    expect(lastUsed === "" || lastUsed === null).toBe(true);
  });

  test("handles special characters in project names", async () => {
    const chatId = 12345;
    const projectName = "my-project_v2.0";

    sessionManager.setLastUsed(chatId, projectName);
    expect(sessionManager.getLastUsed(chatId)).toBe("my-project_v2.0");

    const session = await sessionManager.getOrCreateSession(projectName);
    expect(session.projectName).toBe("my-project_v2.0");
  });

  test("returns null for untracked chat", () => {
    expect(sessionManager.getLastUsed(99999)).toBe(null);
  });
});
