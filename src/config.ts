/**
 * Configuration for Claude Telegram Bot.
 *
 * All environment variables, paths, constants, and safety settings.
 */

import { homedir } from "os";
import { resolve, dirname } from "path";
import type { McpServerConfig } from "./types";

// ============== Environment Setup ==============

const HOME = homedir();

// Ensure necessary paths are available for Claude's bash commands
// LaunchAgents don't inherit the full shell environment
const EXTRA_PATHS = [
  resolve(dirname(import.meta.dir), "scripts"), // Bot's scripts dir (long-run etc.)
  `${HOME}/.local/bin`,
  `${HOME}/.bun/bin`,
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
];

const currentPath = process.env.PATH || "";
const pathParts = currentPath.split(":");
for (const extraPath of EXTRA_PATHS) {
  if (!pathParts.includes(extraPath)) {
    pathParts.unshift(extraPath);
  }
}
process.env.PATH = pathParts.join(":");

// ============== Core Configuration ==============

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const ALLOWED_USERS: number[] = (
  process.env.TELEGRAM_ALLOWED_USERS || ""
)
  .split(",")
  .filter((x) => x.trim())
  .map((x) => parseInt(x.trim(), 10))
  .filter((x) => !isNaN(x));

// Working directory - mutable for project switching
let _workingDir = process.env.CLAUDE_WORKING_DIR || HOME;
export const getWorkingDir = () => _workingDir;
export const setWorkingDir = (dir: string) => { _workingDir = dir; };
export const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || HOME; // Initial value

/**
 * Resolve project name to full path.
 * Resolution order:
 * 1. Auto-generated alias lookup (from project-aliases.ts)
 * 2. /home/ubuntu/Projects/{name}
 * 3. /home/ubuntu/.openclaw/workspace/{name}
 * 4. Absolute path (if starts with / or ~)
 */
