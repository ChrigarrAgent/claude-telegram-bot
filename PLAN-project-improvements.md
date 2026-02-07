# Project Improvements Plan

## Overview
Implementation plan for improving multi-project support in Claude Telegram Bot with better alias management, @-syntax routing, and consistent project headers.

## Current State Analysis

### ✅ What's Working
1. **Multi-project support**: Multiple Claude sessions can run concurrently via `SessionManager`
2. **Project switching**: `/project <name>` command switches between projects
3. **Alias generation**: `project-aliases.ts` auto-generates lowercase aliases from directory names
4. **Project headers**: `SHOW_PROJECT_HEADERS` config supports "always", "never", "multiple" modes

### ⚠️ Issues to Fix
1. **Hardcoded aliases**: `PROJECT_ALIASES` in `config.ts` (lines 52-58) contains hardcoded project aliases
2. **Incomplete header implementation**: Project headers only show on initial message, not on thinking/streaming/tool messages
3. **No @-syntax support**: Cannot route messages with `@project` prefix
4. **No subdirectory aliases**: Aliases only for top-level projects, not subdirectories within projects

## Requirements

### 1. Remove Hardcoded Aliases
**Current**: `config.ts` has hardcoded `PROJECT_ALIASES` map:
```typescript
export const PROJECT_ALIASES: Record<string, string> = {
  "home": HOME,
  "aegir": "/home/ubuntu/Projects/aegir",
  "openclaw": "/home/ubuntu/.openclaw/workspace",
  "projects": "/home/ubuntu/Projects",
  "telegram-bot": "/home/ubuntu/Projects/claude-telegram-bot",
};
```

**Goal**: Remove this hardcoded map and rely entirely on auto-generated aliases from `project-aliases.ts`

**Impact**:
- `resolveProjectPath()` in config.ts (line 68)
- `/project` command handler in commands.ts (line 450)
- Need to ensure alias generation happens before project resolution

### 2. Auto-Generate Aliases for All Directories
**Current**: `getProjectAlias()` generates aliases on-demand when accessed

**Goal**:
- Generate aliases for ALL projects in common locations:
  - `/home/ubuntu/Projects/*`
  - `/home/ubuntu/.openclaw/workspace/*`
- Generate aliases for ALL subdirectories within each project (not just top-level)
- Store in `~/.claude/telegram-project-aliases.json`
- Use lowercase, case-sensitive directory names

**Implementation**:
- Create `scanAndGenerateAliases()` function to scan project directories
- Call during bot startup
- Create aliases like:
  - `aegir` → `/home/ubuntu/Projects/aegir`
  - `src` → `/home/ubuntu/Projects/aegir/src` (subdirectory)
  - `handlers` → `/home/ubuntu/Projects/claude-telegram-bot/src/handlers` (nested subdirectory)
- Handle conflicts with counters: `src-2`, `src-3`, etc.

### 3. @-Syntax for Project Routing
**Current**: Must use `/project <name>` to switch, then send message

**Goal**: Support `@<project> <message>` syntax to route directly:
- `@aegir fix the bug in main.ts`
- `@telegram-bot add new feature`
- Switch to that project's session and send the message in one step

**Implementation**:
- Add parser in `handlers/text.ts` before message processing (line 167)
- Extract project name from `@<project>` prefix
- Resolve alias to project path
- Switch to that project session
- Send remaining message to Claude
- Show project header in response

### 4. Project Headers on ALL Messages
**Current**: Headers only show once per conversation (line 234-241 in `handlers/text.ts`)

**Goal**: Show project header on EVERY message from Claude:
- Format:
  ```
  Project: <project-alias>

  <message content>
  ```
- Apply to:
  - Text responses (streaming)
  - Thinking blocks
  - Tool status messages
  - All message segments

**Implementation**:
- Modify `createStatusCallback()` in `handlers/streaming.ts`
- Prepend project header to all `statusType === "text"` callbacks (line 113)
- Prepend to `statusType === "thinking"` callbacks (line 101)
- Use current project alias from `sessionManager.getCurrentProject()`
- Only add header if `SHOW_PROJECT_HEADERS` is configured

### 5. `/projects` Command with Interactive Buttons
**Current**: Users must type `/project <name>` to switch projects

