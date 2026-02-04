/**
 * TestBot - Helper class for testing grammy bot without real Telegram API
 *
 * Uses bot.handleUpdate() to inject fake messages and API transformers
 * to intercept/mock outgoing API calls.
 */

import { Bot, Context } from "grammy";
import type { Update, Message, User, Chat } from "grammy/types";

export interface RecordedApiCall {
  method: string;
  payload: unknown;
  timestamp: number;
}

export interface TestUser {
  id: number;
  username?: string;
  firstName: string;
  lastName?: string;
}

export class TestBot {
  private bot: Bot;
  private updateId = 0;
  private messageId = 0;
  private recordedCalls: RecordedApiCall[] = [];

  constructor(bot: Bot) {
    this.bot = bot;
    this.installTransformer();
  }

  /**
   * Install API transformer to intercept all outgoing Telegram API calls
   */
  private installTransformer(): void {
    this.bot.api.config.use((prev, method, payload, signal) => {
      this.recordedCalls.push({
        method,
        payload,
        timestamp: Date.now()
      });

      // Return mock responses based on method
      return this.createMockResponse(method, payload);
    });
  }

  /**
   * Create appropriate mock response for each API method
   */
  private createMockResponse(method: string, payload: unknown): any {
    const p = payload as Record<string, any>;

    switch (method) {
      case "sendMessage":
        return {
          ok: true,
          result: {
            message_id: ++this.messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: p.chat_id, type: "private" },
            from: { id: 0, is_bot: true, first_name: "TestBot" },
            text: p.text
          }
        };

      case "editMessageText":
        return {
          ok: true,
          result: {
            message_id: p.message_id || this.messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: p.chat_id, type: "private" },
            text: p.text
          }
        };

      case "deleteMessage":
        return { ok: true, result: true };

      case "sendChatAction":
        return { ok: true, result: true };

      case "answerCallbackQuery":
        return { ok: true, result: true };

      case "getMe":
        return {
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: "TestBot",
            username: "test_bot"
          }
        };

      default:
        return { ok: true, result: true };
    }
  }

  /**
   * Create a Telegram User object
   */
  private createTelegramUser(user: TestUser): User {
    return {
      id: user.id,
      is_bot: false,
      first_name: user.firstName,
      last_name: user.lastName,
      username: user.username
    };
  }

  /**
   * Create a Telegram Chat object
   */
  private createChat(chatId: number): Chat.PrivateChat {
    return {
      id: chatId,
      type: "private",
      first_name: "Test"
    };
  }

  /**
   * Send a text message from a user
   */
  async sendMessage(chatId: number, user: TestUser, text: string): Promise<void> {
    const update: Update = {
      update_id: ++this.updateId,
      message: {
        message_id: ++this.messageId,
        date: Math.floor(Date.now() / 1000),
        chat: this.createChat(chatId),
        from: this.createTelegramUser(user),
        text
      } as Message.TextMessage
    };

    await this.bot.handleUpdate(update);
  }

  /**
   * Send a command (e.g., /start, /project name)
   * Includes proper command entity so grammy recognizes it as a command
   */
  async sendCommand(chatId: number, user: TestUser, command: string, args?: string): Promise<void> {
    const text = args ? `/${command} ${args}` : `/${command}`;

    const update: Update = {
      update_id: ++this.updateId,
      message: {
        message_id: ++this.messageId,
        date: Math.floor(Date.now() / 1000),
        chat: this.createChat(chatId),
        from: this.createTelegramUser(user),
        text,
        // Include command entity so grammy recognizes this as a command
        entities: [
          {
            type: "bot_command",
            offset: 0,
            length: command.length + 1, // +1 for the leading /
          },
        ],
      } as Message.TextMessage,
    };

    await this.bot.handleUpdate(update);
  }

  /**
   * Send a callback query (inline button click)
   */
  async clickButton(chatId: number, user: TestUser, callbackData: string): Promise<void> {
    const update: Update = {
      update_id: ++this.updateId,
      callback_query: {
        id: String(Date.now()),
        from: this.createTelegramUser(user),
        chat_instance: String(chatId),
        data: callbackData,
        message: {
          message_id: this.messageId,
          date: Math.floor(Date.now() / 1000),
          chat: this.createChat(chatId),
          from: { id: 0, is_bot: true, first_name: "Bot" },
          text: "Button message"
        } as Message.TextMessage
      }
    };

    await this.bot.handleUpdate(update);
  }

  /**
   * Send a voice message (simulated)
   */
  async sendVoice(chatId: number, user: TestUser, duration: number = 5): Promise<void> {
    const update: Update = {
      update_id: ++this.updateId,
      message: {
        message_id: ++this.messageId,
        date: Math.floor(Date.now() / 1000),
        chat: this.createChat(chatId),
        from: this.createTelegramUser(user),
        voice: {
          file_id: "test-voice-file-id",
          file_unique_id: "test-unique-id",
          duration
        }
      } as Message.VoiceMessage
    };

    await this.bot.handleUpdate(update);
  }

  // ============== Query Methods ==============

  /**
   * Get all recorded API calls
   */
  getCalls(): RecordedApiCall[] {
    return [...this.recordedCalls];
  }

  /**
   * Get calls filtered by method name
   */
  getCallsByMethod(method: string): RecordedApiCall[] {
    return this.recordedCalls.filter(c => c.method === method);
  }

  /**
   * Get the last call of a specific method
   */
  getLastCallByMethod(method: string): RecordedApiCall | undefined {
    return this.getCallsByMethod(method).pop();
  }

  /**
   * Get the last sendMessage call
   */
  getLastReply(): RecordedApiCall | undefined {
    return this.getLastCallByMethod("sendMessage");
  }

  /**
   * Get text content of last reply
   */
  getLastReplyText(): string | undefined {
    const lastReply = this.getLastReply();
    return lastReply ? (lastReply.payload as any)?.text : undefined;
  }

  /**
   * Get all reply texts
   */
  getAllReplyTexts(): string[] {
    return this.getCallsByMethod("sendMessage")
      .map(c => (c.payload as any)?.text)
      .filter(Boolean);
  }

  /**
   * Check if a specific text was sent
   */
  hasReplyContaining(substring: string): boolean {
    return this.getAllReplyTexts().some(text => text.includes(substring));
  }

  // ============== State Management ==============

  /**
   * Clear all recorded calls
   */
  clearCalls(): void {
    this.recordedCalls = [];
  }

  /**
   * Reset all state (calls, IDs)
   */
  reset(): void {
    this.recordedCalls = [];
    this.updateId = 0;
    this.messageId = 0;
  }

  /**
   * Get current message ID counter
   */
  getCurrentMessageId(): number {
    return this.messageId;
  }

  /**
   * Get number of recorded calls
   */
  getCallCount(): number {
    return this.recordedCalls.length;
  }
}
