/**
 * AI Agent Adapters - Export and register all available adapters
 */

import {
  AgentRegistry,
  AgentType,
  type AgentConfig,
  type AIAgentInterface,
} from "../ai-agent-interface";
import { ClaudeCodeAdapter } from "./claude-code-adapter";
import { CodexAdapter } from "./codex-adapter";
import { OpenCodeAdapter } from "./opencode-adapter";

/**
 * Register all available adapters
 */
export function registerAdapters(): void {
  // Claude Code adapter (always available)
  AgentRegistry.register(AgentType.CLAUDE_CODE, async (config: AgentConfig) => {
    return new ClaudeCodeAdapter(config);
  });

  // Codex adapter (requires @openai/codex-sdk)
  AgentRegistry.register(AgentType.CODEX_CLI, async (config: AgentConfig) => {
    return new CodexAdapter(config);
  });

  // OpenCode adapter (requires @opencode-ai/sdk)
  AgentRegistry.register(AgentType.OPENCODE, async (config: AgentConfig) => {
    return new OpenCodeAdapter(config);
  });
}

/**
 * Create an AI agent instance based on environment configuration
 */
export async function createAgent(
  workingDir: string,
  projectName?: string
): Promise<AIAgentInterface> {
  // Get agent type from environment (defaults to Claude Code)
  const agentType = (process.env.AI_AGENT_TYPE as AgentType) || AgentType.CLAUDE_CODE;

  // Build config
  const config: AgentConfig = {
    workingDir,
    allowedPaths: process.env.ALLOWED_PATHS?.split(",") || [workingDir],
    systemPrompt: process.env.SYSTEM_PROMPT,
    model: process.env.AI_MODEL,
    maxThinkingTokens: process.env.MAX_THINKING_TOKENS
      ? parseInt(process.env.MAX_THINKING_TOKENS)
      : 10000,
    timeout: process.env.QUERY_TIMEOUT_MS
      ? parseInt(process.env.QUERY_TIMEOUT_MS)
      : 120000,
  };

  // Load MCP servers if configured
  try {
    const mcpConfig = await import("../../mcp-config.local");
    config.mcpServers = mcpConfig.default || mcpConfig.mcpServers;
  } catch {
    // No MCP config found, that's okay
  }

  // Create agent using registry
  return AgentRegistry.create(agentType, config);
}

// Export adapters
export { ClaudeCodeAdapter } from "./claude-code-adapter";
export { CodexAdapter } from "./codex-adapter";
export { OpenCodeAdapter } from "./opencode-adapter";

// Export types and registry
export { AgentRegistry, AgentType } from "../ai-agent-interface";
export type { AIAgentInterface, AgentConfig } from "../ai-agent-interface";
