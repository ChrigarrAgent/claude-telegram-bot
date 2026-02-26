/**
 * Formatting module for Claude Telegram Bot.
 *
 * Markdown conversion and tool status display formatting.
 */

/**
 * Escape HTML special characters.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert a Markdown table to a formatted monospace table.
 */
function convertMarkdownTable(tableText: string): string {
  const lines = tableText.trim().split("\n");
  if (lines.length < 2) return tableText;

  // Parse rows (skip separator line with dashes)
  const rows: string[][] = [];
  for (const line of lines) {
    // Skip separator lines (|---|---|)
    if (/^\|?\s*[-:]+\s*\|/.test(line)) continue;

    const cells = line
      .split("|")
      .map(c => c.trim())
      .filter((c, i, arr) => i > 0 || c !== ""); // Remove empty first cell from leading |

    // Remove empty last cell from trailing |
    if (cells.length > 0 && cells[cells.length - 1] === "") {
      cells.pop();
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) return tableText;

  // Calculate column widths
  const colWidths: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i] || 0, row[i]!.length);
    }
  }

  // Build formatted table
  const output: string[] = [];
  const separator = "─".repeat(colWidths.reduce((a, b) => a + b, 0) + colWidths.length * 3 + 1);

  output.push(separator);

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]!;
    const formattedCells = row.map((cell, i) => cell.padEnd(colWidths[i] || 0));
    output.push("│ " + formattedCells.join(" │ ") + " │");

    // Add separator after header row
    if (rowIdx === 0 && rows.length > 1) {
      output.push(separator);
    }
  }

  output.push(separator);

  return "<pre>" + output.join("\n") + "</pre>";
}

import {
  getTableRenderingStrategy,
  convertTableToList,
  renderTableToImage,
  generateTableCSV,
  type TableStrategy,
} from "./table-renderer";

/**
 * Convert standard markdown to Telegram-compatible HTML.
 *
 * HTML is more reliable than Telegram's Markdown which breaks on special chars.
 * Telegram HTML supports: <b>, <i>, <code>, <pre>, <a href="">
 *
 * @param text - Markdown text to convert
 * @param workingDir - Optional working directory for saving table images/CSV files
 */
