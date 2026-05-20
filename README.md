# AVN Chat

A standalone VS Code sidebar chat powered by the **Claude Code CLI**. Replaces the default Copilot Chat with a fully custom panel — sessions, file context, live progress, checkpoint restore, and more.

---

## Requirements

Before installing, make sure you have:

- **VS Code** 1.90 or later
- **Claude Code CLI** installed and authenticated

```bash
# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Log in (run this once)
claude login
```

Verify it works: `claude --version`

---

## Installation

### From VSIX file (recommended for sharing)

1. Download `avn-claude-gui-0.2.0.vsix`
2. Open VS Code
3. Open the **Extensions** panel (`Cmd+Shift+X` / `Ctrl+Shift+X`)
4. Click the `···` menu (top-right of the Extensions panel)
5. Select **Install from VSIX…**
6. Choose the downloaded `.vsix` file

Or via terminal:
```bash
code --install-extension avn-claude-gui-0.2.0.vsix
```

### From source

```bash
git clone <repo-url>
cd AVN-Claude-GUI
npm install
npm run compile
# Then press F5 in VS Code to run the Extension Development Host
```

---

## Getting Started

1. After installing, click the **✦ star icon** in the Activity Bar (left sidebar)
2. The AVN Chat panel opens
3. Type a message and press **Enter** to send, **Shift+Enter** for a new line
4. Claude Code CLI must be authenticated — if you see an auth error, run `claude login` in your terminal

---

## Features

### Chat

| Action | How |
|--------|-----|
| Send message | `Enter` |
| New line | `Shift+Enter` |
| Cancel running response | Click × or `Escape` while streaming |
| Clear conversation | 🗑 button in header |

### File References (Top Bar)

Files you attach appear as chips across the top of the input card. They wrap to multiple rows automatically.

| Action | How |
|--------|-----|
| Add files | Click **+** button or type **@filename** |
| Add current editor file | Click the **📄 filename** button (toggles blue when included) |
| Drop files | Drag files from VS Code explorer into the chat |
| Paste image | `Cmd+V` / `Ctrl+V` — image thumbnail appears as a chip |
| Remove a reference | Click **×** on any chip |
| Remove all references | Press `Escape` when no menus are open |

Files marked as **already added** appear greyed out in the picker — you can't double-add them.

### Numbered Lists & Blockquotes

Type `1. item` and press `Shift+Enter` → automatically continues with `2. `

Type `> quote` and press `Shift+Enter` → automatically continues with `> `

Press `Shift+Enter` on an empty list/quote item to exit the format.

### Sessions

Click **≡** in the header to open the Sessions panel.

