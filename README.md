# AVN Chat

A VS Code **Chat Participant** that routes your messages through the **Claude Code CLI** or the **OpenCode CLI**. Type `@avn …` in the built-in chat panel.

> **Branch note:** this is the `feat/vscode-chat-api` rewrite — the custom sidebar is gone and `@avn` lives inside VS Code's native chat panel. For the previous webview-based implementation, see the `main` branch.

---

## Why this rewrite

The previous version reimplemented ~3,500 LOC of UI: file picker, image paste, model picker, sessions, change bar, slash commands. Every one had edge cases. This port hands all of that to VS Code's stable Chat Participant API (VS Code 1.94+) and keeps only the CLI wrappers.

| | Old | New |
|---|---|---|
| Chat panel UI | Custom webview | VS Code native |
| File / image refs | `+` button + `@name` | Built-in `#file`, drag-drop, paste |
| Sessions | Hand-rolled `SessionManager` | VS Code chat history |
| Slash commands | Custom dropdown | `/cmd` in chat input |
| Streaming | `postMessage` + DOM | `ChatResponseStream.markdown()` |
| Diff review | Custom hunk decorator + lens | `vscode.diff` editor + Source Control panel |
| Code deleted | — | ~3,800 LOC |

---

## Setup

You need at least one CLI installed. The extension activates regardless.

### Claude Code
```bash
npm install -g @anthropic-ai/claude-code
claude login        # opens browser, sets up auth
claude --version    # verify
```

### OpenCode
```bash
npm install -g opencode-ai
opencode --version
```

