/**
 * Codex CLI Adapter - Implements AIAgentInterface for OpenAI Codex CLI
 *
 * This adapter wraps the @openai/codex-sdk to conform to
 * the universal AIAgentInterface.
 */

// NOTE: This is a template implementation. Install @openai/codex-sdk first:
// bun add @openai/codex-sdk

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
 * Uncomment when @openai/codex-sdk is installed:
 * import Codex from "@openai/codex-sdk";
 * import type { Thread, StreamEvent as CodexStreamEvent } from "@openai/codex-sdk";
 */

export class CodexAdapter implements AIAgentInterface {
  private threadId: string | null = null;
  private conversationTitle: string | null = null;
  private lastActivity: Date | null = null;
  private messageCount = 0;
  private isQueryRunning = false;
  private config: AgentConfig;
  private conversationHistory: UnifiedMessage[] = [];
  private codexClient: any; // Replace with proper type when SDK is installed
  private currentThread: any; // Replace with Thread type

  constructor(config: AgentConfig) {
    this.config = config;
    this.initializeCodex();
  }

  /**
   * Initialize Codex client
   */
  private async initializeCodex(): Promise<void> {
    // Uncomment when SDK is installed:
    // this.codexClient = new Codex({
    //   // Codex uses your ChatGPT auth by default, or you can provide an API key
    //   apiKey: process.env.OPENAI_API_KEY,
    // });

    throw new Error("CodexAdapter requires @openai/codex-sdk to be installed");
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
      // Create or reuse thread
      if (!this.currentThread) {
        // Uncomment when SDK is installed:
        // this.currentThread = await this.codexClient.thread({
        //   cwd: this.config.workingDir,
        //   // Codex has different config options than Claude
        //   model: this.config.model || "gpt-5.3-codex",
        // });
      }

      const responseText: string[] = [];
      let usage: TokenUsage | undefined;

      // Uncomment when SDK is installed:
      // const stream = await this.currentThread.runStreamed(message, {
      //   signal,
      // });
      //
      // for await (const event of stream) {
      //   const unifiedEvent = this.convertCodexEvent(event);
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
    // Codex doesn't have explicit stop method
    // Cancellation is handled via AbortSignal
    this.isQueryRunning = false;
  }

  getSessionInfo(): SessionInfo {
    return {
      sessionId: this.threadId || "unknown",
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
    return this.threadId !== null && this.messageCount > 0;
  }

  async newSession(): Promise<void> {
    this.threadId = `codex-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.conversationTitle = null;
    this.lastActivity = null;
    this.messageCount = 0;
    this.conversationHistory = [];
    this.currentThread = null; // Will be recreated on next message
  }

  getHistory(): UnifiedMessage[] {
    return [...this.conversationHistory];
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.conversationHistory = [];
    this.currentThread = null;
  }

  // ========== Private Helper Methods ==========

  /**
   * Convert Codex streaming events to unified format
   */
  private convertCodexEvent(event: any): StreamEvent | null {
    // This is a template - actual Codex events will have different structure
    // Uncomment and modify based on actual Codex SDK event types:

    // switch (event.type) {
    //   case "text_delta":
    //     return { type: "text", text: event.delta };
    //
    //   case "tool_call_start":
    //     return {
    //       type: "tool_start",
    //       name: event.tool.name,
    //       input: event.tool.input,
    //     };
    //
    //   case "tool_call_end":
    //     return {
    //       type: "tool_end",
    //       name: event.tool.name,
    //       output: event.tool.output,
    //       error: event.tool.error,
    //     };
    //
    //   case "usage":
    //     return {
    //       type: "usage",
    //       usage: {
    //         inputTokens: event.usage.input_tokens,
    //         outputTokens: event.usage.output_tokens,
    //         totalTokens: event.usage.total_tokens,
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
