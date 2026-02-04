/**
 * Project alias management for Claude Telegram Bot.
 *
 * Auto-generates and persists project aliases (lowercase, human-friendly names).
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "fs";
import { homedir } from "os";

const HOME = homedir();
const ALIAS_FILE = `${HOME}/.claude/telegram-project-aliases.json`;

interface AliasMapping {
  [projectPath: string]: string; // path -> alias
}

interface ReverseMapping {
  [alias: string]: string; // alias -> path
}

let aliasCache: AliasMapping | null = null;
let reverseCache: ReverseMapping | null = null;

/**
 * Project scan directories - these are scanned on startup for auto-alias generation.
 */
const PROJECT_SCAN_DIRS = [
  `${HOME}/Projects`,
  `${HOME}/.openclaw/workspace`,
];

/**
 * Load aliases from disk (cached).
 */
function loadAliases(): AliasMapping {
  if (aliasCache !== null) {
    return aliasCache;
  }

  try {
    if (existsSync(ALIAS_FILE)) {
      const content = readFileSync(ALIAS_FILE, "utf-8");
      aliasCache = JSON.parse(content);
      // Also build reverse cache
      reverseCache = {};
      for (const [path, alias] of Object.entries(aliasCache!)) {
        reverseCache[alias] = path;
      }
      return aliasCache!;
    }
  } catch (error) {
    console.warn("Failed to load project aliases:", error);
  }

  aliasCache = {};
  reverseCache = {};
  return aliasCache;
}

/**
 * Build reverse mapping from current aliases.
 */
function buildReverseMapping(): ReverseMapping {
  if (reverseCache !== null) {
    return reverseCache;
  }

  const aliases = loadAliases();
  reverseCache = {};
  for (const [path, alias] of Object.entries(aliases)) {
    reverseCache[alias] = path;
  }
  return reverseCache;
}

/**
 * Save aliases to disk.
 */
function saveAliases(aliases: AliasMapping): void {
  try {
    // Ensure directory exists
    const dir = ALIAS_FILE.substring(0, ALIAS_FILE.lastIndexOf("/"));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(ALIAS_FILE, JSON.stringify(aliases, null, 2), "utf-8");
    aliasCache = aliases;

    // Rebuild reverse cache
    reverseCache = {};
    for (const [path, alias] of Object.entries(aliases)) {
      reverseCache[alias] = path;
    }
  } catch (error) {
    console.error("Failed to save project aliases:", error);
  }
}

/**
 * Generate a human-friendly alias from a project path.
 * Rules:
 * - Extract last directory name
 * - Convert to lowercase
 * - Replace special characters with hyphens
 * - Remove leading/trailing hyphens
 */
function generateAlias(projectPath: string): string {
  // Get last directory component
  const parts = projectPath.replace(/\/$/, "").split("/");
  let name = parts[parts.length - 1] || "project";

  // Special case: if it's the home directory, use "home"
  if (projectPath === HOME || projectPath === `${HOME}/`) {
    return "home";
  }

  // Convert to lowercase
  name = name.toLowerCase();

  // Replace special characters with hyphens
  name = name.replace(/[^a-z0-9]+/g, "-");

  // Remove leading/trailing hyphens
  name = name.replace(/^-+|-+$/g, "");

  // Fallback if empty
  if (!name) {
    name = "project";
  }

  return name;
}

/**
 * Get alias for a project path.
 * Auto-generates and saves if not exists.
 */
export function getProjectAlias(projectPath: string): string {
  const aliases = loadAliases();

  // Check if alias already exists
  if (aliases[projectPath]) {
    return aliases[projectPath]!;
  }

  // Generate new alias
  const alias = generateAlias(projectPath);

  // Check for conflicts and append number if needed
  let finalAlias = alias;
  let counter = 1;
  const existingAliases = new Set(Object.values(aliases));

  while (existingAliases.has(finalAlias)) {
    counter++;
    finalAlias = `${alias}-${counter}`;
  }

  // Save the new alias
  aliases[projectPath] = finalAlias;
  saveAliases(aliases);

  return finalAlias;
}

/**
 * Set a custom alias for a project path.
 */
export function setProjectAlias(projectPath: string, alias: string): void {
  const aliases = loadAliases();

  // Convert to lowercase
  alias = alias.toLowerCase();

  // Check if alias is already in use by another path
  for (const [path, existingAlias] of Object.entries(aliases)) {
    if (existingAlias === alias && path !== projectPath) {
      throw new Error(`Alias "${alias}" is already in use by ${path}`);
    }
  }

  aliases[projectPath] = alias;
  saveAliases(aliases);
}

/**
 * Get all aliases.
 */
export function getAllAliases(): AliasMapping {
  return { ...loadAliases() };
}

/**
 * Remove alias for a project path.
 */
export function removeProjectAlias(projectPath: string): void {
  const aliases = loadAliases();
  delete aliases[projectPath];
  saveAliases(aliases);
}

/**
 * Reverse lookup: get project path by alias.
 * Returns null if alias not found.
 */
export function getProjectByAlias(alias: string): string | null {
  const reverse = buildReverseMapping();
  return reverse[alias.toLowerCase()] || null;
}

/**
 * Load project aliases (public export for external use).
 */
export function loadProjectAliases(): AliasMapping {
  return loadAliases();
}

/**
 * Scan directories and generate aliases for all projects.
 * Called on startup to auto-discover projects.
 */
export async function scanAndGenerateAliases(): Promise<void> {
  const aliases = loadAliases();
  const existingAliases = new Set(Object.values(aliases));

  // Add special aliases
  if (!aliases[HOME]) {
    aliases[HOME] = "home";
    existingAliases.add("home");
  }

  // Scan each project directory
  for (const scanDir of PROJECT_SCAN_DIRS) {
    if (!existsSync(scanDir)) {
      continue;
    }

    try {
      const entries = readdirSync(scanDir);

      for (const entry of entries) {
        // Skip hidden directories
        if (entry.startsWith(".")) {
          continue;
        }

        const fullPath = `${scanDir}/${entry}`;

        try {
          const stat = statSync(fullPath);
          if (!stat.isDirectory()) {
            continue;
          }

          // Skip if already has an alias
          if (aliases[fullPath]) {
            continue;
          }

          // Generate alias
          let alias = generateAlias(fullPath);

          // Handle conflicts
          let finalAlias = alias;
          let counter = 1;
          while (existingAliases.has(finalAlias)) {
            counter++;
            finalAlias = `${alias}-${counter}`;
          }

          aliases[fullPath] = finalAlias;
          existingAliases.add(finalAlias);
        } catch {
          // Skip directories we can't access
        }
      }
    } catch {
      // Skip scan directories we can't read
    }
  }

  saveAliases(aliases);
  console.log(`Project aliases: ${Object.keys(aliases).length} projects`);
}

/**
 * Get all aliases as a map of alias -> path (for UI display).
 */
export function getAliasToPathMap(): ReverseMapping {
  return { ...buildReverseMapping() };
}