export function resolveProjectPath(projectName: string): string {
  // Dynamic import to avoid circular dependency
  const { getProjectByAlias } = require("./project-aliases");

  // Check auto-generated aliases first
  const aliasPath = getProjectByAlias(projectName);
  if (aliasPath) {
    return aliasPath;
  }

  // Absolute path
  if (projectName.startsWith("/") || projectName.startsWith("~")) {
    return projectName.replace(/^~/, HOME);
  }

  // Try common locations
  const candidates = [
    `${HOME}/Projects/${projectName}`,
    `${HOME}/.openclaw/workspace/${projectName}`,
    `${HOME}/${projectName}`,
  ];

  // Use existsSync to check if directory exists
  try {
    const { existsSync, statSync } = require("fs");
    const found = candidates.find((p) => {
      try {
        return existsSync(p) && statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
    if (found) return found;
  } catch {
    // If fs check fails, fall through to default
  }

  // If project not found, fall back to HOME directory (don't return non-existent path)
  // This handles cases like project name "ubuntu" extracted from "/home/ubuntu"
  return HOME;
}

/**
 * Project header display configuration.
 * - always: Show project header on every message
 * - never: Never show project headers
 * - multiple: Show only when multiple sessions active
 */
export const SHOW_PROJECT_HEADERS: "always" | "never" | "multiple" =
  (process.env.SHOW_PROJECT_HEADERS as any) || "always";

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
export const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

// Transcription provider: prefer Groq (fast & cheap), fallback to OpenAI
export const TRANSCRIPTION_PROVIDER: "groq" | "openai" | "none" =
  GROQ_API_KEY ? "groq" : OPENAI_API_KEY ? "openai" : "none";

// ============== Claude CLI Path ==============

// Auto-detect from PATH, or use environment override
function findClaudeCli(): string {
  const envPath = process.env.CLAUDE_CLI_PATH;
  if (envPath) return envPath;

  // Try to find claude in PATH using Bun.which
  const whichResult = Bun.which("claude");
  if (whichResult) return whichResult;

  // Final fallback
  return "/usr/local/bin/claude";
}

export const CLAUDE_CLI_PATH = findClaudeCli();

// ============== MCP Configuration ==============

// MCP servers loaded from mcp-config.ts
let MCP_SERVERS: Record<string, McpServerConfig> = {};

try {
  // Dynamic import of MCP config
  const mcpConfigPath = resolve(dirname(import.meta.dir), "mcp-config.ts");
  const mcpModule = await import(mcpConfigPath).catch(() => null);
  if (mcpModule?.MCP_SERVERS) {
    MCP_SERVERS = mcpModule.MCP_SERVERS;
    console.log(
      `Loaded ${Object.keys(MCP_SERVERS).length} MCP servers from mcp-config.ts`
    );
  }
} catch {
  console.log("No mcp-config.ts found - running without MCPs");
}

export { MCP_SERVERS };

// ============== Security Configuration ==============

// Allowed directories for file operations
const defaultAllowedPaths = [
  WORKING_DIR,
  `${HOME}/Documents`,
  `${HOME}/Downloads`,
  `${HOME}/Desktop`,
  `${HOME}/.claude`, // Claude Code data (plans, settings)
];

const allowedPathsStr = process.env.ALLOWED_PATHS || "";
export const ALLOWED_PATHS: string[] = allowedPathsStr
  ? allowedPathsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
  : defaultAllowedPaths;

// Build safety prompt dynamically from ALLOWED_PATHS
function buildSafetyPrompt(allowedPaths: string[]): string {
  const pathsList = allowedPaths
    .map((p) => `   - ${p} (and subdirectories)`)
    .join("\n");

  return `
CRITICAL SAFETY RULES FOR TELEGRAM BOT:

1. NEVER delete, remove, or overwrite files without EXPLICIT confirmation from the user.
   - If user asks to delete something, respond: "Are you sure you want to delete [file]? Reply 'yes delete it' to confirm."
   - Only proceed with deletion if user replies with explicit confirmation like "yes delete it", "confirm delete"
   - This applies to: rm, trash, unlink, shred, or any file deletion

2. You can ONLY access files in these directories:
${pathsList}
   - REFUSE any file operations outside these paths

3. NEVER run dangerous commands like:
   - rm -rf (recursive force delete)
   - Any command that affects files outside allowed directories
   - Commands that could damage the system

4. For any destructive or irreversible action, ALWAYS ask for confirmation first.

You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!
`;
}

export const SAFETY_PROMPT = buildSafetyPrompt(ALLOWED_PATHS);

// ============== Workflow Prompt ==============

// Workflow instructions separate from safety rules.
// These teach Claude about available tools and patterns.
// Kept composable so they can be adapted per agent backend (Claude Code, Codex, etc.).

export const WORKFLOW_PROMPT = `
LONG-RUNNING PROCESSES:
When running commands expected to take more than 60 seconds (simulations,
optimizations, full test suites, data processing, long builds), use the
\`long-run\` wrapper command:
  long-run <command> [args...]

This runs the command in a detached background process and returns immediately.
The bot will automatically notify you when it completes.

After starting a long-run process, tell the user it's running in background.
When you receive a completion notification, read the log file and continue.

Do NOT use long-run for quick commands (<30s) or interactive commands.


FILE FORWARDING:
When a user sends a file with a caption starting with "/raw", the file is saved
directly to your working directory without any parsing or text extraction.

You'll receive a message with:
- Original filename
- File path (relative to your working directory)
- File size
- User's note (caption without /raw prefix)

Files are stored in: .claude-bot/files/

You can read, process, or analyze these files using Bash or Read tools. Examples:
- Read JSON: Use Read tool on the file path
- Process CSV: Use Bash with awk, cut, or other CLI tools
- Binary files: Use appropriate tools (xxd, file, etc.)

LARGE RESPONSES:
If your response exceeds 3500 characters, it will be automatically saved to
.claude-bot/responses/ and sent to the user as a downloadable file. This
prevents Telegram formatting errors and message fragmentation.


FILE SENDING:
You can send files back to the user via Telegram using a special marker syntax.
To send a file, include this marker in your response:

  [SEND_FILE: /path/to/file.ext]

Examples:
  - [SEND_FILE: /home/ubuntu/Projects/myproject/output.png] - Send an image
  - [SEND_FILE: ./report.pdf] - Send a PDF (relative paths work)
  - [SEND_FILE: /tmp/data.json] - Send any file type

The file marker will be removed from your message and the file will be sent
automatically. You can include multiple [SEND_FILE] markers to send multiple files.

Supported file types: images (png, jpg, gif), documents (pdf, txt, csv, json),
videos (mp4, webm), audio (mp3, ogg), and any other file type.

IMPORTANT:
- Always verify the file exists before requesting to send it
- Use absolute paths or paths relative to the working directory
- The file path will be validated against allowed directories for security
- If the file doesn't exist or is outside allowed paths, an error will be shown
`;

/**
 * Compose all system prompt sections into a single string.
 * Each section is a separate concern that can be conditionally included
 * or adapted for different agent backends.
 */
export const SYSTEM_PROMPT = [SAFETY_PROMPT, WORKFLOW_PROMPT].join("\n");

// Dangerous command patterns to block
export const BLOCKED_PATTERNS = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf $HOME",
  "sudo rm",
  ":(){ :|:& };:", // Fork bomb
  "> /dev/sd",
  "mkfs.",
  "dd if=",
];

// Query timeout (10 minutes)
export const QUERY_TIMEOUT_MS = 600_000;

// ============== Voice Transcription ==============

const BASE_TRANSCRIPTION_PROMPT = `Transcribe this voice message accurately.
The speaker may use multiple languages (English, and possibly others).
Focus on accuracy for proper nouns, technical terms, and commands.`;

const TRANSCRIPTION_CONTEXT = process.env.TRANSCRIPTION_CONTEXT || "";

export const TRANSCRIPTION_PROMPT = TRANSCRIPTION_CONTEXT
  ? `${BASE_TRANSCRIPTION_PROMPT}\n\nAdditional context:\n${TRANSCRIPTION_CONTEXT}`
  : BASE_TRANSCRIPTION_PROMPT;

export const TRANSCRIPTION_AVAILABLE = TRANSCRIPTION_PROVIDER !== "none";

// ============== Voice Synthesis (TTS) ==============

export const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || "";
export const GOOGLE_TTS_VOICE = process.env.GOOGLE_TTS_VOICE || "en-US-Neural2-J";
export const GOOGLE_TTS_LANGUAGE = process.env.GOOGLE_TTS_LANGUAGE || "en-US";
export const TTS_AVAILABLE = GOOGLE_TTS_API_KEY.length > 0;
export const TTS_MAX_CHARS = 500; // Truncate to ~30-40 seconds of audio (keeps messages concise)

// Voice-optimized system prompt addon
export const VOICE_MODE_PROMPT = `
VOICE MODE IS ENABLED: Your final summary/response will be converted to speech.

Requirements for voice output:
- Be VERY CONCISE but include all important information
- Provide CONCEPTUAL explanations (what changed, why it matters) NOT file-level details
- Explain what the code DOES, don't describe file names or line numbers
- Speak naturally as if explaining to a colleague
- The text version will have all code/formatting details, so focus on the high-level summary for voice

Example: Instead of "I modified src/utils.ts line 45 to add error handling", say "I added error handling to the voice synthesis function so it fails gracefully if the API is unavailable."
`;

// ============== Thinking Keywords ==============

const thinkingKeywordsStr =
  process.env.THINKING_KEYWORDS || "think,pensa,ragiona";
const thinkingDeepKeywordsStr =
  process.env.THINKING_DEEP_KEYWORDS || "ultrathink,think hard,pensa bene";

export const THINKING_KEYWORDS = thinkingKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());
export const THINKING_DEEP_KEYWORDS = thinkingDeepKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());

