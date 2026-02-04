/**
 * Global test setup - runs before ALL tests via bunfig.toml preload
 *
 * IMPORTANT: This file MUST:
 * 1. Set environment variables BEFORE any source imports
 * 2. Install mock SDK BEFORE any source imports
 */

import { mock } from "bun:test";

// ============== Environment Setup ==============
// These MUST be set before any imports from src/

process.env.NODE_ENV = "test";
process.env.TELEGRAM_BOT_TOKEN = "test-token-12345";
process.env.TELEGRAM_ALLOWED_USERS = "12345,67890";
process.env.SHOW_PROJECT_HEADERS = "always";
process.env.CLAUDE_WORKING_DIR = "/tmp/test-working-dir";

// File paths - use temp directory
process.env.SESSION_FILE = "/tmp/test-claude-session.json";
process.env.RESTART_FILE = "/tmp/test-claude-restart.json";
process.env.ACTIVE_SESSIONS_FILE = "/tmp/test-claude-active.json";
process.env.HEARTBEAT_FILE = "/tmp/test-claude-heartbeat.json";

// Disable rate limiting for tests
process.env.RATE_LIMIT_ENABLED = "false";

// ============== Mock SDK Installation ==============

// Import the mock from the dedicated module (so state is shared)
import { mockQuery } from "./helpers/mock-claude-sdk";

// Mock the Claude SDK module
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

// ============== Console Suppression ==============

// Suppress most console output during tests
if (process.env.DEBUG !== "true") {
  const originalConsole = { ...console };

  global.console = {
    ...console,
    log: (...args: any[]) => {
      // Only show specific logs in verbose mode
      if (args[0]?.includes?.("[MOCK SDK]") && process.env.VERBOSE_MOCKS === "true") {
        originalConsole.log(...args);
      }
    },
    debug: () => {},
    info: () => {},
    warn: originalConsole.warn,
    error: originalConsole.error,
  };
}
