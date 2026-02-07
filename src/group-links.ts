/**
 * Group-to-project link persistence for Claude Telegram Bot.
 *
 * Stores permanent mappings of Telegram groups to projects.
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";

const GROUP_LINKS_FILE = `${homedir()}/.claude/telegram-group-links.json`;

export interface GroupLink {
  projectName: string;
  projectPath: string;
  linkedAt: string;
  linkedBy: number;      // User ID who linked it
  groupTitle: string;    // For display
}

// In-memory cache
let groupLinksCache = new Map<number, GroupLink>();
let cacheLoaded = false;

/**
 * Load group links from disk.
 */
export function loadGroupLinks(): Map<number, GroupLink> {
  if (cacheLoaded) return groupLinksCache;

  if (!existsSync(GROUP_LINKS_FILE)) {
    groupLinksCache = new Map();
    cacheLoaded = true;
    return groupLinksCache;
  }

  try {
    const data = JSON.parse(readFileSync(GROUP_LINKS_FILE, "utf-8"));
    groupLinksCache = new Map(
      Object.entries(data).map(([k, v]) => [parseInt(k), v as GroupLink])
    );
    cacheLoaded = true;
  } catch (error) {
    console.error("Failed to load group links:", error);
    groupLinksCache = new Map();
    cacheLoaded = true;
  }

  return groupLinksCache;
}

/**
 * Save group links to disk (atomic write).
 */
function saveGroupLinks(): void {
  const data: Record<string, GroupLink> = {};
  for (const [groupId, link] of Array.from(groupLinksCache)) {
    data[groupId.toString()] = link;
  }

  try {
    writeFileSync(GROUP_LINKS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Failed to save group links:", error);
  }
}

/**
 * Get group link for a specific group.
 */
export function getGroupLink(groupId: number): GroupLink | null {
  loadGroupLinks();
  return groupLinksCache.get(groupId) || null;
}

/**
 * Set group link (create or update).
 */
export function setGroupLink(groupId: number, link: GroupLink): void {
  loadGroupLinks();
  groupLinksCache.set(groupId, link);
  saveGroupLinks();
}

/**
 * Remove group link.
 */
export function removeGroupLink(groupId: number): void {
  loadGroupLinks();
  groupLinksCache.delete(groupId);
  saveGroupLinks();
}

/**
 * Get all group links.
 */
export function getAllGroupLinks(): Map<number, GroupLink> {
  loadGroupLinks();
  return new Map(groupLinksCache);
}
