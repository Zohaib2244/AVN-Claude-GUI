# SRD — AVN Chat → VS Code Chat Participant API port

**Branch:** `feat/vscode-chat-api`
**Status:** Spec only (no implementation yet)
**Goal:** Replace the custom sidebar webview with a `vscode.ChatParticipant` registered as `@avn`, delegating UI / sessions / file refs / etc. to VS Code while keeping our CLI backends (Claude Code, OpenCode) and the OpenCode model browser.

---

## 1. Why we're doing this

The current extension reimplements ~3,500 LOC of UI (`media/chat.js`, `media/chat.css`, half of `src/claudeViewProvider.ts`). Every chat affordance — file picker, image paste, sessions, slash commands, model picker, change bar, symbol refs — is hand-written. Each one has edge cases (the file-picker truncation, the `currentFileIncluded` reset, the OpenCode-debug vs Claude-debug channel confusion). We're spending time on UI plumbing instead of the backends.

VS Code 1.94+ exposes a mature `ChatParticipant` API. Chat panel UI, message bubbles, markdown rendering, file/image attachments, sessions, history, streaming, and slash-command dispatch are all built in. We register one participant and write a handler. UI work disappears.

## 2. Hard constraint: CLI backends can't use `response.textEdit()`

The chat API's headline feature — native inline diff with per-hunk Keep/Undo, streamed via `response.textEdit(target, edits)` — requires **we** apply the edits. Our backends (`claude run`, `opencode run`) apply edits *themselves* via their own tool execution. We see file changes after the fact via `git diff`; we never have the chance to call `textEdit()`.

To get native textEdit() UX we'd need to bypass the CLIs and call the Anthropic SDK directly, re-implementing the entire agent loop (Read/Write/Edit/Bash tools). That's a different project. **For this port, we accept the trade-off and use VS Code's built-in diff editor as the fallback** (see §4.4).

## 3. Architecture

### 3.1 Participant

- **One participant**: `@avn`
- Registered via `vscode.chat.createChatParticipant('avn', handler)`
- Backend selection (Claude vs OpenCode) is a status-bar toggle, not a separate participant
- VS Code remembers the last-used participant in a session — user types `@avn` once per session

### 3.2 Modules to delete

| File | Reason |
|---|---|
| `media/chat.js` | UI moves to VS Code Chat panel |
| `media/chat.css` | Ditto |
| `media/icons/` | Ditto |
| `src/claudeViewProvider.ts` | Replaced by a thin chat-participant handler |
| `src/sessionManager.ts` | Chat API has built-in session management |
| `src/contextAssembler.ts` | `#file` / `#selection` are built-in chat references |
| `src/usageTracker.ts` | Token tracking dropped per scope decision |
| `src/hunkParser.ts`, `src/diffDecorator.ts`, `src/diffCodeLens.ts` | Replaced by `vscode.diff` editor for change review |

### 3.3 Modules to keep & reuse

| File | Change |
|---|---|
| `src/processManager.ts` | Reuse verbatim — framework-agnostic CLI wrapper |
| `src/openCodeManager.ts` | Reuse verbatim |
| `src/projectIndexer.ts` | Reuse, called from `/index` slash command |
| `src/types.ts` | Slim down — keep `BackendType`, `ChatStream`; drop session/history types |
| `src/statusBar.ts` | Slim down — keep model + mode display, drop token-count UI |

### 3.4 New modules

| File | Purpose |
|---|---|
| `src/chatParticipant.ts` | Main handler: maps `ChatRequest` → backend invoke → streams response |
| `src/backendController.ts` | Owns "which backend, which model, which mode" state + status-bar toggle |
| `src/diffViewer.ts` | After AI turn: detect changed files via `git diff`, open each in `vscode.diff` |
| `src/openCodeModelBrowser.ts` | Lift the "+ Add model" QuickPick (free-model detection) out of `claudeViewProvider.ts` |

---

## 4. Functional requirements

### 4.1 Chat invocation

