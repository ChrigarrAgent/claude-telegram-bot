# AI Agent Adapter Migration Guide

This guide explains how to migrate the existing Telegram bot to use the new adapter architecture, which allows switching between Claude Code, Codex CLI, and OpenCode.

## Architecture Overview

```
┌─────────────────────────────────────┐
│     Telegram Bot (handlers)          │
│  - Receives messages                 │
│  - Formats responses                 │
│  - Manages UI/UX                     │
└──────────────┬──────────────────────┘
               │
               ↓
┌─────────────────────────────────────┐
│   AIAgentInterface (abstract)        │
│  - sendMessage()                     │
│  - streamResponse()                  │
│  - stopQuery()                       │
│  - getSession()                      │
└──────────────┬──────────────────────┘
               │
       ┌───────┴────────┬─────────────┐
       ↓                ↓              ↓
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ ClaudeCode   │ │ CodexCLI     │ │ OpenCode     │
│ Adapter      │ │ Adapter      │ │ Adapter      │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       ↓                ↓              ↓
   Claude SDK      Codex SDK      OpenCode SDK
```

## Benefits

1. **Flexibility**: Switch between different AI CLIs without changing bot code
2. **Testability**: Mock the interface for testing
3. **Maintainability**: Updates to one CLI don't affect others
4. **Future-proof**: Easy to add new AI agents

## Migration Steps

### Step 1: Install the Adapter System

The adapter files are already created:
- `src/ai-agent-interface.ts` - Core interface definition
- `src/adapters/claude-code-adapter.ts` - Claude Code implementation (complete)
- `src/adapters/codex-adapter.ts` - Codex CLI implementation (template)
- `src/adapters/opencode-adapter.ts` - OpenCode implementation (template)
- `src/adapters/index.ts` - Registry and factory

### Step 2: Update `src/project-session.ts`

Replace the current `ClaudeSession` usage with the adapter interface:

```typescript
// OLD:
import { ClaudeSession } from "./session";

export class ProjectSession {
  private session: ClaudeSession;

  constructor(workingDir: string, projectName: string) {
    this.session = new ClaudeSession();
  }
}

// NEW:
import { createAgent, registerAdapters, type AIAgentInterface } from "./adapters";

// Register adapters once at startup
registerAdapters();

export class ProjectSession {
  private agent: AIAgentInterface;

  async initialize(workingDir: string, projectName: string) {
    this.agent = await createAgent(workingDir, projectName);
  }
}
```

### Step 3: Update Message Sending

Replace direct SDK calls with adapter interface:

```typescript
// OLD:
async sendMessage(message: string, role: "user" | "system") {
  const result = await this.session.sendMessage(
    message,
    role,
    chatId,
    statusCallback
  );
  return result;
}

// NEW:
async sendMessage(message: string, role: "user" | "system") {
  const result = await this.agent.sendMessage(
    message,
    role,
    chatId,
    statusCallback
  );
  return result;
}
```

The beauty is that the API is almost identical! Only the import changes.

### Step 4: Update Session Management

```typescript
// OLD:
const isActive = this.session.isActive;
const isProcessing = this.session.isProcessing;

// NEW:
const isActive = this.agent.isActive();
const isProcessing = this.agent.isProcessing();
```

### Step 5: Update Configuration

Add to `.env`:

```bash
# Choose your AI agent
AI_AGENT_TYPE=claude-code  # or codex-cli, opencode

# Optional: Override default model
# AI_MODEL=claude-sonnet-4-20250514
```

### Step 6: Initialize at Startup

In `src/index.ts`, register adapters before creating sessions:

```typescript
import { registerAdapters } from "./adapters";

// Register all adapters at startup
registerAdapters();

// Rest of bot initialization...
```

## Switching Between Adapters

### Use Claude Code (Default)

```bash
AI_AGENT_TYPE=claude-code
ANTHROPIC_API_KEY=sk-ant-...  # Or use CLI auth
```

### Use Codex CLI

