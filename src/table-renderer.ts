/**
 * Table Renderer Module
 *
 * Three-tier rendering strategy for markdown tables in Telegram:
 * 1. Simple tables (≤3x3) → Row-by-row list format
 * 2. Complex tables (4-20 rows, 4-10 cols) → PNG images
 * 3. Very large tables (>20 rows or >10 cols) → PNG preview + CSV download
 */

import { mkdirSync } from "fs";
import { writeFileSync } from "fs";
import { createCanvas } from "@napi-rs/canvas";
import { TABLE_RENDERING_THRESHOLDS, TABLE_IMAGE_MAX_WIDTH } from "./config";

// ============================================================================
// TYPES
// ============================================================================

export interface TableData {
  headers: string[];
  rows: string[][];
}

export interface TableStrategy {
  type: "list" | "image" | "image_with_csv";
  rowCount: number;
  colCount: number;
}

// ============================================================================
// IMAGE STYLING
// ============================================================================

const IMAGE_STYLE = {
  // Typography
  fontFamily: "Arial, sans-serif",
  fontSize: 14,
  headerFontSize: 15,

  // Colors
  backgroundColor: "#FFFFFF",
  headerBackground: "#F0F2F5",
  borderColor: "#C4C4C4",
  textColor: "#000000",
  headerTextColor: "#000000",

  // Spacing
  cellPadding: 10,
  borderWidth: 1,

  // Constraints (maxWidth comes from config)
  maxHeight: 2000,
};

// ============================================================================
// TABLE PARSING
// ============================================================================

/**
 * Parse markdown table into structured data (headers + rows)
 *
 * Example input:
 * | Name  | Age | City |
 * |-------|-----|------|
 * | Alice | 30  | NYC  |
 * | Bob   | 25  | LA   |
 *
 * Returns: {
 *   headers: ["Name", "Age", "City"],
 *   rows: [["Alice", "30", "NYC"], ["Bob", "25", "LA"]]
 * }
 */
export function parseMarkdownTable(markdown: string): TableData {
  const lines = markdown.trim().split("\n").map(line => line.trim());

  if (lines.length < 2) {
    // Invalid table - need at least header + separator
    return { headers: [], rows: [] };
  }

  // Parse header row (first line)
  const headerLine = lines[0];
  if (!headerLine) {
    return { headers: [], rows: [] };
  }

  const headers = headerLine
    .split("|")
    .map(cell => cell.trim())
    .filter(cell => cell.length > 0);

  // Skip separator line (second line with dashes)
  // Parse data rows (remaining lines)
  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.includes("|")) continue;

    const cells = line
      .split("|")
      .map(cell => cell.trim())
      .filter((cell, idx, arr) => {
        // Filter out empty cells at start/end (from leading/trailing |)
        if (idx === 0 || idx === arr.length - 1) {
          return cell.length > 0;
        }
        return true;
      });

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return { headers, rows };
}

// ============================================================================
// STRATEGY DETERMINATION
// ============================================================================

/**
 * Determine which rendering strategy to use based on table size
 */
export function getTableRenderingStrategy(
  markdown: string
): TableStrategy {
  const thresholds = TABLE_RENDERING_THRESHOLDS;
  const { headers, rows } = parseMarkdownTable(markdown);

  const colCount = headers.length;
  const rowCount = rows.length;

  // Tier 1: Simple tables → list format
  if (
    colCount <= thresholds.simpleMaxCols &&
    rowCount <= thresholds.simpleMaxRows
  ) {
    return { type: "list", rowCount, colCount };
  }

  // Tier 3: Very large tables → image + CSV
  if (
    rowCount > thresholds.largeMinRows ||
    colCount >= thresholds.largeMinCols
  ) {
    return { type: "image_with_csv", rowCount, colCount };
  }

  // Tier 2: Complex tables → image only
  return { type: "image", rowCount, colCount };
}

// ============================================================================
// LIST RENDERING (Tier 1)
// ============================================================================

