/**
 * OpenCode Adapter - Implements AIAgentInterface for OpenCode CLI
 *
 * This adapter wraps OpenCode's SDK to conform to
 * the universal AIAgentInterface.
 */

// NOTE: This is a template implementation. Install @opencode-ai/sdk first:
// bun add @opencode-ai/sdk

import type {
  AIAgentInterface,
  AgentConfig,
  SessionInfo,
  StatusCallback,
  StreamEvent,
  TokenUsage,
  UnifiedMessage,
} from "../ai-agent-interface";

/**
 * Uncomment when @opencode-ai/sdk is installed:
 * import { OpenCode } from "@opencode-ai/sdk";
 * import type { Session, Message } from "@opencode-ai/sdk";
 */

export class OpenCodeAdapter implements AIAgentInterface {
  private sessionId: string | null = null;
  private conversationTitle: string | null = null;
  private lastActivity: Date | null = null;
  private messageCount = 0;
  private isQueryRunning = false;
  private config: AgentConfig;
  private conversationHistory: UnifiedMessage[] = [];
  private openCodeClient: any; // Replace with proper type when SDK is installed
  private currentSession: any; // Replace with Session type

  constructor(config: AgentConfig) {
    this.config = config;
    this.initializeOpenCode();
  }

  /**
   * Initialize OpenCode client
   */
  private async initializeOpenCode(): Promise<void> {
    // Uncomment when SDK is installed:
    // this.openCodeClient = new OpenCode({
    //   // OpenCode supports multiple providers
    //   provider: "anthropic", // or "openai", "google", "local"
    //   apiKey: process.env.ANTHROPIC_API_KEY,
    //   model: this.config.model || "claude-sonnet-4-20250514",
    // });

    throw new Error("OpenCodeAdapter requires @opencode-ai/sdk to be installed");
  }

  async sendMessage(
    message: string,
    role: "user" | "system",
    chatId: number,
    statusCallback: StatusCallback,
    signal?: AbortSignal
  ): Promise<UnifiedMessage> {
    this.isQueryRunning = true;

    try {
      // Create or reuse session
      if (!this.currentSession) {
        // Uncomment when SDK is installed:
        // this.currentSession = await this.openCodeClient.session.create({
        //   workingDirectory: this.config.workingDir,
        //   model: this.config.model,
        //   systemPrompt: this.config.systemPrompt,
        // });
        // this.sessionId = this.currentSession.id;
      }

      const responseText: string[] = [];
      let usage: TokenUsage | undefined;

      // Uncomment when SDK is installed:
      // OpenCode uses a different streaming approach
      // const stream = await this.currentSession.sendMessage(message, {
      //   stream: true,
      //   signal,
      // });
      //
      // for await (const chunk of stream) {
      //   const unifiedEvent = this.convertOpenCodeEvent(chunk);
      //   if (unifiedEvent) {
      //     await statusCallback(unifiedEvent);
      //
      //     // Collect text for final response
      //     if (unifiedEvent.type === "text") {
      //       responseText.push(unifiedEvent.text);
      //     }
      //     if (unifiedEvent.type === "usage") {
      //       usage = unifiedEvent.usage;
      //     }
      //   }
      // }

      const unifiedMessage: UnifiedMessage = {
        role: "assistant",
        content: responseText.join(""),
        timestamp: new Date(),
        metadata: { usage },
      };

      // Update session info
      this.messageCount++;
      this.lastActivity = new Date();
      this.conversationHistory.push(unifiedMessage);

      await statusCallback({ type: "done" });

      return unifiedMessage;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await statusCallback({ type: "error", error: errorMessage });
      throw error;
    } finally {
      this.isQueryRunning = false;
    }
  }

  async stop(): Promise<void> {
    // Uncomment when SDK is installed:
    // if (this.currentSession) {
    //   await this.currentSession.cancel();
    // }
    this.isQueryRunning = false;
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
    this.sessionId = `opencode-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.conversationTitle = null;
    this.lastActivity = null;
    this.messageCount = 0;
    this.conversationHistory = [];
    this.currentSession = null; // Will be recreated on next message
  }

  getHistory(): UnifiedMessage[] {
    return [...this.conversationHistory];
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.conversationHistory = [];
    // Uncomment when SDK is installed:
    // if (this.currentSession) {
    //   await this.currentSession.close();
    // }
    this.currentSession = null;
  }

  // ========== Private Helper Methods ==========

  /**
   * Convert OpenCode streaming events to unified format
   */
  private convertOpenCodeEvent(event: any): StreamEvent | null {
    // This is a template - actual OpenCode events will have different structure
    // Uncomment and modify based on actual OpenCode SDK event types:

    // switch (event.type) {
    //   case "content_delta":
    //     return { type: "text", text: event.delta.text };
    //
    //   case "tool_start":
    //     return {
    //       type: "tool_start",
    //       name: event.tool_name,
    //       input: event.tool_input,
    //     };
    //
    //   case "tool_complete":
    //     return {
    //       type: "tool_end",
    //       name: event.tool_name,
    //       output: event.result,
    //       error: event.error,
    //     };
    //
    //   case "token_usage":
    //     return {
    //       type: "usage",
    //       usage: {
    //         inputTokens: event.prompt_tokens,
    //         outputTokens: event.completion_tokens,
    //         totalTokens: event.total_tokens,
    //       },
    //     };
    //
    //   default:
    //     return null;
    // }

    return null;
  }

  /**
   * Extract project name from working directory
   */
  private extractProjectName(workingDir: string): string {
    return workingDir.split("/").pop() || "default";
  }
}