- User types `@avn <message>` in VS Code's chat panel
- Handler receives `ChatRequest { prompt, references, command, model, toolReferences }` plus `ChatResponseStream`
- Handler calls `processManager.invoke()` or `openCodeManager.invoke()` based on `backendController.getBackend()`
- Token-by-token text streamed via `response.markdown(chunk)`
- Tool-use events stream as `response.progress(toolName)` — no inline diff blocks (handled separately in §4.4)
- On error (CLI missing, etc.), `response.markdown()` with the existing setup-instructions blocks
- A keybinding (`Cmd+L` default, configurable) opens chat with `@avn ` pre-filled via `workbench.action.chat.open`

### 4.2 Model switching

- Status-bar item shows current model (e.g. `claude-sonnet-4-6` or `opencode/deepseek-v4-flash-free`)
- Clicking opens a QuickPick with:
  - Header tab strip: **[ Claude ]  [ OpenCode ]**
  - Model list for the active tab
  - **+ Add model** at the bottom of the OpenCode tab → triggers the model browser (§4.6)
- Selecting a model from the OpenCode tab also flips the backend to OpenCode (and vice-versa)
- Selection persisted in `workspaceState`
- `/model` slash command on the participant opens the same QuickPick — power-user shortcut

### 4.3 File and image referencing

Built-in, **no custom UI**:
- `#file:path/to/foo.ts` references a file (chat API tokenizes it into `ChatRequest.references`)
- Drag-drop into the chat panel works for free
- `Cmd+V` paste of images works for free
- Active editor / current selection: VS Code exposes via `#selection` and `#editor`

Handler reads `request.references` and includes them in the prompt to the CLI:
- Each reference has `value: Uri | Location | string` — we read the file or use the selection text
- Images: detect by file extension or content type, base64-embed in the prompt (Claude CLI supports `--image`)

### 4.4 Edit visualization (the compromise)

- After each AI turn completes, run `git diff --name-only HEAD` to find changed files
- For each changed file:
  - Open it in a diff editor via `vscode.commands.executeCommand('vscode.diff', originalUri, currentUri, title)`
  - `originalUri` uses a `TextDocumentContentProvider` that serves `git show HEAD:<file>` output
  - Tabs open in a side column (not the active editor) so chat stays visible
- User reviews each diff and uses VS Code's **Source Control** panel for Keep (commit/stage) or Discard (revert)
- No custom CodeLens, no custom decorations, no custom change bar — Source Control panel does this natively
- If >5 files changed, ask `"Open all 12 changed files? [Yes / Show list]"` to avoid tab explosion

### 4.5 Slash commands

Registered as `slashCommands` on the participant:

| Command | Behavior |
|---|---|
| `/clear` | Clears chat (chat API native — verify or implement) |
| `/fix` | Like today: fix issues in the active file |
| `/explain` | Like today: explain the active file |
| `/index` | Build `.claude/project-context.md` (port `projectIndexer.ts`) |
| `/model` | Open the model QuickPick |
| `/mode` | Open a QuickPick: Ask before edits / Edit automatically / Plan mode |
| `/think` | Toggle Claude Extended Thinking level (Off / Low / Med / High / Max) |
| `/help` | List all slash commands |

### 4.6 OpenCode model browser

- Triggered from `+ Add model` in the model QuickPick or via `avn.addOpenCodeModel` command
- Runs `opencode models --verbose`, parses model-id + JSON blob pairs (port `_fetchOpenCodeModels` from `claudeViewProvider.ts`)
- Multi-select QuickPick; free models (cost = 0) marked with ★ and pre-checked
- Selected models append to `claude.openCodeModels` global setting
- Hover existing OpenCode model in main picker → × button to remove (port the existing code)

### 4.7 Mode handling (Ask / Edit auto / Plan)

- Stored in `workspaceState`
- **Ask before edits**: invoke Claude CLI *without* `--dangerously-skip-permissions` — CLI prompts, which surfaces in chat as the AI asking questions
- **Edit automatically**: invoke with `--dangerously-skip-permissions` (current default behavior)
- **Plan mode**: prepend the existing `"<instruction>Plan mode: Analyze and outline…</instruction>"` to the user's prompt
- Status-bar item shows current mode; click cycles or opens QuickPick