/**
 * Convert simple table to row-by-row list format
 *
 * Example output:
 * 📊 User Table (3 rows):
 *
 * • Name: Alice
 *   Age: 30
 *   City: NYC
 *
 * • Name: Bob
 *   Age: 25
 *   City: LA
 */
export function convertTableToList(markdown: string): string {
  const { headers, rows } = parseMarkdownTable(markdown);

  if (headers.length === 0 || rows.length === 0) {
    // Fallback for malformed tables
    return `<pre>${markdown}</pre>`;
  }

  let html = `<b>📊 Table (${rows.length} ${rows.length === 1 ? "row" : "rows"}):</b>\n\n`;

  for (const row of rows) {
    html += "• ";

    // First field on the bullet line
    if (row[0] !== undefined) {
      const headerLabel = headers[0] || "Field";
      html += `<b>${headerLabel}:</b> ${row[0]}`;
    }

    html += "\n";

    // Remaining fields indented
    for (let i = 1; i < row.length; i++) {
      const headerLabel = headers[i] || `Field ${i + 1}`;
      const value = row[i] || "";
      html += `  ${headerLabel}: ${value}\n`;
    }

    html += "\n";
  }

  return html.trimEnd();
}

// ============================================================================
// IMAGE RENDERING (Tier 2 & 3)
// ============================================================================

/**
 * Render table to PNG image and save to disk
 *
 * @param markdown - Markdown table string
 * @param outputDir - Directory to save PNG file
 * @param filename - Filename for PNG (e.g., "table_123456_0.png")
 * @param maxRows - Optional: truncate to first N rows for large tables
 * @returns File path if successful, null if failed
 */
export async function renderTableToImage(
  markdown: string,
  outputDir: string,
  filename: string,
  maxRows?: number
): Promise<string | null> {
  try {
    const { headers, rows } = parseMarkdownTable(markdown);

    if (headers.length === 0 || rows.length === 0) {
      console.warn("[table-renderer] Empty table, cannot render image");
      return null;
    }

    // Truncate rows if maxRows specified (for large tables)
    const displayRows = maxRows ? rows.slice(0, maxRows) : rows;
    const isTruncated = maxRows && rows.length > maxRows;

    // Ensure output directory exists
    mkdirSync(outputDir, { recursive: true });

    // Create temporary canvas for text measurement
    const measureCanvas = createCanvas(100, 100);
    const measureCtx = measureCanvas.getContext("2d");
    measureCtx.font = `${IMAGE_STYLE.fontSize}px ${IMAGE_STYLE.fontFamily}`;

    // Measure column widths
    const colWidths: number[] = [];
    for (let col = 0; col < headers.length; col++) {
      const headerText = headers[col] || "";
      let maxWidth = measureCtx.measureText(headerText).width;

      for (const row of displayRows) {
        const cellText = row[col] || "";
        const textWidth = measureCtx.measureText(cellText).width;
        maxWidth = Math.max(maxWidth, textWidth);
      }

      // Add padding
      colWidths.push(maxWidth + IMAGE_STYLE.cellPadding * 2);
    }

    // Calculate dimensions
    const tableWidth = Math.min(
      colWidths.reduce((sum, w) => sum + w, 0) + IMAGE_STYLE.borderWidth,
      TABLE_IMAGE_MAX_WIDTH
    );

    const rowHeight = IMAGE_STYLE.fontSize + IMAGE_STYLE.cellPadding * 2;
    const headerHeight = IMAGE_STYLE.headerFontSize + IMAGE_STYLE.cellPadding * 2;
    const tableHeight = Math.min(
      headerHeight + displayRows.length * rowHeight + IMAGE_STYLE.borderWidth * (displayRows.length + 2),
      IMAGE_STYLE.maxHeight
    );

    // Create actual canvas
    const canvas = createCanvas(tableWidth, tableHeight);
    const ctx = canvas.getContext("2d");

    // Fill background
    ctx.fillStyle = IMAGE_STYLE.backgroundColor;
    ctx.fillRect(0, 0, tableWidth, tableHeight);

    // Draw table
    let yPos = 0;

    // Draw header row
    ctx.fillStyle = IMAGE_STYLE.headerBackground;
    ctx.fillRect(0, yPos, tableWidth, headerHeight);

    ctx.strokeStyle = IMAGE_STYLE.borderColor;
    ctx.lineWidth = IMAGE_STYLE.borderWidth;

    let xPos = 0;
    for (let col = 0; col < headers.length; col++) {
      const colWidth = colWidths[col];
      if (colWidth === undefined) continue;

      // Draw cell border
      ctx.strokeRect(xPos, yPos, colWidth, headerHeight);

      // Draw header text
      ctx.fillStyle = IMAGE_STYLE.headerTextColor;
      ctx.font = `bold ${IMAGE_STYLE.headerFontSize}px ${IMAGE_STYLE.fontFamily}`;
      ctx.textBaseline = "middle";

      const text = headers[col] || "";
      const textX = xPos + IMAGE_STYLE.cellPadding;
      const textY = yPos + headerHeight / 2;
      ctx.fillText(text, textX, textY);

      xPos += colWidth;
    }

    yPos += headerHeight;

    // Draw data rows
    ctx.font = `${IMAGE_STYLE.fontSize}px ${IMAGE_STYLE.fontFamily}`;
    for (const row of displayRows) {
      xPos = 0;

      for (let col = 0; col < headers.length; col++) {
        const colWidth = colWidths[col];
        if (colWidth === undefined) continue;

        // Draw cell border
        ctx.strokeRect(xPos, yPos, colWidth, rowHeight);

        // Draw cell text
        ctx.fillStyle = IMAGE_STYLE.textColor;
        const text = row[col] || "";
        const textX = xPos + IMAGE_STYLE.cellPadding;
        const textY = yPos + rowHeight / 2;
        ctx.fillText(text, textX, textY);

        xPos += colWidth;
      }

      yPos += rowHeight;
    }

    // Add truncation indicator if needed
    if (isTruncated) {
      yPos -= rowHeight;
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
      ctx.font = `italic ${IMAGE_STYLE.fontSize}px ${IMAGE_STYLE.fontFamily}`;
      ctx.fillText("... (truncated)", IMAGE_STYLE.cellPadding, yPos + rowHeight);
    }

    // Save to file
    const filePath = `${outputDir}/${filename}`;
    const buffer = canvas.toBuffer("image/png");
    writeFileSync(filePath, buffer);

    return filePath;
  } catch (error) {
    console.error("[table-renderer] Failed to render table image:", error);
    return null;
  }
}

