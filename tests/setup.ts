/**
 * Test setup - runs before all tests
 */

// Set test environment
process.env.NODE_ENV = "test";

// Set mock config for tests
process.env.TELEGRAM_ALLOWED_USERS = "12345";
process.env.SHOW_PROJECT_HEADERS = "always";
process.env.CLAUDE_WORKING_DIR = "/tmp/test-working-dir";

// Suppress console output during tests (optional)
if (process.env.QUIET_TESTS === "true") {
  global.console = {
    ...console,
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
  };
}