Then export an API key for whichever provider(s) you want to use (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`) and restart VS Code.

---

## Usage

1. Open VS Code's chat panel (`Cmd+Ctrl+I` / `Ctrl+Alt+I`, or click the chat icon in the title bar)
2. Type `@avn <your message>` — or press **`Cmd+L`** / **`Ctrl+L`** to open chat with `@avn ` pre-filled
3. After the first message, you can drop the prefix; VS Code remembers the active participant for the rest of the session

### Picking the model

The status bar shows the current model (e.g. `🚀 claude-sonnet-4-6`). Click it to open a QuickPick with separator sections for Claude and OpenCode models. Selecting a model also flips the backend if needed.

If you have no OpenCode models configured, the picker offers **AVN: Add OpenCode Model** — runs `opencode models --verbose`, parses the catalogue, and shows a multi-select QuickPick with free models pre-checked (★).

### Modes

Three modes, click the status-bar item to switch:

| Mode | Behavior |
|---|---|
| Ask before edits | Claude CLI invoked without `--dangerously-skip-permissions` |
| Edit automatically | YOLO — applies edits without prompting |
| Plan mode | Prepends a Plan-only instruction; the AI does not write files |

### Extended Thinking (Claude opus models)

Shows as a third status-bar item only when the active model is in `avn.thinkingModels`. Click → QuickPick (Off / Low / Medium / High / Max).

### Slash commands

| Command | What |
|---|---|
| `/fix`     | Fix issues in the active editor file |
| `/explain` | Explain the active editor file |
| `/index`   | Build `.claude/project-context.md` |
| `/model`   | Switch model |
| `/mode`    | Switch mode |
| `/think`   | Toggle thinking budget |
| `/help`    | List all commands |

### File and image attachments

All native to VS Code chat — no custom UI:

- **`#file:path/to/foo.ts`** in the chat input attaches a file
- **Drag-drop** files from the explorer
- **`Cmd+V`** pastes images
- The active editor's current file/selection is available via `#editor` / `#selection`

The handler reads `request.references` and inlines each as `<file path="…">…</file>` (or `<selection …>` / `<context …>`) in the prompt to the CLI.

### Reviewing edits

When the AI finishes editing files, **a diff editor opens for each changed file** showing HEAD vs working tree. If more than 5 files changed, the extension asks first ("Open all 12? / Show list / Skip").

Use VS Code's built-in **Source Control** panel to Keep (stage/commit) or Discard (revert) per file. No custom Keep/Undo UI — VS Code's is more mature.

---

## Configuration

Search **AVN** in VS Code Settings:

| Setting | Default | Description |
|---|---|---|
| `avn.claudeModels`    | `[sonnet-4-6, opus-4-7, …]` | Claude models in the picker |
| `avn.openCodeModels`  | `[]` | OpenCode models (managed via the + Add UI) |
| `avn.defaultModel`    | `claude-sonnet-4-6` | Default on first run |
| `avn.thinkingModels`  | `[opus-4-7, opus-4-5]` | Models supporting Extended Thinking |
| `avn.completionDebounceMs` | `500` | Debounce for inline ghost-text completions |

---

## What's gone (vs the old `main` branch)

These features were dropped because VS Code's chat API covers them better (or they were not worth porting):

- Custom sidebar webview, model-picker UI, sessions panel, change bar, file picker
- Daily token tracking and limit warning
- Symbol auto-paste references (VS Code's `#symbol` is built-in)
- MCP server toggle UI (VS Code 1.94+ has built-in MCP support)
- Checkpoint restore (`↩ restore`) — removed; rely on git
- Custom per-hunk inline diff decorations and Keep/Undo CodeLens — replaced by the native diff editor + Source Control panel

The right-click code actions (**Claude: Fix this / Explain this / Refactor / Add Tests / Add Docs / Find Bugs / Custom**) and inline ghost-text completions are kept — they're unrelated to chat.

---

## Architecture

```
src/
  extension.ts              ← activate, register participant + commands
  chatParticipant.ts        ← handler: ChatRequest → backend → ChatResponseStream
  backendController.ts      ← model / backend / mode / thinking state + status bar
  diffViewer.ts             ← OriginalContentProvider + showChangedFileDiffs()
  openCodeModelBrowser.ts   ← QuickPick for opencode models --verbose
  processManager.ts         ← Claude Code CLI wrapper (kept from before)
  openCodeManager.ts        ← OpenCode CLI wrapper (kept from before)
  projectIndexer.ts         ← /index command implementation
  completionProvider.ts     ← inline ghost-text suggestions
  codeActionProvider.ts     ← right-click menu items
  statusBar.ts              ← AVN spinner (idle/thinking/error)
  types.ts                  ← BackendType, AvnMode, ThinkingBudget, ChatStream
```

Message flow:
```
User types @avn …  →  VS Code chat panel  →  AvnChatParticipant.handle()
   → resolveReferences(request.references)  → builds <file>/<selection> blocks
   → BackendController.getBackend()  → routes to:
       processManager.invoke()   (claude  -p --output-format stream-json)
       openCodeManager.invoke()  (opencode run --format json)
   → stream text via response.markdown(), tools via response.progress()
   → on turn end: showChangedFileDiffs() opens vscode.diff for each changed file
```

---

## Building locally

```bash
npm install
npm run compile
# F5 in VS Code to launch the Extension Development Host
```

Package a VSIX:
```bash
npm run package
```

---

## Troubleshooting

**`@avn` doesn't appear in the chat picker** — make sure VS Code is ≥ 1.94 and reload the window after installing.

**"Claude Code CLI not found"** — inline setup guide appears in chat. Run `npm install -g @anthropic-ai/claude-code && claude login`.

**"OpenCode CLI not found"** — inline setup guide appears in chat. Run `npm install -g opencode-ai` and export the relevant `*_API_KEY`.

**OpenCode response hangs** — known v0.15+ exit bug; `openCodeManager` has a 5-min hard timeout. Check Output → "OpenCode (Debug)" for raw NDJSON.

**The diff editor doesn't open after an AI turn** — the diff viewer uses `git diff --name-only HEAD`. Workspace must be a git repo (`git init` if needed).
