/**
 * Claude Code Adapter - Implements AIAgentInterface for Claude Code CLI
 *
 * This adapter wraps the @anthropic-ai/claude-agent-sdk to conform to
 * the universal AIAgentInterface.
 */

import {
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AIAgentInterface,
  AgentConfig,
  SessionInfo,
  StatusCallback,
  StreamEvent,
  ToolCall,
  TokenUsage,
  UnifiedMessage,
} from "../ai-agent-interface";

export class ClaudeCodeAdapter implements AIAgentInterface {
  private sessionId: string | null = null;
  private conversationTitle: string | null = null;
  private lastActivity: Date | null = null;
  private messageCount = 0;
  private isQueryRunning = false;
  private abortController: AbortController | null = null;
  private config: AgentConfig;
  private conversationHistory: UnifiedMessage[] = [];

  constructor(config: AgentConfig) {
    this.config = config;
    this.sessionId = `claude-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async sendMessage(
    message: string,
    role: "user" | "system",
    chatId: number,
    statusCallback: StatusCallback,
    signal?: AbortSignal
  ): Promise<UnifiedMessage> {
    this.isQueryRunning = true;
    this.abortController = new AbortController();

    // Link external signal to our abort controller
    if (signal) {
      signal.addEventListener("abort", () => this.abortController?.abort());
    }

    try {
      const options: Options = {
        cwd: this.config.workingDir,
        allowedPaths: this.config.allowedPaths || [this.config.workingDir],
        systemPrompt: this.config.systemPrompt,
        mcpServers: this.convertMCPServers(this.config.mcpServers || []),
        maxThinkingTokens: this.config.maxThinkingTokens,
        sessionId: this.sessionId || undefined,
        onMessage: (msg: SDKMessage) => this.handleSDKMessage(msg, statusCallback),
      };

      // Execute query
      const result = await query(message, options, this.abortController.signal);

      // Extract final response
      const responseText = this.extractTextFromSDKMessage(result);
      const usage = this.extractUsageFromSDKMessage(result);

      const unifiedMessage: UnifiedMessage = {
        role: "assistant",
        content: responseText,
        timestamp: new Date(),
        metadata: {
          usage,
        },
      };

      // Update session info
      this.messageCount++;
      this.lastActivity = new Date();
      this.conversationHistory.push(unifiedMessage);

      // Emit done event
      await statusCallback({ type: "done" });

      return unifiedMessage;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await statusCallback({ type: "error", error: errorMessage });
      throw error;
    } finally {
      this.isQueryRunning = false;
      this.abortController = null;
    }
  }

  async stop(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  getSessionInfo(): SessionInfo {
    return {
      sessionId: this.sessionId || "unknown",
      conversationTitle: this.conversationTitle,
      lastActivity: this.lastActivity,
      messageCount: this.messageCount,
      workingDir: this.config.workingDir,
      projectName: this.extractProjectName(this.config.workingDir),
    };
  }

  isProcessing(): boolean {
    return this.isQueryRunning;
  }

  isActive(): boolean {
    return this.sessionId !== null && this.messageCount > 0;
  }

  async newSession(): Promise<void> {
    this.sessionId = `claude-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.conversationTitle = null;
    this.lastActivity = null;
    this.messageCount = 0;
    this.conversationHistory = [];
  }

  getHistory(): UnifiedMessage[] {
    return [...this.conversationHistory];
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.conversationHistory = [];
  }

  // ========== Private Helper Methods ==========

  /**
   * Handle streaming messages from Claude SDK and convert to unified events
   */
  private async handleSDKMessage(
    msg: SDKMessage,
    callback: StatusCallback
  ): Promise<void> {
    switch (msg.type) {
      case "assistant":
        // Extract text content
        for (const block of msg.message.content) {
          if (block.type === "text") {
            await callback({ type: "text", text: block.text });
          } else if (block.type === "thinking") {
            await callback({ type: "thinking", text: block.thinking });
          } else if (block.type === "tool_use") {
            await callback({
              type: "tool_start",
              name: block.name,
              input: block.input,
            });
          }
        }
        break;

      case "tool_result":
        const hasError = msg.message.content.some(
          (block) => block.type === "tool_result" && block.is_error
        );
        const output = msg.message.content
          .filter((block) => block.type === "tool_result")
          .map((block) => (block.type === "tool_result" ? block.content : ""))
          .join("\n");

        await callback({
          type: "tool_end",
          name: msg.message.tool_use_id || "unknown",
          output: hasError ? undefined : output,
          error: hasError ? output : undefined,
        });
        break;

      case "usage":
        await callback({
          type: "usage",
          usage: {
            inputTokens: msg.inputTokens || 0,
            outputTokens: msg.outputTokens || 0,
            totalTokens: (msg.inputTokens || 0) + (msg.outputTokens || 0),
            cacheReadTokens: msg.cacheReadTokens,
            cacheWriteTokens: msg.cacheWriteTokens,
          },
        });
        break;
    }
  }

  /**
   * Extract text content from SDK message
   */
  private extractTextFromSDKMessage(msg: SDKMessage): string {
    if (msg.type !== "assistant") return "";

    const textParts: string[] = [];
    for (const block of msg.message.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      }
    }
    return textParts.join("");
  }

  /**
   * Extract usage from SDK message
   */
  private extractUsageFromSDKMessage(msg: SDKMessage): TokenUsage | undefined {
    if (msg.type === "usage") {
      return {
        inputTokens: msg.inputTokens || 0,
        outputTokens: msg.outputTokens || 0,
        totalTokens: (msg.inputTokens || 0) + (msg.outputTokens || 0),
        cacheReadTokens: msg.cacheReadTokens,
        cacheWriteTokens: msg.cacheWriteTokens,
      };
    }
    return undefined;
  }

  /**
   * Convert unified MCP config to Claude SDK format
   */
  private convertMCPServers(servers: any[]): any[] {
    // Claude SDK expects the same format, so just pass through
    return servers;
  }

  /**
   * Extract project name from working directory
   */
  private extractProjectName(workingDir: string): string {
    return workingDir.split("/").pop() || "default";
  }
}