- **New session** — starts a fresh conversation (Claude's context is fully reset)
- **Switch session** — click any session row; Claude resumes via `--resume` so its full conversation history is preserved server-side, but the UI only shows the current session's messages
- **Rename** — click ✏ on any session row
- **Delete** — click 🗑 on a session row

### Modes (bottom bar `</>` button)

| Mode | Behaviour |
|------|-----------|
| **Ask before edits** | Claude asks for permission before each file change |
| **Edit automatically** | Claude edits files without asking (YOLO mode) |
| **Plan mode** | Claude outlines a plan and does **not** write any files |

### Extended Thinking

Inside the Modes picker, toggle **Extended Thinking** on to pass `--effort` to the CLI. Use the dots to choose Low / Medium / High effort. Only has an effect on models that support extended thinking (e.g. `claude-opus-4-7`).

### Model Switching

Click the model name in the bottom bar (e.g. `haiku-4-5`) to open the model picker. Models are configured in VS Code settings under `claude.models`.

### Commands (/ menu)

Press `/` on an empty input or click the `/` button:

| Command | What it does |
|---------|-------------|
| `/fix` | Fix issues in the active file |
| `/explain` | Explain the active file |
| `/index` | Build a `.claude/project-context.md` summary of the project |
| `/help` | Show available commands |
| `/clear` | Clear conversation history |

### Checkpoint Restore

After each response, hover over the assistant message to reveal:

- **Model · Effort · Token count** — subtle metadata line
- **↩ restore checkpoint** — reverts all file edits Claude made during that turn using `git reset --hard`

> Requires the workspace to be a git repository. The restore point is the `git HEAD` at the moment you pressed Send.

### MCP Servers (⚙ button)

Click the wrench icon in the bottom bar to manage Model Context Protocol servers:

- View all configured MCP servers from `~/.claude.json`
- Toggle individual servers on/off
- Remove servers
- **+ Add MCP** — prompts for a name and command (e.g. `npx -y @mcp/package`)

Changes take effect on the next session restart.

### Token Usage

Click the **X.Xk tok** item in the VS Code status bar to open the usage overlay showing session, daily, and weekly token counts.

---

## Configuration

Open VS Code Settings (`Cmd+,`) and search for **AVN Chat** (or `claude`):

| Setting | Default | Description |
|---------|---------|-------------|
| `claude.models` | `[sonnet-4-6, opus-4-7, ...]` | Models shown in the model picker |
| `claude.defaultModel` | `claude-sonnet-4-6` | Model used for new sessions |
| `claude.dailyTokenLimit` | `0` (unlimited) | Daily token budget (shown in usage overlay) |
| `claude.maxFolderContextKb` | `500` | Max KB of folder content included when you attach a folder |
| `claude.thinkingModels` | `[opus-4-7, opus-4-5]` | Models for which Extended Thinking is available |

---

## File Icons

To show file-type icons in the `@` file picker, add SVG files to `media/icons/`:

```
media/icons/
  file.svg        ← generic fallback
  folder.svg      ← directories
  ts.svg
  js.svg
  css.svg
  json.svg
  md.svg
  py.svg
  html.svg
  ...etc
```

Naming: `{extension}.svg`. If an extension-specific icon isn't found, `file.svg` is used.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line (or continue list/quote) |
| `Escape` | Clear all references / close open menus |
| `/` (empty input) | Open commands menu |
| `@` (while typing) | Open file picker in inline search mode |
| `↑` / `↓` | Navigate picker lists |
| `Enter` | Select highlighted picker item |

---

## Troubleshooting

**"Claude CLI not found"** — Make sure `claude` is on your PATH. Run `which claude` in a terminal. If missing, reinstall: `npm install -g @anthropic-ai/claude-code`

**Auth error** — Run `claude login` in your terminal and follow the browser prompt.

**No response / spinner stuck** — The Claude Code CLI process may have crashed. Open the debug output channel (click the `●` dot in the chat header) to see raw CLI output.

**Checkpoint restore failed** — Workspace must be a git repository (`git init` if needed). Also check there are no uncommitted merge conflicts.

**Model picker shows "avnchat"** — The extension JS failed to initialise. Check the VS Code Developer Tools console (`Help → Toggle Developer Tools`) for errors, then reload the window (`Cmd+Shift+P → Reload Window`).

---

## Architecture (for developers)

```
src/
  extension.ts          — activation, command registration
  claudeViewProvider.ts — WebviewViewProvider, message bridge, MCP/checkpoint helpers
  chatHandler.ts        — Claude CLI orchestration, session state, mode/effort/yolo
  processManager.ts     — spawns `claude -p --output-format stream-json`, streams events
  contextAssembler.ts   — builds prompts from attached files, selections, active file
  sessionManager.ts     — named chat session CRUD (workspaceState)
  statusBar.ts          — status dot + token count in VS Code status bar
  usageTracker.ts       — session / daily / weekly token accounting
  types.ts              — shared interfaces (ChatStream, ClaudeStreamEvent, etc.)

media/
  chat.js               — all webview frontend logic (vanilla JS, CSP-safe)
  chat.css              — all webview styles
  claude-icon.svg       — activity bar icon
  icons/                — file-type icons for the @ picker
```

**Message flow:**
```
User types → chat.js postMessage → claudeViewProvider.handleMessage()
  → chatHandler.chat() → processManager.invoke()
  → spawns `claude -p --output-format stream-json`
  → streams JSON events → chatHandler sends chunks via ChatStream
  → webview renders markdown
```

**CSP note:** The webview uses `script-src 'nonce-{nonce}'` — no `'unsafe-inline'`. All event handlers must use `addEventListener`. No `onclick=` attributes.

---

## License

Personal / private use.