**Goal**: Add `/projects` command that displays all available projects with interactive buttons:
- Show list of all projects with buttons
- Include "➕ Create New Project" button
- Users click button to instantly switch to that project
- Visual, user-friendly interface for project navigation

**UI Layout**:
```
📁 Available Projects

<Interactive buttons>
[Project 1]  [Project 2]
[Project 3]  [Project 4]
[➕ Create New Project]
```

**Implementation**:
- Add `/projects` command handler in `src/handlers/commands.ts`
- Use Telegram inline keyboard (InlineKeyboardMarkup) for buttons
- Each project button includes:
  - Button text: project alias (e.g., "aegir", "telegram-bot")
  - Callback data: `project:<alias>` (e.g., `project:aegir`)
- Add callback query handler to process button clicks
- When button clicked:
  - Switch to selected project using existing project switching logic
  - Send confirmation: "✅ Switched to project: <alias>"
  - If "Create New Project" clicked, prompt for project details
- Organize buttons in rows (2-3 per row for better mobile UX)
- Sort projects alphabetically

**Technical Details**:
```typescript
// Button creation
const buttons = projects.map(project => ([{
  text: project.alias,
  callback_data: `project:${project.alias}`
}]));

// Add create button
buttons.push([{
  text: "➕ Create New Project",
  callback_data: "project:create"
}]);

// Send with inline keyboard
await ctx.reply("📁 Available Projects", {
  reply_markup: { inline_keyboard: buttons }
});

// Handle callback
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith("project:")) {
    const alias = data.replace("project:", "");
    // Switch project logic...
  }
});
```

## Implementation Steps

### Step 1: Enhance Alias System
**Files**: `src/project-aliases.ts`

1. Add `scanAndGenerateAliases()` function:
   - Scan `/home/ubuntu/Projects/` recursively
   - Scan `/home/ubuntu/.openclaw/workspace/` recursively
   - Generate alias for each directory (not files)
   - Use directory name, lowercase
   - Handle conflicts with counters
   - Save to `~/.claude/telegram-project-aliases.json`

2. Add `getProjectByAlias(alias: string): string | null`:
   - Reverse lookup: alias → path
   - Used for @-syntax resolution

3. Add `generateAliasesForProject(projectPath: string)`:
   - Generate aliases for all subdirectories within a project
   - Called when a new project is created/cloned

### Step 2: Remove Hardcoded Aliases
**Files**: `src/config.ts`, `src/handlers/commands.ts`

1. Remove `PROJECT_ALIASES` constant from `config.ts` (lines 52-58)

2. Update `resolveProjectPath()` to use `getProjectByAlias()`:
   ```typescript
   export function resolveProjectPath(projectName: string): string {
     // Try alias lookup first
     const aliasPath = getProjectByAlias(projectName);
     if (aliasPath) return aliasPath;

     // Try absolute path
     if (projectName.startsWith("/") || projectName.startsWith("~")) {
       return projectName.replace(/^~/, HOME);
     }

     // Try common locations...
   }
   ```

3. Update `/project` command handler to not reference `PROJECT_ALIASES`

### Step 3: Implement @-Syntax Parsing
**Files**: `src/handlers/text.ts`

1. Add parsing logic before authorization check (around line 167):
   ```typescript
   // Parse @project syntax
   let targetProject: string | null = null;
   const atMatch = message.match(/^@(\S+)\s+(.+)$/s);

   if (atMatch) {
     const [, projectAlias, remainingMessage] = atMatch;
     targetProject = projectAlias!;
     message = remainingMessage!;
   }
   ```

2. Use `targetProject` to override session selection (line 189-196):
   ```typescript
   const projectName = targetProject ||
     sessionManager.getLastUsed(chatId) ||
     getDefaultProjectName();
   ```

3. Show project switch notification when routing via @-syntax

### Step 4: Add Project Headers to All Messages
**Files**: `src/handlers/streaming.ts`

1. Pass project context to `createStatusCallback()`:
   ```typescript
   export function createStatusCallback(
     ctx: Context,
     state: StreamingState,
     projectAlias: string,  // NEW
     showHeaders: boolean   // NEW
   ): StatusCallback
   ```