// ============== Media Group Settings ==============

export const MEDIA_GROUP_TIMEOUT = 1000; // ms to wait for more photos in a group

// ============== Telegram Message Limits ==============

export const TELEGRAM_MESSAGE_LIMIT = 4096; // Max characters per message
export const TELEGRAM_SAFE_LIMIT = 4000; // Safe limit with buffer for formatting
export const STREAMING_THROTTLE_MS = 500; // Throttle streaming updates
export const BUTTON_LABEL_MAX_LENGTH = 30; // Max chars for inline button labels

// ============== File Forwarding Configuration ==============

// Maximum file size for raw mode forwarding (default: 50MB)
export const RAW_FILE_MAX_SIZE = parseInt(
  process.env.RAW_FILE_MAX_SIZE || "52428800",
  10
);

// Response size threshold for auto-saving (default: 3500 chars)
// Telegram's limit is 4096, we use 3500 for safety buffer
export const RESPONSE_SIZE_THRESHOLD = parseInt(
  process.env.RESPONSE_SIZE_THRESHOLD || "3500",
  10
);

// Enable auto-save of large responses
export const AUTO_SAVE_LARGE_RESPONSES =
  (process.env.AUTO_SAVE_LARGE_RESPONSES || "true").toLowerCase() === "true";

// File retention period in days (default: 7 days)
export const FILE_RETENTION_DAYS = parseInt(
  process.env.FILE_RETENTION_DAYS || "7",
  10
);