### 4.8 Extended Thinking (Claude only)

- Same as today: QuickPick (Off / Low / Medium / High / Max) via status-bar item or `/think` slash command
- Only enabled for models in `claude.thinkingModels`
- Passes the right CLI flag

### 4.9 Cancellation

- Handler receives `CancellationToken` from the chat API
- Wire it to `AbortController` and `proc.kill('SIGTERM')` (already implemented in the managers)
- Native chat panel has a built-in stop button — we don't add our own

### 4.10 Setup guides for missing CLIs

- Same content as today: if `ENOENT` on spawn, `response.markdown()` with install / login / verify steps
- Both Claude and OpenCode variants

---

## 5. Out of scope (explicitly NOT doing)

- Native `response.textEdit()` inline diff with per-hunk Keep/Undo (see §2)
- Token usage tracking, daily limit warnings, status-bar token counter (scope decision)
- Custom session management (use chat API native)
- Custom file/image picker (use chat API native)
- Symbol paste auto-reference (`#sym` works in chat API natively for symbols)
- MCP server toggle UI (VS Code 1.94+ has built-in MCP support)
- The custom welcome message, model browser tabs in webview, etc. — all gone

---

## 6. Open questions

Items I need your call on before coding starts:

1. **Inline completions** (`src/completionProvider.ts`) — currently fires `claude` for ghost-text suggestions as you type. Unrelated to chat. **Keep or delete?**
2. **Code actions** (`src/codeActionProvider.ts`) — right-click "Claude: Fix this / Explain this / Refactor" menu. Unrelated to chat. **Keep or delete?**
3. **Checkpoint restore** — current "↩ restore checkpoint" runs `git reset --hard`. Chat API has no per-message-action hook. **Drop entirely, or implement as `/restore <N>` slash command?**
4. **Welcome / empty-state message** — chat API supports a welcome string per participant. Keep the existing "Hello, I'm AVN…" content or fresh?
5. **Minimum VS Code version** — chat participant API stabilized around 1.94. **OK to require `engines.vscode: ^1.94`?**
6. **Image handling for Claude CLI specifically** — does `claude run` actually accept `--image` or do we need base64-in-prompt? Worth a 5-min CLI experiment when I start; not blocking the spec.

---

## 7. Suggested file structure after the port

```
src/
  extension.ts              ← register participant, commands, status bar
  chatParticipant.ts        ← NEW — request handler, streams response
  backendController.ts      ← NEW — backend + model + mode state, status bar wiring
  diffViewer.ts             ← NEW — opens vscode.diff for changed files
  openCodeModelBrowser.ts   ← NEW — QuickPick for adding OpenCode models
  processManager.ts         ← kept, unchanged
  openCodeManager.ts        ← kept, unchanged
  projectIndexer.ts         ← kept, called from /index slash command
  statusBar.ts              ← slimmed: model + mode only
  types.ts                  ← slimmed
```

Expected diff: **delete ~3,800 LOC, write ~600 LOC**.

---

## 8. Rough implementation order

Each step is a separate commit on `feat/vscode-chat-api`. If the experiment fails, `main` is unaffected.

1. Strip out webview / sessions / contextAssembler / tracking → compiling skeleton
2. Register `@avn` chat participant with a dumb echo handler → verify chat panel works
3. Wire `processManager.invoke()` into the handler, stream text → Claude works end-to-end
4. Add backend toggle + model status-bar → switch between Claude and OpenCode
5. Port OpenCode manager + model browser
6. Implement `diffViewer` (auto-open `vscode.diff` for changed files)
7. Slash commands: `/clear`, `/fix`, `/explain`, `/index`, `/model`, `/mode`, `/think`, `/help`
8. Mode handling (Ask / Auto / Plan) + Extended Thinking
9. Setup-guide error messages for missing CLIs
10. README rewrite
