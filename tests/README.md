# Test Suite

## Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test tests/multi-project.test.ts
bun test tests/handlers.test.ts

# Watch mode
bun test --watch
```

## Test Coverage

### multi-project.test.ts ✅ (28/28 passing)
Core architecture tests:
- **SessionManager**: Race condition protection, project tracking, session retrieval
- **ProjectSession**: Query locking, activity tracking, status reporting
- **Project Resolution**: Path resolution, alias handling
- **Concurrent Execution**: Multi-project simultaneous execution
- **Session Persistence**: State management across messages
- **Error Isolation**: One project's error doesn't affect others
- **Integration Workflows**: Complete user flows

### handlers.test.ts ⚠️ (11/17 passing)
Handler integration tests (partial - some require full bot context):
- **Text Handler Routing**: Message routing to correct project ✅
- **Project Headers**: Configuration-based header display ✅
- **Status Command**: Multi-project status display (partial)
- **Resume Command**: Cross-project session resumption (partial)
- **Project Command**: Project switching (partial)
- **Concurrent Messages**: Different projects execute simultaneously ✅

## Test Strategy

Tests use **mocked Claude SDK** to avoid costs and ensure fast, reliable execution.

Mock Strategy:
```typescript
ClaudeSession.prototype.sendMessageStreaming = async function(message: string) {
  if (!this.sessionId) {
    this.sessionId = `mock-session-${Date.now()}`;
  }
  return `Mock response to: ${message}`;
};
```

## Known Limitations

Some handler tests require full grammY bot context which is complex to mock. The core architecture is fully tested in `multi-project.test.ts`.

For end-to-end testing, use manual testing with real Telegram bot.

## Adding New Tests

1. Add test file in `tests/` directory
2. Import and use mock factories from `tests/helpers.ts` (if created)
3. Always clear `sessionManager` state in `beforeEach`:
   ```typescript
   beforeEach(() => {
     sessionManager["sessions"].clear();
     sessionManager["creationLocks"].clear();
     sessionManager["lastUsedPerChat"].clear();
     sessionManager.setCurrentProject("default");
   });
   ```

## Test Scenarios Covered

✅ Race condition when 5 concurrent messages arrive for same project
✅ Concurrent execution of different projects
✅ Session persistence across multiple messages
✅ Query locking prevents concurrent queries to same session
✅ Error in one project doesn't affect another
✅ Project tracking per chat
✅ Activity tracking and idle time calculation
✅ Complete multi-project workflow (switch → send → switch → send)
✅ Rapid project switching with message sends
