# Plan: Auto-Resume After Restart

## Goal
When the bot restarts (crash, manual restart, or cloud instance restart), automatically:
1. Detect which sessions had **actively running queries** when shutdown occurred
2. Send a "continuing from where we left off" message **only to those chats**
3. Resume the Claude sessions and send a "continue" prompt
4. Use PM2 for automatic crash recovery

## Current State Analysis

### What Already Exists
- **Session persistence**: `/tmp/claude-telegram-session.json` saves session_id, project, working_dir
- **Resume capability**: `/resume` command and `session.resumeSession()` work
- **Restart tracking**: `RESTART_FILE` tracks message to update after restart
- **Running state**: `session.isRunning` and `queryLock` track active queries

### What's Missing
- No tracking of **which chats had active queries** when shutdown occurred
- No automatic resume on startup
- No PM2 configuration

---

## Implementation Plan

### 1. Create Active Sessions File (`src/config.ts`)

Add new constant:
```typescript
export const ACTIVE_SESSIONS_FILE = "/tmp/claude-telegram-active.json";
```

Structure:
```typescript
interface ActiveSessionsData {
  shutdown_time: string;        // ISO timestamp
  reason: "signal" | "restart" | "crash";
  sessions: Array<{
    chat_id: number;
    project_name: string;
    session_id: string;
    last_message?: string;      // What user was asking
    was_running: boolean;       // True if query was in progress
  }>;
}
```

---

### 2. Save Active State on Shutdown (`src/index.ts`)

Modify the graceful shutdown handlers to save active sessions:

```typescript
async function saveActiveSessionsAndExit(reason: "signal" | "restart") {
  const activeData: ActiveSessionsData = {
    shutdown_time: new Date().toISOString(),
    reason,
    sessions: []
  };

  // Get all project sessions from session manager
  const allSessions = sessionManager.getAllSessions();

  for (const projSess of allSessions) {
    // Get all chat IDs that were using this project
    // (need to add reverse lookup to session manager)
    const chatIds = sessionManager.getChatIdsForProject(projSess.projectName);

    for (const chatId of chatIds) {
      activeData.sessions.push({
        chat_id: chatId,
        project_name: projSess.projectName,
        session_id: projSess.session.sessionId || "",
        last_message: projSess.session.lastMessage || undefined,
        was_running: projSess.isRunning()
      });
    }
  }

  // Save to file
  await Bun.write(ACTIVE_SESSIONS_FILE, JSON.stringify(activeData, null, 2));

  stopRunner();
  process.exit(0);
}

// Update signal handlers
process.on("SIGINT", () => saveActiveSessionsAndExit("signal"));
process.on("SIGTERM", () => saveActiveSessionsAndExit("signal"));
```

---

### 3. Add Chat Tracking to Session Manager (`src/session-manager.ts`)

Add method to get chat IDs for a project:

```typescript
// Already have: lastUsedPerChat: Map<number, string>
// Add reverse lookup:

getChatIdsForProject(projectName: string): number[] {
  const chatIds: number[] = [];
  for (const [chatId, project] of this.lastUsedPerChat.entries()) {
    if (project === projectName) {
      chatIds.push(chatId);
    }
  }
  return chatIds;
}
```

---

### 4. Auto-Resume on Startup (`src/index.ts`)

After bot starts, check for interrupted sessions:

```typescript
// After: const botInfo = await bot.api.getMe();

// Check for interrupted sessions (from crash/restart)
if (existsSync(ACTIVE_SESSIONS_FILE)) {
  try {
    const data: ActiveSessionsData = JSON.parse(
      readFileSync(ACTIVE_SESSIONS_FILE, "utf-8")
    );

    const age = Date.now() - new Date(data.shutdown_time).getTime();

    // Only resume if shutdown was recent (within 5 minutes)
    if (age < 5 * 60 * 1000) {
      // Filter to only sessions that were actively running
      const interruptedSessions = data.sessions.filter(s => s.was_running);

      for (const sess of interruptedSessions) {
        // Send notification to chat
        await bot.api.sendMessage(
          sess.chat_id,
          `🔄 <b>Bot restarted</b>\n\n` +
          `Continuing from where we left off...`,
          { parse_mode: "HTML" }
        );

        // Resume the session and continue
        const projectSession = await sessionManager.getOrCreateSession(sess.project_name);

        if (sess.session_id) {
          projectSession.session.resumeSession(sess.session_id);
        }

        // Send continue prompt to Claude
        // This will be handled by queueing a message to the text handler
        // Store in a pending continues map that text handler checks
        pendingContinues.set(sess.chat_id, {
          projectName: sess.project_name,
          sessionId: sess.session_id
        });
      }
    }

    // Clean up
    unlinkSync(ACTIVE_SESSIONS_FILE);
  } catch (e) {
    console.warn("Failed to restore interrupted sessions:", e);
    try { unlinkSync(ACTIVE_SESSIONS_FILE); } catch {}
  }
}
```

