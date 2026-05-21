# AVN Chat

A custom standalone VS Code sidebar chat extension that supports **Claude Code CLI** and **OpenCode** as backends — use either one, or both, switching freely per session.

---

## Backends: Claude Code vs OpenCode

| Feature | Claude Code | OpenCode |
| ------- | ----------- | -------- |
| Provider | Anthropic only | 75+ providers (Anthropic, OpenAI, Gemini, Groq, DeepSeek, Ollama…) |
| Free tier | Anthropic usage limits apply | Many models are free (marked ★ in the model picker) |
| Tool use / file editing | Full agent mode | Full agent mode |
| Session resume | `--resume <id>` | `--session <id>` |
| Extended Thinking | Supported on opus models | Not supported |
| Required | No — either backend is optional | No — either backend is optional |

**You can install just one, both, or neither.** The extension starts up regardless and shows a clear setup guide in the chat when a backend is not found.

---

## Setup — Claude Code

```bash
# 1. Install the CLI
npm install -g @anthropic-ai/claude-code

# 2. Authenticate (run once — opens a browser)
claude login

# 3. Verify
claude --version
```

`claude login` handles authentication. No manual API key setup needed.

---

## Setup — OpenCode

```bash
# 1. Install the CLI
npm install -g opencode-ai

# 2. Verify
opencode --version
```

**API keys:** OpenCode reads them from environment variables. Set the key for the provider(s) you want to use:

| Provider | Environment variable |
|----------|---------------------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` |
| Groq | `GROQ_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

Add the key to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Then restart VS Code so it picks up the new environment variable.

**Viewing available models (including free ones):**

```bash
opencode models
```

Or use the **+ Add model** button in the model picker — it fetches all models from the OpenCode CLI, detects which ones are free (cost = $0), and pre-selects them for you.

---

## Installation

### From VSIX (recommended)

1. Download `avn-claude-gui-x.x.x.vsix`
2. Extensions panel (`Cmd+Shift+X`) → `···` menu → **Install from VSIX…**

Or via terminal:

```bash
code --install-extension avn-claude-gui-x.x.x.vsix
```

### From source

```bash
git clone https://github.com/Zohaib2244/AVN-Claude-GUI
cd AVN-Claude-GUI
npm install
npm run compile
# Press F5 in VS Code to run the Extension Development Host
```

---

## Getting Started

1. Click the **✦ star icon** in the Activity Bar
2. The AVN Chat panel opens
3. Click the model name button in the bottom bar → select **[Claude]** or **[OpenCode]** tab → pick a model
4. Send a message with **Enter**

If a backend is not installed, you will see a setup guide directly in the chat instead of a generic error.

---

## Switching Backends

Click the **model name button** in the bottom bar to open the model picker. A tab strip at the top lets you switch between Claude and OpenCode:

```text
┌─────────────────────────────┐
│ [Claude]  [OpenCode]        │  ← click to switch
├─────────────────────────────┤
│ ✓ sonnet-4-6                │
│   opus-4-7                  │
└─────────────────────────────┘
```

Switching tabs:

- Automatically selects the first model for that backend
- Persists per session — each session remembers its own backend and model
- Hides Extended Thinking controls for OpenCode (not supported)

**Sessions are backend-independent.** You can have some sessions on Claude and others on OpenCode. The session panel shows all sessions regardless of backend.

---

## Adding OpenCode Models

OpenCode starts with no models pre-configured. To add models:

1. Switch to the **OpenCode** tab in the model picker
2. Click **+ Add model** at the bottom
3. The extension runs `opencode models --verbose` and shows a multi-select list
4. Free models are detected automatically and pre-selected (marked ★)
5. Select the ones you want and confirm

Models are saved to your global VS Code settings (`claude.openCodeModels`) and available in all workspaces.

To remove a model: hover over it in the picker and click **×**.

---

## Features

### Chat

| Action | How |
|--------|-----|
| Send message | `Enter` |
| New line | `Shift+Enter` |
| Stop generation | Click the **■ red stop button** or press `Escape` while running |
| Clear conversation | 🗑 button in header or `/clear` |

### Live Activity View

While the agent is working, the chat shows a live panel:

- **📋 Tasks** — the TodoWrite task list with ✓ / ⟳ / ○ status per item and N/M progress count
- **📂 Files** — every file read (↓ blue), written (↑ green), or edited (± orange)
- **⚡ Commands** — each shell command with a `$` prompt
- **🔍 Search** — grep, web fetch, and web search queries

The currently running tool pulses with a yellow left border. At the end, the panel collapses into a summary.

The initial thinking state shows **"Nutting All Over the Codebase..."** with animated dots.

### Smart Symbol Paste

Copy any identifier from a source file (`fetchUserData`, `MyClass`, etc.) and paste it into the chat. If the workspace symbol provider resolves it, a reference chip appears showing the file and line number. The definition snippet is automatically included as context in your next message.

### File References

| Action | How |
|--------|-----|
| Add files | Click **+** or type **@filename** |
| Include current editor file | Click the **📄 filename** chip (turns blue when included) |
| Drop files | Drag from the VS Code Explorer |
| Paste image | `Cmd/Ctrl+V` — thumbnail chip appears |
| Remove one | Click **×** on any chip |
| Remove all | `Escape` (when no menus are open) |