export async function convertMarkdownToHtml(text: string, workingDir?: string): Promise<string> {
  // Store code blocks temporarily to avoid processing their contents
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  const tables: Array<{ markdown: string; strategy: TableStrategy }> = [];

  // Save code blocks first (```code```)
  text = text.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // Save inline code (`code`)
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(code);
    return `\x00INLINECODE${inlineCodes.length - 1}\x00`;
  });

  // Detect and save Markdown tables with rendering strategy
  text = text.replace(/((?:^\|.+\|$\n?)+)/gm, (match) => {
    const strategy = getTableRenderingStrategy(match);
    tables.push({ markdown: match, strategy });
    return `\x00TABLE${tables.length - 1}\x00`;
  });

  // Escape HTML entities in the remaining text
  text = escapeHtml(text);

  // Headers: ## Header -> <b>Header</b>
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>\n");

  // Bold: **text** -> <b>text</b>
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Also handle *text* as bold (single asterisk)
  text = text.replace(/(?<!\*)\*(.+?)\*(?!\*)/g, "<b>$1</b>");

  // Double underscore: __text__ -> <b>text</b>
  text = text.replace(/__([^_]+)__/g, "<b>$1</b>");

  // Italic: _text_ -> <i>text</i> (but not __text__)
  text = text.replace(/(?<!_)_([^_]+)_(?!_)/g, "<i>$1</i>");

  // Blockquotes: &gt; text -> <blockquote>text</blockquote>
  text = convertBlockquotes(text);

  // Bullet lists: - item or * item -> • item
  text = text.replace(/^[-*] /gm, "• ");

  // Horizontal rules: --- or *** -> blank line
  text = text.replace(/^[-*]{3,}$/gm, "");

  // Links: [text](url) -> <a href="url">text</a>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore tables with three-tier rendering strategy
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i]!;
    const { markdown, strategy } = table;
    const placeholder = `\x00TABLE${i}\x00`;

    // Strategy 1: Simple tables → row-by-row list
    if (strategy.type === "list") {
      const listHtml = convertTableToList(markdown);
      text = text.replace(placeholder, listHtml);
      continue;
    }

    // Strategy 2: Complex tables → PNG image
    if (strategy.type === "image" && workingDir) {
      try {
        const outputDir = `${workingDir}/.claude-bot/tables`;
        const filename = `table_${Date.now()}_${i}.png`;
        console.log(`[TABLE-RENDER] Rendering image for table ${i}, strategy: image, workingDir: ${workingDir}`);

        const imagePath = await renderTableToImage(markdown, outputDir, filename);
        console.log(`[TABLE-RENDER] Image path result: ${imagePath}`);

        if (imagePath) {
          const marker = `[SEND_FILE: ${imagePath}]`;
          const note = `<i>📊 Table (${strategy.rowCount}×${strategy.colCount}, see image above)</i>`;
          console.log(`[TABLE-RENDER] Inserting marker: ${marker}`);
          text = text.replace(placeholder, `${marker}\n${note}`);
        } else {
          // Fallback to text if image rendering fails
          console.warn(`[TABLE-RENDER] Image rendering returned null, falling back to text`);
          const formattedTable = convertMarkdownTable(markdown);
          text = text.replace(placeholder, formattedTable);
        }
      } catch (error) {
        console.error("[formatting] Table image rendering failed:", error);
        const formattedTable = convertMarkdownTable(markdown);
        text = text.replace(placeholder, formattedTable);
      }
      continue;
    }

    // Check if we're falling through without workingDir
    if (strategy.type === "image" && !workingDir) {
      console.warn(`[TABLE-RENDER] Image strategy but no workingDir! Falling back to text.`);
    }

    // Strategy 3: Very large tables → PNG preview + CSV
    if (strategy.type === "image_with_csv" && workingDir) {
      try {
        const outputDir = `${workingDir}/.claude-bot/tables`;
        const pngFilename = `table_${Date.now()}_${i}.png`;
        const csvFilename = `table_${Date.now()}_${i}.csv`;
        console.log(`[TABLE-RENDER] Rendering large table ${i}, strategy: image_with_csv, workingDir: ${workingDir}`);

        const [imagePath, csvPath] = await Promise.all([
          renderTableToImage(markdown, outputDir, pngFilename, 20), // First 20 rows
          Promise.resolve(generateTableCSV(markdown, outputDir, csvFilename)),
        ]);

        console.log(`[TABLE-RENDER] Large table results - image: ${imagePath}, csv: ${csvPath}`);

        if (imagePath && csvPath) {
          const markers = `[SEND_FILE: ${imagePath}]\n[SEND_FILE: ${csvPath}]`;
          const note = `<i>📊 Large table (${strategy.rowCount} rows). Image shows preview, download CSV for full data.</i>`;
          console.log(`[TABLE-RENDER] Inserting markers: ${markers}`);
          text = text.replace(placeholder, `${markers}\n${note}`);
        } else if (imagePath) {
          // CSV failed, just send image
          const marker = `[SEND_FILE: ${imagePath}]`;
          const note = `<i>📊 Table (${strategy.rowCount}×${strategy.colCount}, see image above)</i>`;
          console.log(`[TABLE-RENDER] CSV failed, inserting image marker only: ${marker}`);
          text = text.replace(placeholder, `${marker}\n${note}`);
        } else {
          // Both failed, fallback to text
          console.warn(`[TABLE-RENDER] Both image and CSV failed, falling back to text`);
          const formattedTable = convertMarkdownTable(markdown);
          text = text.replace(placeholder, formattedTable);
        }
      } catch (error) {
        console.error("[formatting] Table rendering failed:", error);
        const formattedTable = convertMarkdownTable(markdown);
        text = text.replace(placeholder, formattedTable);
      }
      continue;
    }

    // Check if we're falling through without workingDir
    if (strategy.type === "image_with_csv" && !workingDir) {
      console.warn(`[TABLE-RENDER] Large table strategy but no workingDir! Falling back to text.`);
    }

    // Fallback: No workingDir or unknown strategy → use current monospace rendering
    const formattedTable = convertMarkdownTable(markdown);
    text = text.replace(placeholder, formattedTable);
  }

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    const escapedCode = escapeHtml(codeBlocks[i]!);
    text = text.replace(`\x00CODEBLOCK${i}\x00`, `<pre>${escapedCode}</pre>`);
  }

  // Restore inline code
  for (let i = 0; i < inlineCodes.length; i++) {
    const escapedCode = escapeHtml(inlineCodes[i]!);
    text = text.replace(
      `\x00INLINECODE${i}\x00`,
      `<code>${escapedCode}</code>`
    );
  }

  // Collapse multiple newlines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text;
}