---

### 5. Handle Pending Continues (`src/handlers/text.ts`)

Add logic to check for pending continues and auto-send "continue from where you left off":

```typescript
// At module level
export const pendingContinues = new Map<number, {
  projectName: string;
  sessionId: string;
}>();

// In handleText, after auth check:
const pending = pendingContinues.get(chatId);
if (pending) {
  pendingContinues.delete(chatId);

  // The current message is the first after restart
  // Prepend context about the restart
  const originalMessage = text;
  text = `[Context: The bot just restarted while you were working. The user's new message is below. If they seem to be continuing previous work, acknowledge the restart and continue helping.]\n\n${originalMessage}`;
}
```

---

### 6. Update Restart Command (`src/handlers/commands.ts`)

Update `/restart` to properly save state before exiting:

```typescript
export async function handleRestart(ctx: Context): Promise<void> {
  // ... existing auth check ...

  const msg = await ctx.reply("🔄 Restarting bot...");

  // Save restart message info
  if (chatId && msg.message_id) {
    await Bun.write(RESTART_FILE, JSON.stringify({
      chat_id: chatId,
      message_id: msg.message_id,
      timestamp: Date.now(),
    }));
  }

  // Save active sessions state (imports saveActiveSessionsAndExit from index)
  await saveActiveSessionsState("restart");

  await Bun.sleep(500);
  process.exit(0);
}
```

---

### 7. PM2 Configuration (`ecosystem.config.js`)

Create PM2 ecosystem file for auto-restart:

```javascript
module.exports = {
  apps: [{
    name: "claude-telegram-bot",
    script: "bun",
    args: "run start",
    cwd: "/home/ubuntu/Projects/claude-telegram-bot",

    // Auto-restart on crash
    autorestart: true,
    max_restarts: 10,
    min_uptime: "10s",
    restart_delay: 2000,

    // Environment
    env: {
      NODE_ENV: "production",
      // Other env vars loaded from .env
    },

    // Logging
    log_file: "/tmp/claude-telegram-bot.log",
    error_file: "/tmp/claude-telegram-bot.err",
    merge_logs: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss",

    // Watch for changes (optional, for dev)
    watch: false,
    ignore_watch: ["node_modules", ".git", "*.log"],
  }]
};
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/config.ts` | Add `ACTIVE_SESSIONS_FILE` constant |
| `src/types.ts` | Add `ActiveSessionsData` interface |
| `src/session-manager.ts` | Add `getChatIdsForProject()` method |
| `src/index.ts` | Add save-on-shutdown and restore-on-startup logic |
| `src/handlers/commands.ts` | Update `/restart` to save state |
| `src/handlers/text.ts` | Add pending continues handling |
| `ecosystem.config.js` | New file for PM2 configuration |

---

## Testing Plan

1. **Manual restart test**:
   - Start conversation with bot
   - Mid-query, run `/restart`
   - Verify bot sends "continuing from where we left off" message
   - Verify Claude has context

2. **Crash simulation**:
   - Start conversation with bot
   - Kill process with `kill -9`
   - PM2 should auto-restart
   - Verify interrupted session is resumed

3. **Clean restart test**:
   - Start conversation, wait for it to complete
   - Run `/restart`
   - Verify NO auto-continue message (wasn't running when shutdown)

4. **Multi-project test**:
   - Open sessions in multiple projects
   - Have one actively running
   - Restart
   - Verify only the running one gets continued

---

## Rollback Plan

If issues occur:
1. Delete `ACTIVE_SESSIONS_FILE` constant usage
2. Revert signal handlers to simple exit
3. Remove pending continues logic
4. Keep PM2 config (it's independent)