### Sessions

Click **≡** in the header. Each session stores:

- The backend (Claude or OpenCode) and model used
- The full chat history, persisted across VS Code restarts
- The backend session ID for conversation continuity (`--resume` / `--session`)

Switching sessions restores the full message history for that session. `/clear` wipes the display history and resets the conversation context.

### Modes (bottom bar `</>` button)

| Mode | Behaviour |
|------|-----------|
| Ask before edits | Agent asks permission before each file change |
| Edit automatically | Agent edits files without asking |
| Plan mode | Agent plans only — does **not** write any files |

**Extended Thinking** (Claude only): toggle on in the Modes picker and choose Low / Medium / High effort. Only effective on models that support it (e.g. `claude-opus-4-7`).

### Token Usage and Limits

- The status bar shows `X.Xk tok` (daily usage). Click it for the full breakdown.
- Set `claude.dailyTokenLimit` in settings to cap daily usage. At 90%: the status bar turns orange with a ⚠ warning and a one-time popup fires.
- When the limit is reached, new requests are blocked with a clear message.

### Commands (`/` menu)

| Command | What it does |
|---------|-------------|
| `/fix` | Fix issues in the active file |
| `/explain` | Explain the active file |
| `/index` | Build `.claude/project-context.md` for the project |
| `/help` | Show available commands |
| `/clear` | Clear conversation and reset session |

### Checkpoint Restore

Hover over any assistant message to reveal **↩ restore checkpoint** — runs `git reset --hard` to the state before that prompt. Requires a git repository.

### MCP Servers (⚙ button)

Manage Model Context Protocol servers from `~/.claude.json`. Toggle, remove, or add new servers. Changes take effect on the next session.

---

## Configuration

Search for **AVN Chat** in VS Code Settings (`Cmd+,`):

| Setting | Default | Description |
|---------|---------|-------------|
| `claude.models` | `[sonnet-4-6, opus-4-7, ...]` | Claude models shown in the picker |
| `claude.openCodeModels` | `[]` | OpenCode models (managed via the + Add model UI) |
| `claude.defaultModel` | `claude-sonnet-4-6` | Default model for new sessions |
| `claude.dailyTokenLimit` | `0` (unlimited) | Daily token budget (0 = no limit) |
| `claude.maxFolderContextKb` | `500` | Max KB of folder content when attaching a folder |
| `claude.thinkingModels` | `[opus-4-7, opus-4-5]` | Claude models that support Extended Thinking |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line (continues numbered lists and blockquotes) |
| `Escape` | Stop generation (if running) / clear references / close menus |
| `/` on empty input | Open commands menu |
| `@` while typing | Open file picker (inline search) |
| `↑` / `↓` | Navigate picker lists |

---

## Troubleshooting

**"Claude Code CLI not found"**
The setup guide appears inline in the chat. Quick fix: `npm install -g @anthropic-ai/claude-code && claude login`. Reload VS Code after.

**"OpenCode CLI not found"**
Inline setup guide appears in the chat. Quick fix: `npm install -g opencode-ai`. Set the API key env var for your provider and reload VS Code.

**OpenCode response never arrives / spins forever**
OpenCode v0.15+ has a known hang-on-exit bug. The extension has a 5-minute hard timeout. If you hit this consistently, check the **OpenCode (Debug)** output channel — it logs every raw NDJSON line from OpenCode's output. File an issue with those logs.

**Claude auth error**
Run `claude login` in a terminal and follow the browser prompt.

**Checkpoint restore failed**
Workspace must be a git repo (`git init` if needed). Uncommitted merge conflicts will block the reset.

**Model picker shows "avnchat"**
Extension JS failed to initialise. Open Dev Tools (`Help → Toggle Developer Tools`), check the console for errors, then `Cmd+Shift+P → Reload Window`.

---

## Architecture

```text
src/
  extension.ts          — activation, wires up all managers
  claudeViewProvider.ts — WebviewViewProvider, message bridge, MCP, history persistence
  chatHandler.ts        — backend routing, session state, mode/effort
  processManager.ts     — Claude Code CLI (stream-json NDJSON)
  openCodeManager.ts    — OpenCode CLI (--format json NDJSON, 5-min hard timeout)
  sessionManager.ts     — session CRUD + message history (workspaceState)
  contextAssembler.ts   — builds prompts from files, selections, symbol refs
  statusBar.ts          — status dot + token count + 90% limit warning
  usageTracker.ts       — session / daily / weekly token accounting
  types.ts              — shared interfaces

media/
  chat.js   — webview frontend (vanilla JS, CSP-safe, no frameworks)
  chat.css  — all webview styles
  icons/    — file-type icons for the @ picker
```

Message flow:

```text
User types → chat.js postMessage → claudeViewProvider.handleMessage()
  → chatHandler.runBackend()
      → Claude:    processManager.invoke()  [claude -p --output-format stream-json]
      → OpenCode:  openCodeManager.invoke() [opencode run --format json]
  → streams text chunks → webview renders markdown
  → on done: message saved to workspaceState
```