1. Install the SDK:
   ```bash
   bun add @openai/codex-sdk
   ```

2. Complete the adapter in `src/adapters/codex-adapter.ts` (uncomment template code)

3. Configure:
   ```bash
   AI_AGENT_TYPE=codex-cli
   OPENAI_API_KEY=sk-...  # Or use ChatGPT auth
   AI_MODEL=gpt-5.3-codex
   ```

### Use OpenCode

1. Install the SDK:
   ```bash
   bun add @opencode-ai/sdk
   ```

2. Complete the adapter in `src/adapters/opencode-adapter.ts` (uncomment template code)

3. Configure:
   ```bash
   AI_AGENT_TYPE=opencode
   ANTHROPIC_API_KEY=sk-ant-...  # Or other provider
   AI_MODEL=claude-sonnet-4-20250514
   ```

## Implementing a New Adapter

To add support for a new AI CLI:

1. Create `src/adapters/your-cli-adapter.ts`:

```typescript
import type { AIAgentInterface, AgentConfig, ... } from "../ai-agent-interface";

export class YourCLIAdapter implements AIAgentInterface {
  constructor(config: AgentConfig) {
    // Initialize your CLI
  }

  async sendMessage(message, role, chatId, callback, signal) {
    // Convert unified message to your CLI format
    // Call your CLI
    // Convert response back to unified format
    return unifiedMessage;
  }

  // Implement other required methods...
}
```

2. Register it in `src/adapters/index.ts`:

```typescript
import { YourCLIAdapter } from "./your-cli-adapter";

export function registerAdapters() {
  // ... existing adapters ...

  AgentRegistry.register("your-cli", async (config) => {
    return new YourCLIAdapter(config);
  });
}
```

3. Add configuration:

```bash
AI_AGENT_TYPE=your-cli
```

## Testing

Test the abstraction with a mock adapter:

```typescript
import type { AIAgentInterface } from "./ai-agent-interface";

class MockAdapter implements AIAgentInterface {
  async sendMessage(message) {
    return {
      role: "assistant",
      content: "Mock response",
      timestamp: new Date(),
    };
  }
  // ... other methods ...
}

// In tests:
AgentRegistry.register("mock", async () => new MockAdapter());
process.env.AI_AGENT_TYPE = "mock";
```

## Compatibility Notes

### Claude Code Adapter
- ✅ Fully implemented
- ✅ Session persistence
- ✅ MCP servers
- ✅ Thinking tokens
- ✅ Streaming

### Codex CLI Adapter
- ⚠️ Template provided
- 📝 Requires SDK installation
- 📝 Event conversion needs implementation
- 📝 Test with real Codex API

### OpenCode Adapter
- ⚠️ Template provided
- 📝 Requires SDK installation
- 📝 Multi-provider config needed
- 📝 Workspace features not yet mapped

## Troubleshooting

### "Agent type not registered"
- Check `AI_AGENT_TYPE` in `.env`
- Ensure `registerAdapters()` is called before creating agents

### "SDK not installed"
- Install required SDK: `bun add @openai/codex-sdk` or `bun add @opencode-ai/sdk`
- Uncomment adapter template code

### Streaming events not working
- Verify event conversion in adapter's `handleSDKMessage()` method
- Check that `StatusCallback` is being called correctly

### Session not persisting
- Implement `loadSession()` and `saveSession()` in adapter
- Check working directory permissions

## Performance Considerations

- **Adapter overhead**: Minimal (~1-2ms per message)
- **Memory**: Each adapter keeps its own session state
- **Concurrent sessions**: Registry supports multiple concurrent agents

## Next Steps

1. ✅ Adapter architecture created
2. ⬜ Complete Codex adapter (requires SDK)
3. ⬜ Complete OpenCode adapter (requires SDK)
4. ⬜ Add adapter selection UI in Telegram (/set-agent command)
5. ⬜ Add adapter health checks
6. ⬜ Add adapter performance metrics

## Questions?

Join the discussion in the project's GitHub issues or Discord community.
