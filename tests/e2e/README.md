# E2E Tests for Session Continuity

These tests verify that session IDs are properly maintained across multiple messages, ensuring:
- Multiple messages to the same project use the same session (resume with same sessionId)
- Different chats/projects have isolated sessions
- `/new` command starts a fresh session

## Running E2E Tests

E2E tests must be run separately from other tests due to module isolation requirements:

```bash
# Run e2e tests only
bun test tests/e2e/

# Run all other tests
bun test --ignore tests/e2e/
```

## Why Separate?

These tests use a mock for the Claude SDK (`@anthropic-ai/claude-agent-sdk`) to avoid token costs.
Due to how bun caches modules across test files, the mock must be installed before any source
files are imported. When running with other test files that import source files directly, the
mock may not be applied correctly.

## What These Tests Verify

1. **Session Continuity**: Second message to same project passes `resume` option with session ID
2. **Multi-Chat Isolation**: Different chats can use the same project session (per-project, not per-chat)
3. **`/new` Command**: Clears session so next message starts fresh
4. **Session ID Consistency**: Same session ID is used across multiple messages
