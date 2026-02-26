# AI Agent Adapter - Quick Start

## 🎯 The Goal

**Make your Telegram bot work with any AI coding CLI without changing the bot code.**

## 🏗️ What We Built

An **adapter layer** that sits between your Telegram bot and the AI CLI:

```
Telegram Bot → AIAgentInterface → [Claude/Codex/OpenCode] → AI SDK
```

## 🚀 Quick Example

### Before (Hard-coded to Claude)

```typescript
// src/session.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

class ClaudeSession {
  async sendMessage(message: string) {
    const result = await query(message, options);
    return result;
  }
}
```

**Problem**: Can't switch to Codex or OpenCode without rewriting this file.

### After (Works with any CLI)

```typescript
// src/adapters/index.ts
import { createAgent } from "./adapters";

// Create agent based on env config
const agent = await createAgent(workingDir);

// Same interface for all CLIs!
const result = await agent.sendMessage(message, "user", chatId, callback);
```

**Benefit**: Switch CLIs by changing one env variable.

## 📝 3-Step Integration

### 1. Register Adapters (one-time setup)

In `src/index.ts`:

```typescript
import { registerAdapters } from "./adapters";

// At startup
registerAdapters();
```

### 2. Create Agent

Replace:
```typescript
const session = new ClaudeSession();
```

With:
```typescript
import { createAgent } from "./adapters";
const agent = await createAgent(workingDir, projectName);
```

### 3. Use Unified Interface

All methods are the same across CLIs:

```typescript
// Send message
await agent.sendMessage(message, "user", chatId, callback);

// Check status
if (agent.isProcessing()) { ... }

// Stop query
await agent.stop();

// New session
await agent.newSession();

// Get info
const info = agent.getSessionInfo();
```

## 🔧 Configuration

### Use Claude Code

```bash
# .env
AI_AGENT_TYPE=claude-code
ANTHROPIC_API_KEY=sk-ant-...
```

### Use Codex CLI

```bash
# .env
AI_AGENT_TYPE=codex-cli
OPENAI_API_KEY=sk-...
```

### Use OpenCode

```bash
# .env
AI_AGENT_TYPE=opencode
ANTHROPIC_API_KEY=sk-ant-...  # or other provider
```

## 🎨 Real-World Example

Here's how the Telegram bot sends a message with any CLI:

```typescript
import { createAgent, registerAdapters } from "./adapters";

// Setup (once at startup)
registerAdapters();

// Create agent (per project/session)
const agent = await createAgent("/home/user/project", "my-project");

// Define callback for streaming updates
const statusCallback = async (event) => {
  switch (event.type) {
    case "text":
      await bot.api.sendMessage(chatId, event.text);
      break;
    case "tool_start":
      await bot.api.sendMessage(chatId, `🔧 ${event.name}...`);
      break;
    case "tool_end":
      await bot.api.sendMessage(chatId, `✅ Done`);
      break;
    case "error":
      await bot.api.sendMessage(chatId, `❌ ${event.error}`);
      break;
  }
};

// Send message (works with Claude, Codex, or OpenCode!)
const response = await agent.sendMessage(
  "Fix the bug in auth.ts",
  "user",
  chatId,
  statusCallback
);

console.log(response.content); // AI's response
console.log(response.metadata?.usage); // Token usage
```

## 📊 Feature Support Matrix

| Feature | Claude Code | Codex CLI | OpenCode |
|---------|-------------|-----------|----------|
| Streaming | ✅ | ✅ | ✅ |
| Thinking tokens | ✅ | ❌ | ✅ |
| MCP servers | ✅ | ⚠️ Different | ⚠️ Different |
| Session persistence | ✅ | ✅ | ✅ |
| Multi-model | ❌ | ❌ | ✅ |
| Local models | ❌ | ❌ | ✅ |

## 🔍 Code Changes Required

### Minimal Changes

Files you **DON'T** need to change:
- ✅ `src/handlers/*` - All handlers stay the same
- ✅ `src/formatting.ts` - Formatting unchanged
- ✅ `src/security.ts` - Security unchanged
- ✅ Bot commands - All work the same

Files you **DO** need to change:
- `src/index.ts` - Add `registerAdapters()`
- `src/project-session.ts` - Use `createAgent()` instead of `new ClaudeSession()`
- `.env` - Add `AI_AGENT_TYPE`

**Estimated migration time: 30 minutes** ⏱️

## 🧪 Testing the Switch

Test each CLI without code changes:

```bash
# Test with Claude Code
AI_AGENT_TYPE=claude-code bun run src/index.ts

# Test with Codex CLI (after SDK install)
AI_AGENT_TYPE=codex-cli bun run src/index.ts

# Test with OpenCode (after SDK install)
AI_AGENT_TYPE=opencode bun run src/index.ts
```

## 🆘 Common Issues

### "Agent type not registered"

**Solution**: Add to `src/index.ts`:
```typescript
import { registerAdapters } from "./adapters";
registerAdapters(); // Before creating any agents!
```

### "Cannot find module @openai/codex-sdk"

**Solution**: Install the SDK:
```bash
bun add @openai/codex-sdk
```

### Events not showing in Telegram

**Solution**: Check your `statusCallback` implementation:
```typescript
const statusCallback = async (event: StreamEvent) => {
  // Make sure you handle all event types!
  console.log("Event:", event);
};
```

## 🎁 Bonus: Add Your Own AI CLI

Want to use a different AI? Just create an adapter:

```typescript
// src/adapters/my-cli-adapter.ts
import type { AIAgentInterface, AgentConfig } from "../ai-agent-interface";

export class MyCLIAdapter implements AIAgentInterface {
  async sendMessage(message, role, chatId, callback) {
    // Your CLI integration here
    return {
      role: "assistant",
      content: "Response from my CLI",
      timestamp: new Date(),
    };
  }
  // Implement other methods...
}

// Register it
AgentRegistry.register("my-cli", async (config) => new MyCLIAdapter(config));
```

Then use it:
```bash
AI_AGENT_TYPE=my-cli
```

## 📚 Full Documentation

- **Architecture**: See `ADAPTER_MIGRATION_GUIDE.md`
- **API Reference**: See `src/ai-agent-interface.ts`
- **Examples**: See `src/adapters/*.ts`

## ✨ Summary

1. **One interface** - Works with all AI CLIs
2. **Zero bot changes** - Handlers stay the same
3. **Easy switching** - Change one env variable
4. **Future-proof** - Add new CLIs easily

**You're now free to use any AI coding CLI with your Telegram bot!** 🎉