2. Prepend header to text messages (line 119-134):
   ```typescript
   if (!state.textMessages.has(segmentId)) {
     const header = showHeaders ? `Project: ${projectAlias}\n\n` : "";
     const display = content.length > TELEGRAM_SAFE_LIMIT
       ? content.slice(0, TELEGRAM_SAFE_LIMIT) + "..."
       : content;
     const formatted = convertMarkdownToHtml(header + display);
     // ... send message
   }
   ```

3. Prepend header to thinking messages (line 101-109):
   ```typescript
   if (statusType === "thinking") {
     const header = showHeaders ? `Project: ${projectAlias}\n\n` : "";
     const preview = content.length > 500
       ? content.slice(0, 500) + "..."
       : content;
     const escaped = escapeHtml(preview);
     const thinkingMsg = await ctx.reply(
       `${header}🧠 <i>${escaped}</i>`,
       { parse_mode: "HTML" }
     );
     // ...
   }
   ```

4. Update `handlers/text.ts` to pass project context (line 250):
   ```typescript
   const projectAlias = getProjectAlias(projectSession.workingDir);
   const shouldShowHeader = /* existing logic */;
   let statusCallback = createStatusCallback(
     ctx,
     state,
     projectAlias,      // NEW
     shouldShowHeader   // NEW
   );
   ```

### Step 5: Implement `/projects` Command with Interactive Buttons
**Files**: `src/handlers/commands.ts`, `src/index.ts`

1. Add `/projects` command handler in `commands.ts`:
   ```typescript
   export async function handleProjectsCommand(ctx: Context) {
     const { loadProjectAliases } = await import("../project-aliases");
     const aliases = await loadProjectAliases();

     // Get all projects sorted alphabetically
     const projects = Object.entries(aliases)
       .sort(([a], [b]) => a.localeCompare(b));

     // Create inline keyboard buttons (2 per row)
     const buttons = [];
     for (let i = 0; i < projects.length; i += 2) {
       const row = [
         { text: projects[i][0], callback_data: `project:${projects[i][0]}` }
       ];
       if (projects[i + 1]) {
         row.push({
           text: projects[i + 1][0],
           callback_data: `project:${projects[i + 1][0]}`
         });
       }
       buttons.push(row);
     }

     // Add "Create New Project" button
     buttons.push([
       { text: "➕ Create New Project", callback_data: "project:create" }
     ]);

     await ctx.reply("📁 Available Projects\n\nSelect a project:", {
       reply_markup: { inline_keyboard: buttons }
     });
   }
   ```

2. Add callback query handler in `index.ts`:
   ```typescript
   // Handle inline keyboard button clicks
   bot.on("callback_query", async (ctx) => {
     const data = ctx.callbackQuery.data;

     if (data?.startsWith("project:")) {
       const alias = data.replace("project:", "");

       if (alias === "create") {
         // Prompt for new project creation
         await ctx.answerCbQuery();
         await ctx.reply(
           "To create a new project, use:\n" +
           "`/project <path>`\n\n" +
           "Example: `/project /home/ubuntu/Projects/my-new-app`",
           { parse_mode: "Markdown" }
         );
         return;
       }

       // Switch to selected project
       const chatId = ctx.chat?.id?.toString();
       if (!chatId) return;

       const { getProjectByAlias } = await import("./project-aliases");
       const projectPath = getProjectByAlias(alias);

       if (!projectPath) {
         await ctx.answerCbQuery("❌ Project not found");
         return;
       }

       // Use existing project switching logic
       sessionManager.setLastUsed(chatId, alias);
       await ctx.answerCbQuery();
       await ctx.reply(`✅ Switched to project: ${alias}`);
     }
   });
   ```

3. Register `/projects` command in bot setup:
   ```typescript
   bot.command("projects", handleProjectsCommand);
   ```

### Step 6: Startup Alias Scanning
**Files**: `src/index.ts`

1. Call `scanAndGenerateAliases()` during bot startup:
   ```typescript
   // After config loads, before bot starts
   import { scanAndGenerateAliases } from "./project-aliases";
   await scanAndGenerateAliases();
   console.log("Project aliases generated");
   ```