/**
 * Convert blockquotes (handles multi-line).
 */
function convertBlockquotes(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inBlockquote = false;
  const blockquoteLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("&gt; ") || line === "&gt;") {
      if (line === "&gt;") {
        blockquoteLines.push("");
      } else {
        // Remove '&gt; ' and strip # from hashtags (Telegram mobile bug workaround)
        const content = line.slice(5).replace(/#/g, "");
        blockquoteLines.push(content);
      }
      inBlockquote = true;
    } else {
      if (inBlockquote) {
        result.push(
          "<blockquote>" + blockquoteLines.join("\n") + "</blockquote>"
        );
        blockquoteLines.length = 0;
        inBlockquote = false;
      }
      result.push(line);
    }
  }

  // Handle blockquote at end
  if (inBlockquote) {
    result.push("<blockquote>" + blockquoteLines.join("\n") + "</blockquote>");
  }

  return result.join("\n");
}

// Legacy alias
export const convertMarkdownForTelegram = convertMarkdownToHtml;

// ============== Tool Status Formatting ==============

/**
 * Shorten a file path for display (last 2 components).
 */
function shortenPath(path: string): string {
  if (!path) return "file";
  const parts = path.split("/");
  if (parts.length >= 2) {
    return parts.slice(-2).join("/");
  }
  return parts[parts.length - 1] || path;
}

/**
 * Truncate text with ellipsis.
 */
