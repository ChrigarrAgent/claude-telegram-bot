# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run start      # Run the bot
bun run dev        # Run with auto-reload (--watch)
bun run typecheck  # Run TypeScript type checking
bun install        # Install dependencies
```

## Architecture

This is a Telegram bot (~3,300 lines TypeScript) that lets you control Claude Code from your phone via text, voice, photos, and documents. Built with Bun and grammY.

### Message Flow

```
Telegram message → Handler → Auth check → Rate limit → Claude session → Streaming response → Audit log
```

### Key Modules

- **`src/index.ts`** - Entry point, registers handlers, starts polling
- **`src/config.ts`** - Environment parsing, MCP loading, safety prompts, `resolveProjectPath()`
- **`src/session.ts`** - `ClaudeSession` class wrapping Agent SDK with streaming and session persistence
- **`src/session-manager.ts`** - `SessionManager` singleton coordinating multi-project sessions
- **`src/project-session.ts`** - `ProjectSession` wrapping `ClaudeSession` with project context
- **`src/project-aliases.ts`** - Human-friendly project names (`~/.claude/telegram-project-aliases.json`)
- **`src/security.ts`** - `RateLimiter` (token bucket), path validation, command safety checks
- **`src/formatting.ts`** - Markdown→HTML conversion for Telegram, tool status emoji formatting
- **`src/utils.ts`** - Audit logging, voice transcription (OpenAI), typing indicators
- **`src/types.ts`** - Shared TypeScript types

### Handlers (`src/handlers/`)

Each message type has a dedicated async handler:
- **`commands.ts`** - `/start`, `/new`, `/stop`, `/status`, `/resume`, `/restart`
- **`text.ts`** - Text messages with intent filtering
- **`voice.ts`** - Voice→text via OpenAI, then same flow as text
- **`photo.ts`** - Image analysis with media group buffering (1s timeout for albums)
- **`document.ts`** - PDF extraction (pdftotext CLI) and text file processing
- **`callback.ts`** - Inline keyboard button handling for ask_user MCP
- **`streaming.ts`** - Shared `StreamingState` and status callback factory

### Security Layers

1. User allowlist (`TELEGRAM_ALLOWED_USERS`)
2. Rate limiting (token bucket, configurable)
3. Path validation (`ALLOWED_PATHS`)
4. Command safety (blocked patterns)
5. System prompt constraints
6. Audit logging

### Configuration

All config via `.env` (copy from `.env.example`). Key variables:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` (required)
- `CLAUDE_WORKING_DIR` - Working directory for Claude
- `ALLOWED_PATHS` - Directories Claude can access
- `OPENAI_API_KEY` - For voice transcription

MCP servers defined in `mcp-config.ts`.

### Runtime Files

- `/tmp/claude-telegram-session.json` - Session persistence for `/resume`
- `/tmp/telegram-bot/` - Downloaded photos/documents
- `/tmp/claude-telegram-audit.log` - Audit log

## Patterns

**Adding a command**: Create handler in `commands.ts`, register in `index.ts` with `bot.command("name", handler)`

**Adding a message handler**: Create in `handlers/`, export from `index.ts`, register in `index.ts` with appropriate filter

**Streaming pattern**: All handlers use `createStatusCallback()` from `streaming.ts` and `session.sendMessageStreaming()` for live updates.

**Type checking**: Run `bun run typecheck` periodically while editing TypeScript files. Fix any type errors before committing.

**After code changes**: Restart the bot so changes can be tested. Use `launchctl kickstart -k gui/$(id -u)/com.claude-telegram-ts` if running as a service, or `bun run start` for manual runs.

## Standalone Build

The bot can be compiled to a standalone binary with `bun build --compile`. This is used by the ClaudeBot macOS app wrapper.

### External Dependencies

PDF extraction uses `pdftotext` CLI instead of an npm package (to avoid bundling issues):

```bash
brew install poppler  # Provides pdftotext
```

### PATH Requirements

When running as a standalone binary (especially from a macOS app), the PATH may not include Homebrew. The launcher must ensure PATH includes:
- `/opt/homebrew/bin` (Apple Silicon Homebrew)
- `/usr/local/bin` (Intel Homebrew)

Without this, `pdftotext` won't be found and PDF parsing will fail silently with an error message.

## Commit Style

Do not add "Generated with Claude Code" footers or "Co-Authored-By" trailers to commit messages.

## Running as Service (macOS)