2. Optionally: Add `/refresh-aliases` command for manual re-scan

## Testing Plan

1. **Alias Generation**:
   - Start bot, verify `~/.claude/telegram-project-aliases.json` is created
   - Check all projects in `/home/ubuntu/Projects/` have aliases
   - Check subdirectories have aliases
   - Verify no duplicate aliases (conflicts handled)

2. **@-Syntax Routing**:
   - Test `@aegir list files` → routes to aegir project
   - Test `@telegram-bot show config` → routes to telegram-bot project
   - Verify session switches correctly
   - Verify response comes from correct project

3. **Project Headers**:
   - Send message to project
   - Verify EVERY response has header (thinking, text, tool messages)
   - Test with `SHOW_PROJECT_HEADERS=always`
   - Test with `SHOW_PROJECT_HEADERS=multiple`
   - Test with `SHOW_PROJECT_HEADERS=never`

4. **Hardcoded Alias Removal**:
   - Verify `/project aegir` still works without hardcoded aliases
   - Verify `/project home` still works
   - Verify auto-generated aliases work for all projects

5. **`/projects` Interactive Buttons**:
   - Send `/projects` command
   - Verify all projects displayed as buttons (2 per row)
   - Verify "➕ Create New Project" button appears
   - Click a project button → verify instant switch
   - Verify confirmation message: "✅ Switched to project: <alias>"
   - Click "Create New Project" → verify helpful prompt
   - Test with many projects (10+) → verify scrollable list
   - Test on mobile → verify buttons are tap-friendly

## Edge Cases to Handle

1. **Alias conflicts**: Multiple directories named `src` → `src`, `src-2`, `src-3`
2. **@-syntax with spaces**: `@my-project message` vs `@my project message`
3. **Header formatting**: Ensure header doesn't break HTML parsing
4. **Long project names**: Truncate if needed
5. **Empty messages**: `@project` with no message → show error
6. **Invalid alias**: `@nonexistent` → show error, suggest valid aliases
7. **No projects available**: `/projects` with empty project list → show helpful message
8. **Too many projects**: More than 100 buttons → paginate or limit display
9. **Button callback timeout**: Telegram callback queries expire after 30 seconds
10. **Concurrent button clicks**: Multiple users clicking buttons simultaneously

## Configuration

Add to `.env`:
```bash
# Project header display: always, never, multiple
SHOW_PROJECT_HEADERS=always
```

## Migration Notes

**Breaking Changes**: None! All changes are backward compatible:
- Existing `/project` command still works
- Hardcoded aliases will be auto-generated on startup
- Header behavior configurable via existing `SHOW_PROJECT_HEADERS`

**New Features**:
- @-syntax is additive
- Auto-generated aliases augment manual project switching
- Headers are opt-in via config

## Files to Modify

1. `src/project-aliases.ts` - Add scanning & reverse lookup
2. `src/config.ts` - Remove hardcoded aliases, update resolution
3. `src/handlers/text.ts` - Add @-syntax parsing
4. `src/handlers/streaming.ts` - Add headers to all messages
5. `src/handlers/commands.ts` - Add `/projects` command handler
6. `src/index.ts` - Call alias scan on startup + callback query handler

## Estimated Effort

- Step 1 (Enhance aliases): 1-2 hours
- Step 2 (Remove hardcoded): 30 minutes
- Step 3 (@-syntax): 1 hour
- Step 4 (Headers): 1 hour
- Step 5 (`/projects` interactive buttons): 1-1.5 hours
- Step 6 (Startup scan): 30 minutes
- Testing: 1.5 hours

**Total**: ~6.5-8 hours

## Success Criteria

✅ No hardcoded `PROJECT_ALIASES` in code
✅ All projects in `/home/ubuntu/Projects/` have auto-generated aliases
✅ All subdirectories have aliases (lowercase, from directory name)
✅ `@project message` syntax routes to correct project
✅ Every message (thinking, text, tool) shows project header when configured
✅ `/projects` command displays all projects with interactive buttons
✅ Clicking a project button instantly switches to that project
✅ "➕ Create New Project" button provides helpful creation instructions
✅ `/project` command still works as before
✅ Backward compatible with existing usage
