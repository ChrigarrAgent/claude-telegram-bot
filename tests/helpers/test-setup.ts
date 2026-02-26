/**
 * Test setup helpers for e2e tests
 *
 * This file provides helper functions for tests. The actual mock SDK is
 * installed by tests/setup.ts which is preloaded via bunfig.toml.
 */

// Re-export mock functions from the canonical source
export {
  resetMockSDK,
  getMockCalls,
  getLastMockCall,
  MockAssertions,
} from "./mock-claude-sdk";

// Re-export TestBot
export { TestBot } from "./test-bot";

/**
 * Create a test bot instance (lazy-loaded)
 */
export async function getTestBot() {
  const { createTestBot } = await import("./create-test-bot");
  return createTestBot();
}

/**
 * Reset session manager state and clear persisted session file
 */
export async function resetSessionManager() {
  const { resetSessionManager: reset } = await import("../../src/session-manager");
  reset();

  // Also delete the session file to prevent auto-resume
  const { unlinkSync, existsSync } = await import("fs");
  const sessionFile = process.env.SESSION_FILE || "/tmp/test-claude-session.json";
  try {
    if (existsSync(sessionFile)) {
      unlinkSync(sessionFile);
    }
  } catch {
    // Ignore if file doesn't exist
  }
}
