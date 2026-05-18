# Software Requirements Document
## Claude Code VS Code Extension
**Version:** 1.0 — Draft  
**Type:** Personal Use / Local `.vsix` Install  
**Status:** Pre-development

---

## Table of Contents

1. [Overview](#1-overview)
2. [Guiding Principles](#2-guiding-principles)
3. [System Architecture](#3-system-architecture)
4. [Feature Roadmap](#4-feature-roadmap)
5. [V1 Features — Detailed Requirements](#5-v1-features--detailed-requirements)
   - 5.1 Chat Participant
   - 5.2 Inline Completions
   - 5.3 Code Actions
   - 5.4 Slash Commands
   - 5.5 Model Switcher
   - 5.6 YOLO Mode
   - 5.7 Thinking Budget
   - 5.8 Drag-and-Drop Context
   - 5.9 Usage Tracking
6. [V2 Features — Scoped Requirements](#6-v2-features--scoped-requirements)
7. [UI/UX Specification](#7-uiux-specification)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Technical Constraints & Environment](#9-technical-constraints--environment)
10. [Error Handling Specification](#10-error-handling-specification)
11. [File & Storage Layout](#11-file--storage-layout)
12. [CLI Process Management](#12-cli-process-management)
13. [Open Questions](#13-open-questions)

---

## 1. Overview

### 1.1 Purpose

This document defines the requirements for a personal VS Code extension that wraps Anthropic's `claude` CLI (Claude Code) as a backend to deliver a native, Copilot-like AI coding assistant experience. The extension is for personal use only, installed locally as a `.vsix` file, and will not be published to the VS Code Marketplace.

### 1.2 Goals

- Provide a first-class VS Code chat experience via the native **Chat Participant API**, with no WebViews.
- Delegate all AI reasoning, tool use, and code generation to the locally installed `claude` CLI process.
- Support inline completions, code actions, and a rich chat interface using only VS Code native APIs.
- Stay fully within the user's existing Claude Code subscription — no separate API key required.

### 1.3 Out of Scope

- Marketplace publication
- Multi-user or team features
- Any UI built with WebViews
- Git diff context injection
- Any network calls beyond what the `claude` CLI itself makes

---

## 2. Guiding Principles

| Principle | Description |
|-----------|-------------|
| **Native first** | Use VS Code APIs (`vscode.chat`, `vscode.languages`, `vscode.workspace`) wherever possible. No custom panels or WebViews. |
| **CLI as the brain** | The extension is a thin orchestration layer. All intelligence lives in the `claude` CLI process. |
| **One session per workspace** | Each VS Code workspace folder gets its own persistent Claude CLI process, scoped and isolated. |
| **Explicit over automatic** | Project indexing, model switching, and process restarts are always user-initiated. No silent background activity. |
| **Auditable edits** | All file changes are auto-applied but immediately auditable via a post-edit change summary, with full undo support. |

---

## 3. System Architecture

### 3.1 Component Overview

```
┌─────────────────────────────────────────────────────────┐
│                     VS Code Host                        │
│                                                         │
│  ┌────────────────┐   ┌──────────────────────────────┐  │
│  │  Chat Panel    │   │    Editor / Document APIs    │  │
│  │ (Participant   │   │  (InlineCompletion, CodeAction│  │
│  │    API)        │   │   WorkspaceEdit, Diagnostics) │  │
│  └───────┬────────┘   └──────────────┬───────────────┘  │
│          │                           │                   │
│  ┌───────▼───────────────────────────▼───────────────┐  │
│  │              Extension Core                        │  │
│  │                                                    │  │
│  │  ┌──────────────┐  ┌────────────┐  ┌───────────┐  │  │
│  │  │ ChatHandler  │  │Completion  │  │  Action   │  │  │
│  │  │              │  │  Provider  │  │ Provider  │  │  │
│  │  └──────┬───────┘  └─────┬──────┘  └─────┬─────┘  │  │
│  │         │                │               │         │  │
│  │  ┌──────▼────────────────▼───────────────▼──────┐  │  │
│  │  │            Process Manager                    │  │  │
│  │  │  (one claude CLI process per workspace)       │  │  │
│  │  └──────────────────────┬────────────────────────┘  │  │
│  │                         │                           │  │
│  │  ┌──────────────────────▼────────────────────────┐  │  │
│  │  │           Context Assembler                    │  │  │
│  │  │  (selection > open file > project-context.md) │  │  │
│  │  └───────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
│                            │                             │
└────────────────────────────┼─────────────────────────────┘
                             │ child_process.spawn()
                    ┌────────▼─────────┐
                    │   claude  CLI    │
                    │  (system PATH)   │
                    └──────────────────┘
```

### 3.2 Data Flow — Chat Turn

```
User types message in Chat Panel
        │
        ▼
Context Assembler builds payload:
  1. project-context.md (if exists)
  2. Active selection text (priority 1)
     OR open file content (priority 2)
  3. Drag-and-dropped file/folder references
  4. Conversation history
  5. Current model + YOLO mode + thinking budget flags
        │
        ▼
Process Manager writes to claude CLI stdin (JSON)
        │
        ▼
Claude CLI streams response chunks to stdout
        │
        ▼
ChatHandler parses stream:
  - Text chunks → streamed to Chat panel
  - File edit operations → applied via WorkspaceEdit
  - Tool use blocks → acknowledged in UI
        │
        ▼
Post-edit summary shown in Chat panel
Usage counters updated
```

---

## 4. Feature Roadmap

### V1 — Core Experience

| # | Feature | Priority |
|---|---------|----------|
| 1 | Chat Participant (`@claude`) | Critical |
| 2 | Inline Completions | High |
| 3 | Code Actions (lightbulb menu) | High |
| 4 | Slash Commands (`/clear`, `/index`, etc.) | High |
| 5 | Model Switcher dropdown | High |
| 6 | YOLO Mode toggle | High |
| 7 | Thinking Budget selector | High |
| 8 | Drag-and-drop file/folder context | High |
| 9 | Usage Tracking panel | Medium |

### V2 — Enhanced Experience

| # | Feature | Priority |
|---|---------|----------|
| 10 | Project Indexer (`.claude/project-context.md` generator) | High |
| 11 | Conversation Persistence (survives VS Code restart) | High |

---

## 5. V1 Features — Detailed Requirements

---

### 5.1 Chat Participant

#### 5.1.1 Registration

- The extension registers a VS Code Chat Participant with handle `@claude`.
- The participant appears in the native VS Code Chat panel (no WebView).
- Requires VS Code ≥ 1.90.

#### 5.1.2 Context Assembly (per turn)

Context is assembled in the following priority order and sent to the CLI:

| Priority | Source | Condition |
|----------|--------|-----------|
| Always | `.claude/project-context.md` | Prepended if file exists in workspace root |
| 1 | Active text selection | If user has text selected in the editor |
| 2 | Full content of the currently open file | If no selection, but a file is open |
| 3 | Drag-and-dropped files/folders | Always appended if provided (see §5.8) |

Git diff is explicitly **excluded** from context under all circumstances.

#### 5.1.3 File Editing Behavior

- When Claude outputs file edits, the extension applies them **immediately** via `vscode.workspace.applyEdit()` (WorkspaceEdit API).
- After all edits in a turn are applied, the chat response includes a **change summary** listing:
  - Which files were modified
  - Number of lines added / removed per file
  - A "Review changes" link that opens VS Code's native diff view for each changed file
- All applied edits are **fully undoable** via Ctrl+Z / Cmd+Z (VS Code's built-in undo stack).
- No separate "Accept/Reject" step is required — edits are live on apply.

#### 5.1.4 Response Rendering

- Claude's text responses render as **markdown** inside the Chat panel using VS Code's built-in markdown renderer.
- Code blocks include language syntax highlighting.
- Code blocks that correspond to file edits include a native **"View Diff"** button.
- Responses stream progressively — the user sees tokens as they arrive, not after the full response.

#### 5.1.5 Conversation Model

- One conversation thread per workspace (not per session).
- In V1, conversation history is **in-memory only** (does not survive VS Code restart — persistence is a V2 feature).
- The conversation can be cleared at any time via the `/clear` slash command (see §5.4).

#### 5.1.6 Mid-Response Cancellation

- If the user cancels a response (e.g., presses Escape or clicks Stop):
  - The CLI stdin receives a cancel/interrupt signal.
  - Any partial file edits already applied **are rolled back** via WorkspaceEdit undo.
  - The chat panel shows a "Response cancelled — changes reverted" notice.

---

### 5.2 Inline Completions

#### 5.2.1 Trigger Behavior

- Completions fire **automatically** on typing pause (debounced, similar to GitHub Copilot).
- Suggested debounce delay: 400–600ms after the user stops typing.
- A subtle loading spinner or progress indicator is shown in the status bar while the CLI is processing.

#### 5.2.2 Scope

- Completions are active for **all file types and languages** — no language filtering.

#### 5.2.3 Context Sent

- The current file's content up to the cursor position (prefix).
- The current file's content after the cursor (suffix), for fill-in-the-middle style completion.
- File path and language ID are included as metadata.

#### 5.2.4 Latency

- No timeout is imposed on completions. The user accepts the latency.
- If a new completion is triggered before the previous one resolves, the previous request is cancelled.

#### 5.2.5 Acceptance

- Completions appear as **ghost text** (VS Code `InlineCompletionItem`).
- Accepted with **Tab**.
- Dismissed with **Escape** or by continuing to type.

---

### 5.3 Code Actions

#### 5.3.1 Trigger

- Code actions appear in the VS Code **lightbulb menu** and the **right-click context menu** when code is selected.
- Registered via `vscode.languages.registerCodeActionsProvider` for all languages (`*`).

#### 5.3.2 Available Actions

| Action Label | Behavior |
|---|---|
| **Claude: Explain this** | Sends selected code to Chat panel as a new turn: "Explain this code: `[selection]`". Response appears in Chat. No file edits. |
| **Claude: Fix this** | Sends selection + any active diagnostics (errors/warnings) to Claude. Edits applied per §5.1.3. |
| **Claude: Refactor this** | Sends selection with refactor instruction. Edits applied per §5.1.3. |
| **Claude: Add tests** | Claude generates unit tests and creates or appends to an appropriate test file. Edits applied per §5.1.3. |
| **Claude: Add documentation** | Claude adds docstrings, JSDoc, or inline comments to selected code. Edits applied per §5.1.3. |
| **Claude: Find bugs** | Claude audits the selection and responds with findings in the Chat panel. No auto-edits — findings listed as text with optional "Fix" buttons per issue. |
| **Claude: Custom prompt…** | Opens a VS Code `InputBox` (native quick input). User types a freeform instruction. Sent to Claude with the selection as context. |

#### 5.3.3 Context for Code Actions

- The selected code is always the primary context.
- The surrounding file content (N lines before/after selection) is included as secondary context.
- For "Fix this": active VS Code diagnostics for the selection range are appended.

---

### 5.4 Slash Commands

Slash commands are typed directly in the Chat input field and are processed by the extension before being forwarded to the CLI.

| Command | Behavior |
|---------|----------|
| `/clear` | Clears the current conversation history (in-memory). Sends a fresh session signal to the CLI process. Shows "Conversation cleared" confirmation in the chat panel. |
| `/index` | Triggers the Project Indexer (see §6.1). In V1, this command is registered but shows a "Project indexing is a V2 feature" notice if the indexer is not yet implemented. *(Alternatively, a minimal V1 indexer can be shipped — see §6.1 note.)* |
| `/fix` | Runs "Claude: Fix this" on the currently open file (no selection required — full file is sent). |
| `/explain` | Runs "Claude: Explain this" on the currently open file. |
| `/help` | Displays a list of available slash commands in the chat panel. |

---

### 5.5 Model Switcher

#### 5.5.1 Location

- A **dropdown selector** is displayed inside the Chat panel header area (using VS Code's native chat UI surface, or as a status bar item if the Chat API does not support header widgets).
- The currently selected model is always visible.

#### 5.5.2 Available Models

The model list is maintained as a **static configuration** in the extension settings (editable via `settings.json`) so it can be updated without a code change. Default list at launch:

- `claude-opus-4-5`
- `claude-sonnet-4-5` *(default)*
- `claude-haiku-4-5`

#### 5.5.3 Behavior

- Changing the model takes effect on the **next chat turn**.
- The selected model is persisted in VS Code workspace state so it survives restarts.
- The selected model is passed to the CLI process via the appropriate CLI flag or argument.

---

### 5.6 YOLO Mode

#### 5.6.1 Definition

YOLO Mode, when enabled, instructs the Claude CLI to **skip all confirmation prompts** — Claude proceeds with file edits, shell commands, and tool use without asking for approval. This maps to Claude Code's `--dangerously-skip-permissions` flag (or equivalent).

#### 5.6.2 Toggle

- A clearly labeled **"YOLO Mode"** toggle is accessible from:
  - The Chat panel toolbar
  - The VS Code status bar (persistent indicator)
  - The Command Palette (`Claude: Toggle YOLO Mode`)
- When YOLO Mode is **ON**, a persistent, visually distinct indicator (e.g., a red ⚡ badge) appears in the status bar.
- The toggle state persists in workspace state.

#### 5.6.3 Behavior

- When ON: the `--dangerously-skip-permissions` flag (or CLI equivalent) is passed to the Claude process.
- When OFF: the CLI runs in default interactive mode, surfacing any confirmation prompts as text in the Chat panel.

---

### 5.7 Thinking Budget

#### 5.7.1 Definition

For models that support extended thinking (e.g., Claude Opus), the user can select how much "thinking" the model performs before responding. This maps to a CLI budget token parameter.

#### 5.7.2 Selector Options

| Label | Budget Tokens (approx.) |
|-------|------------------------|
| Low | 1,024 |
| Medium | 4,096 |
| High | 10,000 |
| Max | 32,000 |

#### 5.7.3 Behavior

- The selector appears alongside the Model Switcher (same UI surface).
- If the selected model **does not support extended thinking**, the selector is **greyed out** with a tooltip: "Extended thinking not available for this model."
- The budget value is passed to the CLI via the appropriate flag.
- Selected value persists in workspace state.

---

### 5.8 Drag-and-Drop File/Folder Context

#### 5.8.1 Behavior

- The user can drag files or folders from the VS Code Explorer sidebar (or the OS file manager) and **drop them into the Chat input field**.
- Dropped items appear as **reference chips** or inline tags in the chat input (e.g., `📄 src/utils.ts`, `📁 src/components/`).
- Multiple items can be dropped in a single turn.

#### 5.8.2 Context Inclusion

- **Dropped file**: the full file content is read and appended to the context payload sent to the CLI.
- **Dropped folder**: a recursive file listing of the folder is included, plus the content of all files within it (subject to a configurable size cap, e.g., 500KB total per turn, to avoid overwhelming the context window).
- Dropped items are **additive** to the existing context priority chain (§5.1.2); they do not replace the open file or selection.

#### 5.8.3 UI

- Dropped references are shown in the chat input area before send.
- Each reference has an **× button** to remove it before sending.
- After the message is sent, the reference chips are shown inline in the conversation history for that turn.

---

### 5.9 Usage Tracking

#### 5.9.1 Purpose

Provide visibility into Claude API token/request consumption so the user can monitor usage against their subscription limits.

#### 5.9.2 Data Sources

- Token counts are parsed from the CLI's output (the CLI typically reports usage metadata per response).
- Timestamps are recorded locally by the extension for session and rolling window calculations.
- All data is stored locally in VS Code global storage — nothing is sent to any external service.

#### 5.9.3 Displayed Metrics

| Metric | Description |
|--------|-------------|
| **Session tokens used** | Total tokens (input + output) consumed since the current VS Code session started |
| **Daily tokens used** | Rolling 24-hour total |
| **Weekly tokens used** | Rolling 7-day total |
| **Session requests** | Number of chat turns / completions in this session |

#### 5.9.4 UI

- Accessible via:
  - Command Palette: `Claude: Show Usage`
  - Status bar click on a persistent usage indicator
- Displayed in a **VS Code panel or Quick Pick overlay** (no WebView):
  - A text-based summary of the metrics above
  - A simple **ASCII/Unicode bar chart** or progress-bar representation of daily and weekly usage
  - A configurable **limit** the user can set (e.g., "my daily limit is 100K tokens") against which usage is shown as a percentage
- The UI updates after each completed chat turn or completion.

> **Note:** If the Claude CLI does not expose token usage in its stdout output, this feature will display request counts only, with a notice explaining token data is unavailable.

---

## 6. V2 Features — Scoped Requirements

### 6.1 Project Indexer

#### 6.1.1 Trigger

- Manually triggered via:
  - Command Palette: `Claude: Index Project`
  - Slash command `/index` in the Chat panel

#### 6.1.2 Output

- Generates `.claude/project-context.md` in the workspace root.
- The file is **committed to the repo** (not hidden from git), so it can be reviewed, edited, and versioned.

#### 6.1.3 Content

The generated document captures:

| Section | Content |
|---------|---------|
| **Project overview** | Name, description inferred from `package.json`, `pyproject.toml`, `README.md`, etc. |
| **Tech stack** | Detected languages, frameworks, and tools |
| **Directory structure** | Annotated folder tree (top 2–3 levels) with purpose of each key directory |
| **Key files** | Entry points, config files, main modules — with one-line descriptions |
| **Coding conventions** | Naming patterns, file organization patterns observed in the codebase |
| **Dependencies** | Major dependencies listed from lock files or manifests |

#### 6.1.4 Generation Process

- Claude CLI is given a structured prompt with a recursive file listing and selected file contents.
- The CLI generates the markdown document.
- The extension writes it to `.claude/project-context.md`.
- A success notification links to the created file.

#### 6.1.5 Refresh

- No automatic refresh. Re-running `Claude: Index Project` overwrites the existing file.
- The user can manually edit `.claude/project-context.md` at any time — it is a plain markdown file.

---

### 6.2 Conversation Persistence

#### 6.2.1 Storage

- Conversation history (per workspace) is serialized to VS Code's **global storage** (`ExtensionContext.globalStorageUri`) as JSON.
- Key: `conversations/{workspaceFolderHash}.json`

#### 6.2.2 Behavior

- On workspace open: the extension loads the saved conversation and restores it in the Chat panel.
- The Claude CLI session is initialized with the full conversation history replayed so Claude has context continuity.
- On `/clear`: history is deleted from disk and the in-memory state is reset.

#### 6.2.3 Limits

- A configurable maximum history length (e.g., last 50 turns) is enforced to prevent unbounded growth.
- Older turns beyond the limit are pruned from disk automatically.

---

## 7. UI/UX Specification

This section defines the precise visual layout and interaction design for every user-facing surface of the extension. All UI is implemented using native VS Code APIs — no WebViews.

---

### 7.1 Chat Panel

- The chat panel uses VS Code's native Chat Participant API and renders as a standard VS Code panel.
- **Placement is user-controlled** — no default position is enforced. The user may dock it in the primary sidebar, secondary sidebar, bottom panel, or float it as they prefer.
- The panel behaves identically regardless of placement.

#### 7.1.1 Chat Panel Layout (top to bottom)

```
┌─────────────────────────────────────────────┐
│  @claude          [⚙ Model] [🧠 Budget]     │  ← Toolbar
├─────────────────────────────────────────────┤
│                                             │
│   Conversation history                      │  ← Scrollable message area
│   (streamed markdown, code blocks,          │
│    change summaries)                        │
│                                             │
├─────────────────────────────────────────────┤
│  📄 src/utils.ts ×   🖼 screenshot.png ×   │  ← Attachment bar (visible only when items present)
├─────────────────────────────────────────────┤
│  Type a message...                    [Send]│  ← Input field
└─────────────────────────────────────────────┘
```

#### 7.1.2 Toolbar

- Two icon buttons sit in the chat panel toolbar to the right of the `@claude` title:
  - **⚙ Model** — clicking opens a VS Code Quick Pick list of available models. The currently active model is shown with a checkmark. Selecting a new model takes effect on the next turn.
  - **🧠 Budget** — clicking opens a Quick Pick with four options: Low / Medium / High / Max. Greyed out with tooltip if the current model does not support extended thinking.
- Toolbar buttons show their current value as a label on hover (e.g., "Model: claude-sonnet-4-5").

#### 7.1.3 Attachment Bar

- Appears as a horizontal row **above the text input**, only when at least one item has been dropped.
- Each attachment is shown as a small chip with an icon and filename:
  - `📄 filename.ts ×` for files
  - `📁 foldername/ ×` for folders
  - `🖼 image.png ×` for images
- The **×** button on each chip removes it from the context before sending.
- Supports drag-and-drop from VS Code Explorer and the OS file manager.
- Images are accepted in addition to code files and folders.
- If a dropped folder exceeds the 500KB size cap, the chip displays a warning indicator: `📁 foldername/ ⚠️` with a tooltip explaining only the file listing will be sent.
- After the message is sent, the attachment bar clears and the chips are shown as part of that turn's history in the conversation.

#### 7.1.4 Post-Edit Change Summary

After Claude applies file edits, a summary block appears in the chat as Claude's response footer:

```
📝 Changes applied:
  ✏️ src/utils.ts        +12  -4   [View Diff]
  ✏️ src/index.ts        +3   -1   [View Diff]
```

- "View Diff" opens VS Code's native diff editor for that file.
- All changes are undoable via Ctrl+Z / Cmd+Z.

#### 7.1.5 Response Rendering

- Claude's responses render as **streamed markdown** — tokens appear progressively as they arrive.
- Code blocks include language syntax highlighting.
- Code blocks linked to file edits include a **"View Diff"** button.

---

### 7.2 Status Bar

The status bar contains a dedicated **Claude section** with three always-visible items, grouped together on the right side of the status bar:

```
... [⚡ YOLO]  [● Claude]  [12.4k tokens]  ...
```

#### 7.2.1 YOLO Mode Indicator

| State | Appearance |
|-------|------------|
| OFF | Not shown (no clutter when inactive) |
| ON | `⚡ YOLO` in **orange text** |

- Clicking the indicator toggles YOLO mode on/off.
- Tooltip: "YOLO Mode ON — Claude will skip all confirmation prompts. Click to disable."

#### 7.2.2 Claude Status Indicator

| State | Appearance |
|-------|------------|
| Idle | `● Claude` in default status bar text color |
| Thinking (chat or completion) | `⟳ Claude` with a spinning animation |
| Error / crashed | `✕ Claude` in red text |

- Clicking the status indicator opens VS Code's Output panel filtered to the `Claude Code (Debug)` channel.

#### 7.2.3 Token Counter

- Displays the **rolling daily token usage** as a compact number: e.g., `12.4k tokens`.
- Updates after each completed chat turn or inline completion.
- Clicking opens a VS Code Quick Pick overlay showing:
  - Session tokens used
  - Daily tokens used (rolling 24h)
  - Weekly tokens used (rolling 7 days)
  - Session request count
  - A configurable daily limit shown as `12.4k / 100k (12%)`
- If token data is unavailable from the CLI, displays `N requests` instead.

---

### 7.3 Inline Completions

- Completions appear as **ghost text** at the cursor using VS Code's `InlineCompletionItem` API.
- No in-editor loading indicator — the status bar Claude spinner is the only signal that a completion is being fetched.
- Ghost text is accepted with **Tab**, dismissed with **Escape** or by continuing to type.
- Only one completion request is active at a time — a new trigger cancels any in-flight request.

---

### 7.4 Code Actions (Lightbulb / Right-Click Menu)

- Actions appear under a **"Claude"** submenu in both the lightbulb menu and the right-click context menu when code is selected.
- Each action is prefixed with `Claude:` (e.g., `Claude: Explain this`, `Claude: Fix this`).
- "Claude: Custom prompt…" opens a native VS Code `InputBox` with placeholder: "Describe what you'd like Claude to do with this selection…"
- Actions that produce chat responses (Explain, Find bugs) open/focus the Chat panel automatically.
- Actions that produce edits apply them silently and show the post-edit summary in the Chat panel (§7.1.4).

---

### 7.5 Visual Design Principles

| Principle | Detail |
|-----------|--------|
| **Native feel** | All UI uses VS Code's built-in color tokens — respects the user's active theme (dark, light, high contrast) automatically. No custom color overrides. |
| **Minimal footprint** | Status bar items are compact and text-only. The attachment bar is hidden when empty. |
| **No modal interruptions** | The only modal dialogs are timeout prompts (§10) and the YOLO toggle confirmation. Everything else is inline or in the status bar. |
| **Keyboard accessible** | All actions reachable via Command Palette. Model switcher and budget selector are Quick Pick (keyboard-navigable). |

---

## 8. Non-Functional Requirements  

### 7.1 Performance

| Concern | Requirement |
|---------|-------------|
| Chat response start | First token must begin streaming within 3s of message send (excluding Claude's own processing time) |
| Inline completion trigger | Completions dispatched to CLI within 100ms of debounce expiry |
| Edit application | WorkspaceEdit for up to 10 files must apply within 500ms |
| Extension activation | Extension must activate within 1s of VS Code window focus |

### 7.2 Reliability

- The extension must **not crash the VS Code host** under any circumstances, including CLI process crashes.
- All exceptions from CLI communication are caught and surfaced as user-facing notifications, never as uncaught exceptions.

### 7.3 Security

- No API keys are handled or stored by the extension — authentication is entirely delegated to the `claude` CLI.
- No user code or conversation data is sent anywhere other than the local `claude` CLI process.
- The extension requests only the VS Code permissions it actually uses.

### 7.4 Cross-Platform

- Full functionality on **macOS, Windows, and Linux**.
- CLI process spawning uses Node.js `child_process.spawn` with `shell: true` on Windows to handle PATH resolution correctly.
- All file paths are handled with `path.join` / `vscode.Uri` — no hardcoded separators.

---

## 9. Technical Constraints & Environment

| Constraint | Value |
|------------|-------|
| VS Code minimum version | 1.90 |
| Claude CLI discovery | System `PATH` — no hardcoded paths |
| Extension runtime | Node.js (version managed by VS Code toolchain) |
| Distribution | Local `.vsix` install only |
| Marketplace publication | None |
| API used | `vscode.chat` (Participant), `vscode.languages` (Completions, Code Actions), `vscode.workspace` (WorkspaceEdit), `vscode.window` (Notifications, StatusBar) |
| WebViews | **Not used under any circumstances** |
| External network calls | None from the extension itself — only from the `claude` CLI |

---

## 10. Error Handling Specification

| Scenario | Detection | User Response | Automated Action |
|----------|-----------|---------------|-----------------|
| `claude` CLI not found on PATH | `spawn` ENOENT error | One-time setup notification with link to install instructions | None — user must install |
| CLI response timeout | No stdout activity for 60 seconds | Modal dialog: "Claude is taking longer than expected. Wait or Cancel?" | If Cancel: roll back partial edits, terminate request |
| User cancels mid-response | Escape / Stop button | "Response cancelled — changes reverted" notice in chat | Roll back all WorkspaceEdit changes from this turn |
| CLI process crashes mid-session | Process `exit` event with non-zero code | Notification: "Claude process crashed. Restart?" with Restart button | None — wait for explicit user action |
| CLI process exits unexpectedly | Process `close` event | Same as crash above | None |
| Drag-and-drop folder too large | Total content exceeds size cap | Inline warning in chat input: "Folder exceeds 500KB limit — only file listing will be included" | Include listing only, skip file contents |
| CLI not authenticated | CLI stdout contains auth error text | Notification: "Claude CLI is not authenticated. Run `claude login` in your terminal." | None |
| WorkspaceEdit fails to apply | `applyEdit` returns false | Error notice in chat: "Some edits could not be applied — check the Problems panel." | None |

---

## 11. File & Storage Layout

```
{workspace root}/
└── .claude/
    └── project-context.md        # V2: Project index (user-editable, committed to git)

{VS Code globalStorageUri}/       # Hidden from workspace, managed by VS Code
└── conversations/
    └── {workspaceFolderHash}.json # V2: Persisted conversation history

{VS Code workspaceState}/         # Per-workspace key-value store
└── selectedModel                 # Active model choice
└── yoloMode                      # YOLO mode on/off
└── thinkingBudget                # Selected budget level
└── usageData                     # Token/request usage counters
```

---

## 12. CLI Process Management

### 11.1 Lifecycle

| Event | Action |
|-------|--------|
| Workspace opens | Spawn one `claude` CLI process for this workspace root as working directory |
| Message sent | Write request to CLI stdin |
| Response received | Read from CLI stdout, parse, render |
| `/clear` command | Send session reset signal (or restart process with empty history) |
| Workspace closes | `SIGTERM` sent to CLI process; 3s grace period; then `SIGKILL` |
| VS Code quits | Same as workspace close, applied to all active processes |
| Process crashes | Notify user, do not auto-restart |

### 11.2 Process Isolation

- Each workspace folder spawns its **own** CLI process.
- Processes do not share state.
- The working directory of each CLI process is set to the workspace root folder.

### 11.3 Communication Protocol

- **Input**: JSON payloads written to `stdin`, following the Claude Code CLI's headless/non-interactive protocol.
- **Output**: Streamed from `stdout`; parsed as JSON lines or the CLI's native streaming format.
- **Errors**: `stderr` is captured and logged to VS Code's output channel (`Claude Code (Debug)`).

### 11.4 CLI Invocation Flags

The following flags are composed dynamically per request:

| Flag | When |
|------|------|
| `--model {modelId}` | Always — from selected model (§5.5) |
| `--dangerously-skip-permissions` | When YOLO Mode is ON (§5.6) |
| `--budget-tokens {n}` | When thinking budget is set and model supports it (§5.7) |
| `--no-color` | Always — to prevent ANSI codes in stdout |

> **Note:** Exact flag names must be verified against the `claude` CLI's current `--help` output during implementation, as they may differ from the above.

---

## 13. Open Questions

These items require investigation or decisions during implementation:

| # | Question | Impact |
|---|----------|--------|
| 1 | Does the `claude` CLI support a persistent interactive session via stdin/stdout, or does it only support one-shot invocations? | Determines process communication architecture |
| 2 | What exact format does the CLI use for streaming output — JSON lines, plain text, SSE? | Determines the stdout parser implementation |
| 3 | Does the CLI expose token usage counts in its stdout? | Determines whether §5.9 shows tokens or only request counts |
| 4 | What is the exact CLI flag for YOLO / skip-permissions mode? | §5.6 implementation |
| 5 | What is the exact CLI flag for thinking budget? | §5.7 implementation |
| 6 | Does the VS Code Chat Participant API (≥1.90) support custom header widgets (for model switcher dropdown)? Or must it live in the status bar? | §5.5 UI placement |
| 7 | Is there a size limit on `vscode.workspace.applyEdit()` for large multi-file edits? | §5.1.3 reliability |

---

*End of Document*

**Next steps:** Resolve Open Questions (§12) by running `claude --help` and reviewing the VS Code Chat Participant API docs, then begin scaffolding the extension with `yo code`.