function truncate(text: string, maxLen = 60): string {
  if (!text) return "";
  // Clean up newlines for display
  const cleaned = text.replace(/\n/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + "...";
}

/**
 * Wrap text in HTML code tags, escaping special chars.
 */
function code(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}

/**
 * Format tool use for display in Telegram with HTML formatting.
 */
export function formatToolStatus(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  const emojiMap: Record<string, string> = {
    Read: "📖",
    Write: "📝",
    Edit: "✏️",
    Bash: "▶️",
    Glob: "🔍",
    Grep: "🔎",
    WebSearch: "🔍",
    WebFetch: "🌐",
    Task: "🎯",
    TodoWrite: "📋",
    mcp__: "🔧",
  };

  // Find matching emoji
  let emoji = "🔧";
  for (const [key, val] of Object.entries(emojiMap)) {
    if (toolName.includes(key)) {
      emoji = val;
      break;
    }
  }

  // Format based on tool type
  if (toolName === "Read") {
    const filePath = String(toolInput.file_path || "file");
    const shortPath = shortenPath(filePath);
    const imageExtensions = [
      ".jpg",
      ".jpeg",
      ".png",
      ".gif",
      ".webp",
      ".bmp",
      ".svg",
      ".ico",
    ];
    if (imageExtensions.some((ext) => filePath.toLowerCase().endsWith(ext))) {
      return "👀 Viewing";
    }
    return `${emoji} Reading ${code(shortPath)}`;
  }

  if (toolName === "Write") {
    const filePath = String(toolInput.file_path || "file");
    return `${emoji} Writing ${code(shortenPath(filePath))}`;
  }

  if (toolName === "Edit") {
    const filePath = String(toolInput.file_path || "file");
    return `${emoji} Editing ${code(shortenPath(filePath))}`;
  }

  if (toolName === "Bash") {
    const cmd = String(toolInput.command || "");
    const desc = String(toolInput.description || "");
    if (desc) {
      return `${emoji} ${escapeHtml(desc)}`;
    }
    return `${emoji} ${code(truncate(cmd, 50))}`;
  }

  if (toolName === "Grep") {
    const pattern = String(toolInput.pattern || "");
    const path = String(toolInput.path || "");
    if (path) {
      return `${emoji} Searching ${code(truncate(pattern, 30))} in ${code(
        shortenPath(path)
      )}`;
    }
    return `${emoji} Searching ${code(truncate(pattern, 40))}`;
  }

  if (toolName === "Glob") {
    const pattern = String(toolInput.pattern || "");
    return `${emoji} Finding ${code(truncate(pattern, 50))}`;
  }

  if (toolName === "WebSearch") {
    const query = String(toolInput.query || "");
    return `${emoji} Searching: ${escapeHtml(truncate(query, 50))}`;
  }

  if (toolName === "WebFetch") {
    const url = String(toolInput.url || "");
    return `${emoji} Fetching ${code(truncate(url, 50))}`;
  }

  if (toolName === "Task") {
    const desc = String(toolInput.description || "");
    if (desc) {
      return `${emoji} Agent: ${escapeHtml(desc)}`;
    }
    return `${emoji} Running agent...`;
  }

  if (toolName === "Skill") {
    const skillName = String(toolInput.skill || "");
    if (skillName) {
      return `💭 Using skill: ${escapeHtml(skillName)}`;
    }
    return `💭 Using skill...`;
  }

  if (toolName.startsWith("mcp__")) {
    // Generic MCP tool formatting
    const parts = toolName.split("__");
    if (parts.length >= 3) {
      const server = parts[1]!;
      let action = parts[2]!;
      // Remove redundant server prefix from action
      if (action.startsWith(`${server}_`)) {
        action = action.slice(server.length + 1);
      }
      action = action.replace(/_/g, " ");

      // Try to get meaningful summary
      const summary =
        toolInput.title ||
        toolInput.query ||
        toolInput.content ||
        toolInput.text ||
        toolInput.id ||
        "";

      if (summary) {
        return `🔧 ${server} ${action}: ${escapeHtml(
          truncate(String(summary), 40)
        )}`;
      }
      return `🔧 ${server}: ${action}`;
    }
    return `🔧 ${escapeHtml(toolName)}`;
  }

  return `${emoji} ${escapeHtml(toolName)}`;
}

/**
 * Format context window usage as a percentage display.
 * Returns MARKDOWN format (not HTML) so it can be converted with the rest of the message.
 *
 * @param modelUsage - Model usage data from SDK result event
 * @returns Formatted string like "📊 **Context:** 45% (90K/200K tokens)" or empty string if no data
 */
export function formatContextUsage(
  modelUsage: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    contextWindow: number;
  }> | null
): string {
  if (!modelUsage || Object.keys(modelUsage).length === 0) {
    return "";
  }

  // Get the first (and typically only) model's usage
  const usage = Object.values(modelUsage)[0];
  if (!usage) return "";

  // IMPORTANT: Include cache read tokens in total context usage!
  // Cache read tokens are part of the context window (previously cached conversation)
  const usedTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadInputTokens || 0);
  const contextWindow = usage.contextWindow;

  // Calculate actual percentage (no scaling)
  const percentage = Math.min(100, Math.round((usedTokens / contextWindow) * 100));

  // Format token counts with K suffix for thousands
  const formatTokens = (n: number): string => {
    if (n >= 1000) {
      return `${(n / 1000).toFixed(1)}K`;
    }
    return n.toString();
  };

  // Color-coded emoji based on actual percentage
  let emoji: string;
  if (percentage < 50) {
    emoji = "💚"; // Green: safe
  } else if (percentage < 70) {
    emoji = "💛"; // Yellow: moderate
  } else if (percentage < 85) {
    emoji = "🧡"; // Orange: warning
  } else {
    emoji = "🔴"; // Red: critical
  }

  // Return markdown (** for bold), not HTML
  return `${emoji} **Context:** ${percentage}% (${formatTokens(usedTokens)}/${formatTokens(contextWindow)} tokens)`;
}