```bash
cp launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# Edit plist with your paths
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist

# Logs
tail -f /tmp/claude-telegram-bot-ts.log
tail -f /tmp/claude-telegram-bot-ts.err
```

## Multi-Project System

The bot supports multiple concurrent projects with session isolation:

### Key Components

- **`src/session-manager.ts`** - `SessionManager` class coordinates `ProjectSession` instances
- **`src/project-session.ts`** - Wraps `ClaudeSession` with project-specific context
- **`src/project-aliases.ts`** - Manages human-friendly project names (stored in `~/.claude/telegram-project-aliases.json`)

### Session Routing

1. Each chat tracks its last-used project via `sessionManager.setLastUsed(chatId, projectName)`
2. Messages route to the project session, not a global session
3. Sessions auto-resume from persisted state when recreated

### Project Aliases

- Projects are only added when explicitly used (via `/project`, `@project` syntax, or first message)
- No auto-scanning of directories on startup
- Alias file validates paths exist before returning them

### Commands

- `/projects` - Lists all projects with inline keyboard buttons
- `/project <name>` - Switches to project (creates if doesn't exist)
- `@projectname message` - Routes message to specific project

## Known Issues & Solutions

### Issue: SDK fails silently with non-existent cwd

**Symptom**: No events received from `query()`, bot shows project header but no response

**Cause**: The Claude Agent SDK's `query()` function fails silently when `cwd` points to a non-existent directory

**Fix**:
1. Validate paths exist in `getProjectByAlias()` before returning them
2. `resolveProjectPath()` falls back to HOME instead of non-existent paths
3. Add debug logging: `console.log("DEBUG: Options:", JSON.stringify({cwd: options.cwd, ...}))`

### Issue: Session not resuming when replying to messages

**Symptom**: Bot creates new session instead of continuing conversation

**Cause**: When `_createSession()` creates a new `ClaudeSession`, it didn't load persisted session IDs

**Fix**: In `session-manager.ts`, auto-resume persisted session when creating ProjectSession:
```typescript
const savedSessions = claudeSession.getSessionList(projectName);
if (savedSessions.length > 0) {
  claudeSession.sessionId = mostRecent.session_id;
}
```

### Issue: Claude Code process exits with code 1

**Symptom**: `Error: Claude Code process exited with code 1` for voice/photo/document

**Cause**: Transient Claude Code CLI crashes

**Fix**: All handlers now have retry logic with `MAX_RETRIES = 1`:
```typescript
if (errorStr.includes("exited with code") && attempt < MAX_RETRIES) {
  await projectSession.kill(); // Clear corrupted session
  await ctx.reply(`⚠️ Claude crashed, retrying...`);
  continue;
}
```

### Issue: 409 Conflict errors

**Symptom**: `GrammyError: 409: Conflict: terminated by other getUpdates request`

**Cause**: Multiple bot instances running simultaneously. This happens when:
1. A process started outside PM2 (e.g., `bun run start` in terminal) is still running
2. PM2 crashed but left orphan bun processes
3. Bot was started manually while PM2 instance was running
4. Previous PM2 delete didn't kill the actual process

**Diagnosis**:
```bash
# Check PM2 status
pm2 status

# Check actual running processes (should match PM2 pid)
pgrep -af "bun.*claude"

# If PM2 shows pid X but pgrep shows pid Y, you have a stale process
```

**Fix**: Kill ALL processes before restarting:
```bash
# Full cleanup
pm2 delete claude-telegram-bot 2>/dev/null
pkill -9 -f "bun.*claude-telegram-bot"
sleep 2

# Verify clean
pgrep -af "bun.*claude"  # Should show nothing

# Start fresh
pm2 start bun --name claude-telegram-bot -- run start
```

**Prevention**: Always use PM2 to manage the bot. Never run `bun run start` directly on the server.

### Issue: Project switching uses wrong directory

**Symptom**: After switching projects via `/projects` or `@project` syntax, Claude runs in the wrong directory (e.g., `/home/ubuntu` instead of the project path)

**Cause**: Code was storing the **folder name** (e.g., `ExMasCommuter`) in `lastUsedPerChat` instead of the **alias** (e.g., `exmas-commuter`). When `resolveProjectPath()` later tries to look up `ExMasCommuter`, it can't find it because aliases are lowercase and different from folder names.

**How it happens**:
```typescript
// WRONG - extracts folder name from path
const projName = projectPath.split("/").pop();  // "ExMasCommuter"
sessionManager.setLastUsed(chatId, projName);
// Later: resolveProjectPath("ExMasCommuter") fails to find alias

// CORRECT - use the alias directly
const projName = projectAlias.toLowerCase();  // "exmas-commuter"
sessionManager.setLastUsed(chatId, projName);
// Later: resolveProjectPath("exmas-commuter") finds the alias
```

**Key insight**: The alias file maps `path → alias`:
```json
{
  "/home/ubuntu/Projects/ExMasCommuter": "exmas-commuter",
  "/home/ubuntu/Projects/resort_ranger": "resort-ranger"
}
```

The `resolveProjectPath()` function looks up by alias, not folder name. So `lastUsed` must store the alias.

**Fix**: In all project switching code (`callback.ts`, `text.ts`), use the alias for session tracking:
```typescript
// In callback.ts handleProjectCallback() and handleAskUserQuestionCallback()
const projName = projectName.toLowerCase();  // projectName IS the alias
sessionManager.setLastUsed(chatId, projName);

// In text.ts @project handling
const projName = projectAlias!.toLowerCase();  // Use the alias, not folder name
sessionManager.setLastUsed(chatId, projName);
```

**Debug logging**: Look for these log lines to trace project switching:
```bash
pm2 logs claude-telegram-bot --lines 100 --nostream 2>&1 | grep -E "\[PROJECT-SWITCH\]|\[getProjectNameForChat\]|\[SESSION\] cwd"
```

Expected output when working correctly:
```
[PROJECT-SWITCH] Set lastUsed for chatId=123 to projName=exmas-commuter (alias)
[getProjectNameForChat] chatId=123, lastUsed=exmas-commuter
[SESSION] cwd being passed to SDK: /home/ubuntu/Projects/ExMasCommuter
```

## Debugging Tips

### Debug Logging for SDK Issues

When the bot isn't responding, add debug logging around the SDK query:

```typescript
console.log("DEBUG: Creating query instance...");
console.log("DEBUG: Options:", JSON.stringify({
  model: options.model,
  cwd: options.cwd,  // CRITICAL: verify this path exists!
  resume: options.resume,
}));

let eventCount = 0;
for await (const event of queryInstance) {
  eventCount++;
  console.log(`DEBUG: Event ${eventCount}: type=${event.type}`);
  // ...
}
console.log(`DEBUG: Event loop finished. Total events: ${eventCount}`);
```

If `eventCount` stays at 0, the SDK is failing silently - check the `cwd` path.

### Checking Bot Logs

```bash
# Live logs
pm2 logs claude-telegram-bot

# Recent logs without streaming
pm2 logs claude-telegram-bot --lines 50 --nostream

# Search for specific errors
pm2 logs claude-telegram-bot --lines 200 --nostream 2>&1 | grep -E "Error|error|DEBUG"
```

### Handler Consistency

**IMPORTANT**: All message handlers (text, voice, photo, document) must use `sessionManager` for multi-project support. The global `session` export exists only for legacy compatibility.

```typescript
// CORRECT - use sessionManager
const projectSession = await sessionManager.getOrCreateSession(projectName);
await projectSession.sendMessage(message, ...);

// WRONG - bypasses multi-project routing
await session.sendMessageStreaming(message, ...);
```

### Path Validation Pattern

Always validate paths before passing to the SDK:

```typescript
import { existsSync } from "fs";

// In getProjectByAlias()
if (path && existsSync(path)) {
  return path;
}
return null;  // Don't return non-existent paths

// In resolveProjectPath()
if (!existsSync(resolved)) {
  return HOME;  // Fallback to safe default
}
```

### Testing Session Resume

To verify session resume is working:

1. Send a message and note the session ID in logs: `GOT session_id: abc123...`
2. Restart the bot: `pm2 restart claude-telegram-bot`
3. Send another message to the same project
4. Check logs for: `Auto-resumed session for <project>: abc123...`

If you see `STARTING new Claude session` instead of `Auto-resumed`, the resume logic isn't working.

## Running on Ubuntu Server (PM2)

```bash
# Start with PM2
pm2 start ecosystem.config.js

# Or directly
pm2 start "bun run start" --name claude-telegram-bot

# View status
pm2 status

# Restart after code changes
pm2 restart claude-telegram-bot

# Stop
pm2 stop claude-telegram-bot
```

### ecosystem.config.js

```javascript
module.exports = {
  apps: [{
    name: 'claude-telegram-bot',
    script: 'bun',
    args: 'run start',
    cwd: '/home/ubuntu/Projects/claude-telegram-bot',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
```