// ============================================================================
// CSV GENERATION (Tier 3) - Placeholder for Phase 3
// ============================================================================

/**
 * Generate CSV file from markdown table
 *
 * @param markdown - Markdown table string
 * @param outputDir - Directory to save CSV file
 * @param filename - Filename for CSV (e.g., "table_123456_0.csv")
 * @returns File path if successful, null if failed
 */
export function generateTableCSV(
  markdown: string,
  outputDir: string,
  filename: string
): string | null {
  try {
    const { headers, rows } = parseMarkdownTable(markdown);

    if (headers.length === 0 || rows.length === 0) {
      return null;
    }

    // Ensure output directory exists
    mkdirSync(outputDir, { recursive: true });

    // Generate CSV content
    const escapeCsvValue = (value: string): string => {
      // Escape double quotes and wrap in quotes if contains comma/quote/newline
      if (value.includes(",") || value.includes('"') || value.includes("\n")) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    };

    const csvLines: string[] = [];

    // Header row
    csvLines.push(headers.map(escapeCsvValue).join(","));

    // Data rows
    for (const row of rows) {
      const paddedRow = [...row];
      // Pad with empty strings if row has fewer cells than headers
      while (paddedRow.length < headers.length) {
        paddedRow.push("");
      }
      csvLines.push(paddedRow.map(escapeCsvValue).join(","));
    }

    const csvContent = csvLines.join("\n");
    const filePath = `${outputDir}/${filename}`;

    writeFileSync(filePath, csvContent, "utf-8");

    return filePath;
  } catch (error) {
    console.error("[table-renderer] Failed to generate CSV:", error);
    return null;
  }
}
