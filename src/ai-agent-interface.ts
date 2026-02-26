/**
 * AI Agent Interface - Universal abstraction for different AI coding CLIs
 *
 * This interface allows the Telegram bot to work with Claude Code, Codex CLI,
 * or OpenCode interchangeably without changing the bot logic.
 */

/**
 * Unified message type that all adapters must convert to/from
 */
export interface UnifiedMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  metadata?: {
    thinking?: string;
    toolCalls?: ToolCall[];
    usage?: TokenUsage;
  };
}

/**
 * Tool call representation
 */
export interface ToolCall {
  name: string;
  input: unknown;
  status: "running" | "success" | "error";
  output?: string;
  error?: string;
}

/**
 * Token usage tracking
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Session information
 */
export interface SessionInfo {
  sessionId: string;
  conversationTitle: string | null;
  lastActivity: Date | null;
  messageCount: number;
  workingDir: string;
  projectName: string;
}

/**
 * Streaming event types that all adapters must emit
 */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; name: string; input: unknown }
  | { type: "tool_end"; name: string; output?: string; error?: string }
  | { type: "error"; error: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done" };

/**
 * Status callback for streaming updates
 */
export type StatusCallback = (event: StreamEvent) => void | Promise<void>;

/**
 * Configuration for AI agent
 */
export interface AgentConfig {
  workingDir: string;
  allowedPaths?: string[];
  systemPrompt?: string;
  mcpServers?: MCPServerConfig[];
  model?: string;
  maxThinkingTokens?: number;
  timeout?: number;
}

/**
 * MCP Server configuration
 */
export interface MCPServerConfig {
  name: string;
  type: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/**
 * Universal AI Agent Interface
 *
 * All CLI adapters (Claude Code, Codex, OpenCode) must implement this interface
 */
export interface AIAgentInterface {
  /**
   * Send a message and get streaming response
   */
  sendMessage(
    message: string,
    role: "user" | "system",
    chatId: number,
    statusCallback: StatusCallback,
    signal?: AbortSignal
  ): Promise<UnifiedMessage>;

  /**
   * Stop the current query
   */
  stop(): Promise<void>;

  /**
   * Get current session information
   */
  getSessionInfo(): SessionInfo;

  /**
   * Check if agent is currently processing
   */
  isProcessing(): boolean;

  /**
   * Check if agent is active
   */
  isActive(): boolean;

  /**
   * Create a new session
   */
  newSession(): Promise<void>;

  /**
   * Load session from disk (if supported)
   */
  loadSession?(sessionId: string): Promise<boolean>;

  /**
   * Save session to disk (if supported)
   */
  saveSession?(): Promise<void>;

  /**
   * Get conversation history
   */
  getHistory?(): UnifiedMessage[];

  /**
   * Clean up resources
   */
  dispose(): Promise<void>;
}

/**
 * Factory function type for creating AI agents
 */
export type AgentFactory = (config: AgentConfig) => Promise<AIAgentInterface>;

/**
 * Supported AI agent types
 */
export enum AgentType {
  CLAUDE_CODE = "claude-code",
  CODEX_CLI = "codex-cli",
  OPENCODE = "opencode",
}

/**
 * Agent registry for managing different implementations
 */
export class AgentRegistry {
  private static factories = new Map<AgentType, AgentFactory>();

  /**
   * Register an agent factory
   */
  static register(type: AgentType, factory: AgentFactory): void {
    this.factories.set(type, factory);
  }

  /**
   * Create an agent instance
   */
  static async create(
    type: AgentType,
    config: AgentConfig
  ): Promise<AIAgentInterface> {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new Error(`Agent type "${type}" not registered`);
    }
    return factory(config);
  }

  /**
   * Get all registered agent types
   */
  static getAvailableTypes(): AgentType[] {
    return Array.from(this.factories.keys());
  }
}
