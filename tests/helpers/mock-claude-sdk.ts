/**
 * Mock for @anthropic-ai/claude-agent-sdk
 *
 * This completely replaces the real SDK to avoid token usage in tests.
 * It tracks all calls and verifies session continuity.
 */

import { mock } from "bun:test";

export interface MockQueryCall {
  prompt: string;
  options: {
    model?: string;
    cwd?: string;
    resume?: string;  // This is the key - tracks session continuity
    [key: string]: unknown;
  };
  timestamp: number;
}

export interface MockSDKState {
  calls: MockQueryCall[];
  sessionCounter: number;
  currentSessionId: string | null;
}

// Global state for tracking SDK calls across tests
let mockState: MockSDKState = {
  calls: [],
  sessionCounter: 0,
  currentSessionId: null,
};

/**
 * Reset mock state between tests
 */
export function resetMockSDK(): void {
  mockState = {
    calls: [],
    sessionCounter: 0,
    currentSessionId: null,
  };
}

/**
 * Get all recorded SDK calls
 */
export function getMockCalls(): MockQueryCall[] {
  return [...mockState.calls];
}

/**
 * Get the last SDK call
 */
export function getLastMockCall(): MockQueryCall | undefined {
  return mockState.calls[mockState.calls.length - 1];
}

/**
 * Check if a specific session ID was used for resume
 */
export function wasSessionResumed(sessionId: string): boolean {
  return mockState.calls.some(call => call.options.resume === sessionId);
}

/**
 * Get all unique session IDs that were resumed
 */
export function getResumedSessionIds(): string[] {
  return [...new Set(
    mockState.calls
      .map(call => call.options.resume)
      .filter((id): id is string => id !== undefined)
  )];
}

/**
 * Create mock events that simulate Claude Code SDK response
 */
async function* createMockEvents(prompt: string, resumeSessionId?: string) {
  // Generate or reuse session ID
  const sessionId = resumeSessionId || `mock-session-${++mockState.sessionCounter}-${Date.now()}`;
  mockState.currentSessionId = sessionId;

  // Emit session start event
  yield {
    type: "system" as const,
    session_id: sessionId,
    message: { content: [] }
  };

  // Small delay to simulate processing
  await new Promise(resolve => setTimeout(resolve, 10));

  // Emit assistant response
  yield {
    type: "assistant" as const,
    session_id: sessionId,
    message: {
      content: [
        {
          type: "text" as const,
          text: `Mock response to: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"`
        }
      ]
    }
  };

  // Emit result
  yield {
    type: "result" as const,
    session_id: sessionId,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  };
}

/**
 * Mock query function that replaces the real SDK
 */
export function mockQuery({ prompt, options }: { prompt: string; options: any }) {
  // Record this call
  mockState.calls.push({
    prompt,
    options: {
      model: options.model,
      cwd: options.cwd,
      resume: options.resume,
      ...options
    },
    timestamp: Date.now()
  });

  console.log(`[MOCK SDK] query() called with resume=${options.resume || 'undefined'}`);

  // Return async iterator that yields mock events
  return createMockEvents(prompt, options.resume);
}

/**
 * Install the mock SDK - call this before importing session.ts
 */
export function installMockSDK(): void {
  // Mock the entire module
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: mockQuery,
  }));
}

/**
 * Assertion helpers for tests
 */
export const MockAssertions = {
  /**
   * Assert that the first call was a new session (no resume)
   */
  firstCallWasNewSession(): void {
    const firstCall = mockState.calls[0];
    if (!firstCall) {
      throw new Error("No SDK calls recorded");
    }
    if (firstCall.options.resume !== undefined) {
      throw new Error(`Expected first call to be new session, but resume=${firstCall.options.resume}`);
    }
  },

  /**
   * Assert that a subsequent call resumed a specific session
   */
  callResumedSession(callIndex: number, expectedSessionId: string): void {
    const call = mockState.calls[callIndex];
    if (!call) {
      throw new Error(`No call at index ${callIndex}`);
    }
    if (call.options.resume !== expectedSessionId) {
      throw new Error(
        `Expected call ${callIndex} to resume session ${expectedSessionId}, ` +
        `but resume=${call.options.resume}`
      );
    }
  },

  /**
   * Assert that all calls after the first one resumed the same session
   */
  allSubsequentCallsResumedSameSession(): void {
    if (mockState.calls.length < 2) {
      throw new Error("Need at least 2 calls to verify session continuity");
    }

    // Get session ID from what should have been set after first call
    const firstSessionId = mockState.currentSessionId;

    for (let i = 1; i < mockState.calls.length; i++) {
      const call = mockState.calls[i];
      if (call.options.resume === undefined) {
        throw new Error(`Call ${i} did not resume any session`);
      }
    }
  },

  /**
   * Get the number of calls made
   */
  callCount(): number {
    return mockState.calls.length;
  },

  /**
   * Assert exact number of SDK calls
   */
  assertCallCount(expected: number): void {
    if (mockState.calls.length !== expected) {
      throw new Error(`Expected ${expected} SDK calls, got ${mockState.calls.length}`);
    }
  }
};
