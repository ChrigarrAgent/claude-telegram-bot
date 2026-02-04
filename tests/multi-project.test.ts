/**
 * Multi-Project Architecture Tests
 *
 * Tests the complete multi-project session management pipeline including:
 * - Race condition protection
 * - Concurrent project execution
 * - Session persistence and resume
 * - Project routing
 * - Command enhancements
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { sessionManager } from "../src/session-manager";
import { ProjectSession } from "../src/project-session";
import { ClaudeSession } from "../src/session";
import { resolveProjectPath } from "../src/config";

describe("SessionManager", () => {
  beforeEach(() => {
    // Clear session manager state before each test
    sessionManager["sessions"].clear();
    sessionManager["creationLocks"].clear();
    sessionManager["lastUsedPerChat"].clear();
    sessionManager.setCurrentProject("default");
  });

  describe("Race Condition Protection", () => {
    test("prevents duplicate session creation when multiple messages arrive simultaneously", async () => {
      // Create 5 concurrent requests for the same project
      const promises = Array(5)
        .fill(0)
        .map(() => sessionManager.getOrCreateSession("test-project"));

      const sessions = await Promise.all(promises);

      // All promises should return the SAME session instance
      const firstSession = sessions[0]!;
      for (const sess of sessions) {
        expect(sess).toBe(firstSession);
      }

      // Only ONE session should be created
      expect(sessionManager.getAllSessions().length).toBe(1);
    });

    test("allows concurrent creation of different projects", async () => {
      const promise1 = sessionManager.getOrCreateSession("project1");
      const promise2 = sessionManager.getOrCreateSession("project2");
      const promise3 = sessionManager.getOrCreateSession("project3");

      const [sess1, sess2, sess3] = await Promise.all([
        promise1,
        promise2,
        promise3,
      ]);

      // All sessions should be different
      expect(sess1).not.toBe(sess2);
      expect(sess2).not.toBe(sess3);
      expect(sess1).not.toBe(sess3);

      // Three sessions should exist
      expect(sessionManager.getAllSessions().length).toBe(3);
      expect(sess1.projectName).toBe("project1");
      expect(sess2.projectName).toBe("project2");
      expect(sess3.projectName).toBe("project3");
    });
  });

  describe("Project Tracking", () => {
    test("tracks last-used project per chat", async () => {
      const chatId1 = 12345;
      const chatId2 = 67890;

      sessionManager.setLastUsed(chatId1, "project-a");
      sessionManager.setLastUsed(chatId2, "project-b");

      expect(sessionManager.getLastUsed(chatId1)).toBe("project-a");
      expect(sessionManager.getLastUsed(chatId2)).toBe("project-b");
    });

    test("returns null for unknown chat", () => {
      expect(sessionManager.getLastUsed(99999)).toBe(null);
    });

    test("updates current project when set", async () => {
      sessionManager.setCurrentProject("my-project");
      expect(sessionManager.getCurrentProject()).toBe("my-project");
    });
  });

  describe("Session Retrieval", () => {
    test("getSession returns null for non-existent project", () => {
      expect(sessionManager.getSession("nonexistent")).toBe(null);
    });

    test("getSession returns existing session", async () => {
      const created = await sessionManager.getOrCreateSession("existing");
      const retrieved = sessionManager.getSession("existing");

      expect(retrieved).toBe(created);
    });

    test("getAllSessions returns all active sessions", async () => {
      await sessionManager.getOrCreateSession("proj1");
      await sessionManager.getOrCreateSession("proj2");
      await sessionManager.getOrCreateSession("proj3");

      const all = sessionManager.getAllSessions();
      expect(all.length).toBe(3);

      const projectNames = all.map((s) => s.projectName).sort();
      expect(projectNames).toEqual(["proj1", "proj2", "proj3"]);
    });
  });

  describe("Session Status", () => {
    test("getSessionStatus returns null for non-existent project", () => {
      expect(sessionManager.getSessionStatus("nope")).toBe(null);
    });

    test("getSessionStatus returns status for existing project", async () => {
      await sessionManager.getOrCreateSession("test");
      const status = sessionManager.getSessionStatus("test");

      expect(status).not.toBe(null);
      expect(status?.projectName).toBe("test");
      expect(status?.isActive).toBe(false); // No session ID yet
      expect(status?.isRunning).toBe(false);
    });

    test("getAllSessionStatus returns statuses for all projects", async () => {
      await sessionManager.getOrCreateSession("a");
      await sessionManager.getOrCreateSession("b");

      const statuses = sessionManager.getAllSessionStatus();
      expect(statuses.length).toBe(2);

      const names = statuses.map((s) => s.projectName).sort();
      expect(names).toEqual(["a", "b"]);
    });
  });
});

describe("ProjectSession", () => {
  describe("Query Locking", () => {
    test("prevents concurrent queries to same session", async () => {
      const claudeSession = new ClaudeSession();
      const projectSession = new ProjectSession(
        "test",
        "/tmp/test",
        claudeSession
      );

      // Mock sendMessageStreaming to take time
      let callCount = 0;
      claudeSession.sendMessageStreaming = async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "response";
      };

      // Start first query
      const promise1 = projectSession.sendMessage(
        "msg1",
        "user",
        123,
        async () => {},
        456
      );

      // Try to start second query immediately
      const promise2 = projectSession
        .sendMessage("msg2", "user", 123, async () => {}, 456)
        .catch((e) => e);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // First query should succeed
      expect(result1).toBe("response");

      // Second query should fail with lock error
      expect(result2).toBeInstanceOf(Error);
      expect((result2 as Error).message).toContain(
        "Query already running"
      );

      // Only one call should have been made
      expect(callCount).toBe(1);
    });

    test("allows sequential queries", async () => {
      const claudeSession = new ClaudeSession();
      const projectSession = new ProjectSession(
        "test",
        "/tmp/test",
        claudeSession
      );

      let callCount = 0;
      claudeSession.sendMessageStreaming = async () => {
        callCount++;
        return `response ${callCount}`;
      };

      // Run queries sequentially
      const result1 = await projectSession.sendMessage(
        "msg1",
        "user",
        123,
        async () => {},
        456
      );
      const result2 = await projectSession.sendMessage(
        "msg2",
        "user",
        123,
        async () => {},
        456
      );

      expect(result1).toBe("response 1");
      expect(result2).toBe("response 2");
      expect(callCount).toBe(2);
    });
  });

  describe("Activity Tracking", () => {
    test("updates lastActivity on message send", async () => {
      const claudeSession = new ClaudeSession();
      const projectSession = new ProjectSession(
        "test",
        "/tmp/test",
        claudeSession
      );

      claudeSession.sendMessageStreaming = async () => "ok";

      const beforeTime = Date.now();
      await projectSession.sendMessage("msg", "user", 123, async () => {}, 456);
      const afterTime = Date.now();

      const idleTime = projectSession.getIdleTime();

      // Idle time should be very small (< 100ms)
      expect(idleTime).toBeLessThan(100);
      expect(projectSession.lastActivity.getTime()).toBeGreaterThanOrEqual(
        beforeTime
      );
      expect(projectSession.lastActivity.getTime()).toBeLessThanOrEqual(
        afterTime
      );
    });

    test("manual updateActivity updates timestamp", async () => {
      const claudeSession = new ClaudeSession();
      const projectSession = new ProjectSession(
        "test",
        "/tmp/test",
        claudeSession
      );

      const before = projectSession.lastActivity.getTime();
      await new Promise((resolve) => setTimeout(resolve, 50));
      projectSession.updateActivity();
      const after = projectSession.lastActivity.getTime();

      expect(after).toBeGreaterThan(before);
    });
  });

  describe("Session Status", () => {
    test("isActive returns false when no session ID", () => {
      const claudeSession = new ClaudeSession();
      const projectSession = new ProjectSession(
        "test",
        "/tmp/test",
        claudeSession
      );

      expect(projectSession.isActive()).toBe(false);
    });

    test("isActive returns true when session ID exists", () => {
      const claudeSession = new ClaudeSession();
      claudeSession.sessionId = "test-session-id";
      const projectSession = new ProjectSession(
        "test",
        "/tmp/test",
        claudeSession
      );

      expect(projectSession.isActive()).toBe(true);
    });

    test("getStatus returns complete status", () => {
      const claudeSession = new ClaudeSession();
      claudeSession.sessionId = "abc123";
      const projectSession = new ProjectSession(
        "my-project",
        "/home/ubuntu/Projects/my-project",
        claudeSession
      );

      const status = projectSession.getStatus();

      expect(status.projectName).toBe("my-project");
      expect(status.workingDir).toBe("/home/ubuntu/Projects/my-project");
      expect(status.isActive).toBe(true);
      expect(status.sessionId).toBe("abc123");
      expect(status.idleSeconds).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("Project Resolution", () => {
  test("resolves PROJECT_ALIASES", () => {
    const path = resolveProjectPath("home");
    expect(path).toContain("/home/ubuntu");
  });

  test("resolves absolute paths", () => {
    const path = resolveProjectPath("/tmp/test");
    expect(path).toBe("/tmp/test");
  });

  test("expands tilde to home directory", () => {
    const path = resolveProjectPath("~/test");
    expect(path).toContain("/home/ubuntu");
    expect(path).toContain("/test");
  });

  test("falls back to Projects directory for unknown names", () => {
    const path = resolveProjectPath("unknown-project");
    expect(path).toContain("/home/ubuntu/Projects/unknown-project");
  });
});

describe("Concurrent Project Execution", () => {
  test("different projects can execute simultaneously", async () => {
    // Track execution order
    const executionLog: string[] = [];

    // Create sessions for two projects
    const session1 = await sessionManager.getOrCreateSession("project1");
    const session2 = await sessionManager.getOrCreateSession("project2");

    // Mock slow execution
    session1.session.sendMessageStreaming = async () => {
      executionLog.push("project1-start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      executionLog.push("project1-end");
      return "response1";
    };

    session2.session.sendMessageStreaming = async () => {
      executionLog.push("project2-start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      executionLog.push("project2-end");
      return "response2";
    };

    // Execute both simultaneously
    const [result1, result2] = await Promise.all([
      session1.sendMessage("msg1", "user", 123, async () => {}, 456),
      session2.sendMessage("msg2", "user", 123, async () => {}, 456),
    ]);

    // Both should complete
    expect(result1).toBe("response1");
    expect(result2).toBe("response2");

    // Execution should be interleaved (concurrent)
    expect(executionLog).toContain("project1-start");
    expect(executionLog).toContain("project2-start");
    expect(executionLog).toContain("project1-end");
    expect(executionLog).toContain("project2-end");

    // Both should start before either ends (proof of concurrency)
    const p1Start = executionLog.indexOf("project1-start");
    const p2Start = executionLog.indexOf("project2-start");
    const p1End = executionLog.indexOf("project1-end");
    const p2End = executionLog.indexOf("project2-end");

    expect(p1Start).toBeLessThan(p1End);
    expect(p2Start).toBeLessThan(p2End);

    // At least one project should start before the other ends (concurrency)
    const firstStart = Math.min(p1Start, p2Start);
    const firstEnd = Math.min(p1End, p2End);
    const lastStart = Math.max(p1Start, p2Start);

    expect(lastStart).toBeLessThan(firstEnd);
  });
});

describe("Session Persistence", () => {
  test("sessions maintain state across message sends", async () => {
    const projectSession = await sessionManager.getOrCreateSession(
      "persistent"
    );

    // Simulate session ID being set by first message
    projectSession.session.sessionId = "session-abc123";

    // Send multiple messages
    projectSession.session.sendMessageStreaming = async () => "ok";

    await projectSession.sendMessage("msg1", "user", 123, async () => {}, 456);
    await projectSession.sendMessage("msg2", "user", 123, async () => {}, 456);

    // Session ID should persist
    expect(projectSession.session.sessionId).toBe("session-abc123");
    expect(projectSession.isActive()).toBe(true);
  });

  test("kill clears session state", async () => {
    const projectSession = await sessionManager.getOrCreateSession("killable");
    projectSession.session.sessionId = "session-xyz";

    expect(projectSession.isActive()).toBe(true);

    await projectSession.kill();

    expect(projectSession.isActive()).toBe(false);
    expect(projectSession.session.sessionId).toBe(null);
  });
});

describe("Error Isolation", () => {
  test("error in one project does not affect another", async () => {
    const session1 = await sessionManager.getOrCreateSession("stable");
    const session2 = await sessionManager.getOrCreateSession("failing");

    session1.session.sendMessageStreaming = async () => "success";
    session2.session.sendMessageStreaming = async () => {
      throw new Error("Simulated failure");
    };

    // Execute both (one will fail)
    const [result1, result2] = await Promise.allSettled([
      session1.sendMessage("msg1", "user", 123, async () => {}, 456),
      session2.sendMessage("msg2", "user", 123, async () => {}, 456),
    ]);

    // First should succeed
    expect(result1.status).toBe("fulfilled");
    if (result1.status === "fulfilled") {
      expect(result1.value).toBe("success");
    }

    // Second should fail
    expect(result2.status).toBe("rejected");

    // First project session should still be healthy
    expect(session1.isActive()).toBe(false); // No session ID yet, but no error
    const status1 = session1.getStatus();
    expect(status1.isRunning).toBe(false); // Not stuck in running state
  });
});

describe("Integration: Complete Workflow", () => {
  beforeEach(() => {
    // Clear state before integration tests
    sessionManager["sessions"].clear();
    sessionManager["creationLocks"].clear();
    sessionManager["lastUsedPerChat"].clear();
    sessionManager.setCurrentProject("default");
  });

  test("complete multi-project workflow", async () => {
    const chatId = 12345;

    // Step 1: User sends message to project1
    sessionManager.setLastUsed(chatId, "project1");
    const proj1 = await sessionManager.getOrCreateSession("project1");

    proj1.session.sendMessageStreaming = async () => {
      proj1.session.sessionId = "proj1-session";
      return "Hello from project1";
    };

    const response1 = await proj1.sendMessage(
      "test",
      "user",
      123,
      async () => {},
      chatId
    );

    expect(response1).toBe("Hello from project1");
    expect(proj1.isActive()).toBe(true);

    // Step 2: User switches to project2
    sessionManager.setLastUsed(chatId, "project2");
    const proj2 = await sessionManager.getOrCreateSession("project2");

    proj2.session.sendMessageStreaming = async () => {
      proj2.session.sessionId = "proj2-session";
      return "Hello from project2";
    };

    const response2 = await proj2.sendMessage(
      "test",
      "user",
      123,
      async () => {},
      chatId
    );

    expect(response2).toBe("Hello from project2");
    expect(proj2.isActive()).toBe(true);

    // Step 3: Both sessions should still exist independently
    expect(proj1.isActive()).toBe(true);
    expect(proj2.isActive()).toBe(true);
    expect(proj1.session.sessionId).toBe("proj1-session");
    expect(proj2.session.sessionId).toBe("proj2-session");

    // Step 4: Get status of all projects
    const allStatuses = sessionManager.getAllSessionStatus();
    expect(allStatuses.length).toBe(2);

    const names = allStatuses.map((s) => s.projectName).sort();
    expect(names).toEqual(["project1", "project2"]);

    // Step 5: Verify last-used tracking
    expect(sessionManager.getLastUsed(chatId)).toBe("project2");
  });

  test("rapid message sending to different projects", async () => {
    // Simulate user rapidly switching between projects
    const messages = [
      { project: "proj-a", text: "msg1" },
      { project: "proj-b", text: "msg2" },
      { project: "proj-a", text: "msg3" },
      { project: "proj-c", text: "msg4" },
      { project: "proj-b", text: "msg5" },
    ];

    const results: string[] = [];

    for (const msg of messages) {
      const session = await sessionManager.getOrCreateSession(msg.project);

      session.session.sendMessageStreaming = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return `${msg.project}-response`;
      };

      const response = await session.sendMessage(
        msg.text,
        "user",
        123,
        async () => {},
        456
      );

      results.push(response);
    }

    // All responses should be correct
    expect(results).toEqual([
      "proj-a-response",
      "proj-b-response",
      "proj-a-response",
      "proj-c-response",
      "proj-b-response",
    ]);

    // Three distinct sessions should exist
    expect(sessionManager.getAllSessions().length).toBe(3);
  });
});