// Cleanup interval in milliseconds (default: 24 hours)
export const CLEANUP_INTERVAL_MS = parseInt(
  process.env.CLEANUP_INTERVAL_MS || String(24 * 60 * 60 * 1000),
  10
);

// ============== Smart Table Rendering Configuration ==============

// Enable smart three-tier table rendering
export const ENABLE_SMART_TABLE_RENDERING =
  (process.env.ENABLE_SMART_TABLE_RENDERING || "true").toLowerCase() !== "false";

// Table rendering thresholds
export const TABLE_RENDERING_THRESHOLDS = {
  // Simple → list format if both conditions met
  simpleMaxCols: parseInt(process.env.TABLE_SIMPLE_MAX_COLS || "3", 10),
  simpleMaxRows: parseInt(process.env.TABLE_SIMPLE_MAX_ROWS || "3", 10),

  // Large → image + CSV if either condition met
  largeMinCols: parseInt(process.env.TABLE_LARGE_MIN_COLS || "10", 10),
  largeMinRows: parseInt(process.env.TABLE_LARGE_MIN_ROWS || "20", 10),
};

// Maximum width for table images in pixels
export const TABLE_IMAGE_MAX_WIDTH = parseInt(
  process.env.TABLE_IMAGE_MAX_WIDTH || "800",
  10
);

// ============== Audit Logging ==============

export const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH || "/tmp/claude-telegram-audit.log";
export const AUDIT_LOG_JSON =
  (process.env.AUDIT_LOG_JSON || "false").toLowerCase() === "true";

// ============== Rate Limiting ==============

export const RATE_LIMIT_ENABLED =
  (process.env.RATE_LIMIT_ENABLED || "true").toLowerCase() === "true";
export const RATE_LIMIT_REQUESTS = parseInt(
  process.env.RATE_LIMIT_REQUESTS || "20",
  10
);
export const RATE_LIMIT_WINDOW = parseInt(
  process.env.RATE_LIMIT_WINDOW || "60",
  10
);

// ============== File Paths ==============

export const SESSION_FILE = "/tmp/claude-telegram-session.json";
export const RESTART_FILE = "/tmp/claude-telegram-restart.json";
export const ACTIVE_SESSIONS_FILE = "/tmp/claude-telegram-active.json";
export const HEARTBEAT_FILE = "/tmp/claude-telegram-heartbeat.json";
export const TEMP_DIR = "/tmp/telegram-bot";

// Temp paths that are always allowed for bot operations
export const TEMP_PATHS = ["/tmp/", "/private/tmp/", "/var/folders/"];

// Ensure temp directory exists
await Bun.write(`${TEMP_DIR}/.keep`, "");

// ============== Validation ==============

if (!TELEGRAM_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN environment variable is required");
  process.exit(1);
}

if (ALLOWED_USERS.length === 0) {
  console.error(
    "ERROR: TELEGRAM_ALLOWED_USERS environment variable is required"
  );
  process.exit(1);
}

console.log(
  `Config loaded: ${ALLOWED_USERS.length} allowed users, working dir: ${WORKING_DIR}`
);
