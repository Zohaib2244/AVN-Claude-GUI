# AVN Chat — Complete Session Context

Use this as the opening context for the next conversation.

---

## What This Is

A standalone VS Code sidebar chat extension powered by the **Claude Code CLI** (`claude` command).
It is NOT integrated with Copilot Chat — fully custom WebviewViewProvider.

**GitHub:** https://github.com/Zohaib2244/AVN-Claude-GUI  
**Location:** `/Users/zohaib2469/Documents/Zohaib_Files/Personal/My_Projects/AVN-Claude-GUI`  
**Version:** 0.2.0  
**Run:** F5 in VS Code → Extension Development Host → click ✦ star icon in activity bar  
**Build:** `npm run compile` (`./node_modules/.bin/tsc -p tsconfig.json`)  
**Package:** `npm run package` → produces `avn-claude-gui-0.2.0.vsix`

---

## Full File Structure

```
AVN-Claude-GUI/
├── .vscode/
│   ├── launch.json        # F5 debug config
│   └── tasks.json         # default build task
├── media/
│   ├── chat.css           # ~589 lines — all webview styles
│   ├── chat.js            # ~856 lines — all webview frontend logic (vanilla JS)
│   ├── claude-icon.svg    # activity bar icon
│   └── icons/             # file-type icons for @ picker (file.png, folder.png, etc.)
├── out/                   # compiled JS (gitignored)
├── src/
│   ├── extension.ts           # activation entry point
│   ├── claudeViewProvider.ts  # ~712 lines — WebviewViewProvider, message bridge, HTML template
│   ├── chatHandler.ts         # ~375 lines — Claude CLI orchestration, session/mode/effort state
│   ├── sessionManager.ts      # named chat sessions CRUD (workspaceState)
│   ├── processManager.ts      # spawns `claude -p --output-format stream-json`, streams JSON
│   ├── contextAssembler.ts    # builds prompts from dropped files / selections / active file
│   ├── statusBar.ts           # status dot + token count in VS Code status bar
│   ├── usageTracker.ts        # session/daily/weekly token tracking
│   ├── types.ts               # shared interfaces (ChatStream, ClaudeStreamEvent, ThinkingBudget…)
│   ├── completionProvider.ts  # inline completions (legacy, may not work)
│   ├── codeActionProvider.ts  # right-click code actions
│   ├── projectIndexer.ts      # generates .claude/project-context.md
│   └── conversationStore.ts   # DEAD CODE — not imported, safe to delete
├── README.md
├── package.json           # version 0.2.0, publisher "personal"
└── tsconfig.json
```

---

## Architecture

### Message Flow
```
User types → chat.js postMessage
  → claudeViewProvider.handleMessage()
  → chatHandler.chat()
  → processManager.invoke()  [spawns: claude -p --output-format stream-json --model X]
  → streams JSON events (ClaudeStreamEvent)
  → chatHandler sends text via ChatStream.markdown()
  → claudeViewProvider._post({ type: 'streamChunk', text })
  → chat.js renderMarkdown() → innerHTML
```

### Key Interfaces (src/types.ts)

```ts
interface ChatStream {
  markdown(text: string): void;
  progress?(toolName: string, toolInput: Record<string, unknown>): void;  // tool-use events
  done?(stats: { inputTokens, outputTokens, model, effort? }): void;      // end-of-turn stats
}

type ThinkingBudget = 'low' | 'medium' | 'high' | 'max';

interface ClaudeStreamEvent {
  type: 'system' | 'assistant' | 'user' | 'result' | 'error';
  session_id?: string;
  message?: { content: ContentBlock[]; usage?: TokenUsage; ... };
  usage?: TokenUsage;
}
```

### SessionState (in ChatHandler)
```ts
{
  activeSessionId: string | undefined;
  claudeSessionId: string | undefined;  // --resume ID for CLI
  model: string;
  yoloMode: boolean;
  thinkingBudget: ThinkingBudget | undefined;  // undefined = thinking OFF
  droppedItems: DroppedItem[];
  mode: 'agent' | 'plan';
}
```

### Display Mode mapping
```
displayMode 'ask'  → mode='agent', yoloMode=false
displayMode 'auto' → mode='agent', yoloMode=true   (passes --dangerously-skip-permissions)
displayMode 'plan' → mode='plan',  yoloMode=false   (plan prefix in prompt)
```

---

## UI Layout

```
┌────────────────────────────────────┐
│ ● AVN Chat                  ≡  🗑  │  ← header
├────────────────────────────────────┤
│                                    │
│  messages (scrollable, flex:1)     │
│  [sessions panel overlay]          │
│  [usage panel overlay]             │
│  [drop overlay]                    │
│                                    │
├────────────────────────────────────┤
│ [cmd-picker popup  — fixed pos]    │  ← all 4 pickers are fixed-position
│ [file-picker popup — fixed pos]    │    popups, positioned above their
│ [model-picker      — fixed pos]    │    trigger button via getBoundingClientRect()
│ [mode-picker       — fixed pos]    │
│ [tools-panel       — fixed pos]    │
├────────────────────────────────────┤
│ ┌──────────────────────────────┐   │
│ │ TOP (hidden when empty):     │   │  ← #input-top / #tb-chips
│ │ [📄 cur-file][chip ×][chip ×]│   │    all chips in ONE flex-wrap container
│ │ [ctx: 5 lines · file.ts  ×] │   │    (ctx-line + cur-file-btn + tb-chips)
│ ├──────────────────────────────┤   │
│ │ MIDDLE:                      │   │  ← #input-middle
│ │ textarea (scrolls at 160px)  │   │
│ ├──────────────────────────────┤   │
│ │ BOTTOM:                      │   │  ← #input-bottom
│ │ [+][/][model][mode][⚙]  [▶] │   │
│ └──────────────────────────────┘   │
└────────────────────────────────────┘
```

---

## WebView Message Protocol

### Extension → Webview
| type | payload | effect |
|------|---------|--------|
| `setState` | `{ model, displayMode, effort, availableModels }` | update footer buttons |
| `streamStart` | — | show typing dots, disable send, reset progress |
| `streamChunk` | `{ text }` | append + re-render markdown |
| `progressEvent` | `{ toolName, toolInput }` | show live tool-use item |
| `streamEnd` | `{ model, effort, inputTokens, outputTokens, checkpointHash? }` | collapse progress, add metadata + restore button, re-enable send |
| `setStatus` | `{ status: 'idle'\|'thinking'\|'error' }` | update status dot |
| `addUserMessage` | `{ text }` | add user bubble |
| `clearMessages` | — | wipe chat area |
| `filesAttached` | `{ files: [{name, uri, isFolder?, dataUrl?}] }` | add chips to #tb-chips |
| `contextInfo` | `{ kind, file, lines }` | show/hide ctx-line |
| `currentFile` | `{ name, uri }` | show/update cur-file-btn in top bar |
| `fileSearchResults` | `{ files }` | render file picker results |
| `showError` | `{ text }` | assistant error bubble |
| `showUsage` | `{ session, daily, weekly, requests, dailyLimit }` | usage overlay |
| `updateSessions` | `{ sessions, activeId }` | render sessions panel |
| `mcpList` | `{ mcps: [{name, command, disabled}] }` | render tools panel |

### Webview → Extension
| type | payload | handler |
|------|---------|---------|
| `ready` | — | flush pending, send setState + sessions |
| `send` | `{ text, command?, currentFileRef? }` | run Claude |
| `selectMode` | `{ displayMode }` | `chatHandler.setDisplayMode()` |
| `setEffort` | `{ effort }` | `chatHandler.setEffort()` (null = off) |
| `selectModel` | `{ model }` | `chatHandler.setModelDirect()` |
| `pasteImage` | `{ dataUrl, mimeType }` | save to temp file, add chip |
| `clearAttachments` | — | `chatHandler.clearDroppedItems()` |
| `restoreCheckpoint` | `{ checkpointHash }` | `git reset --hard {hash}` |
| `getMCPs` | — | read `~/.claude.json` → send mcpList |
| `toggleMCP` | `{ mcpName }` | toggle in `disabledMcpServers` |
| `removeMCP` | `{ mcpName }` | remove from `mcpServers` |
| `addMCP` | — | VS Code input prompts → write ~/.claude.json |
| `createSession` | — | create new session, clear messages |
| `switchSession` | `{ sessionId }` | load session, clear messages |
| `deleteSession` | `{ sessionId }` | delete + auto-switch |
| `renameSession` | `{ sessionId, name }` | rename |
| `requestContext` | — | check active editor → send contextInfo + currentFile |
| `searchFiles` | `{ query }` | workspace.findFiles → send fileSearchResults |
| `addFile` | `{ uri, name }` | add to droppedItems, filesAttached |
| `removeAttachment` | `{ uri }` | remove from droppedItems |
| `drop` | `{ uriList }` | resolve URIs → filesAttached |

---

## Critical Implementation Details

### CSP Rule
```
script-src 'nonce-${nonce}'   ← NO 'unsafe-inline'
```
All button handlers MUST use `addEventListener` in chat.js. No `onclick=` attributes in HTML.

### Chip System (incremental, no re-animation)
- All chips (cur-file-btn + attachment chips) live in `#tb-chips` as flex children
- `updateChips()` is **incremental**: removes stale chips (by `data-chip-uri` key), adds only new ones
- New chips get `.chip-new` class → `animation: chipPop .16s ease-out` — existing chips are NOT touched
- `clearAttachments()` removes all children EXCEPT `#cur-file-btn`
- Chip removal uses URI (not index) via `removeAttachmentByUri(uri)` to avoid index-shift bugs

### Popup Picker Positioning
All 5 pickers (model, mode, cmd, file, tools) use the same pattern:
```js
function _positionPicker(el, anchorRect, w) {
  var left = anchorRect.left;
  if (left + w > window.innerWidth - 8) { left = window.innerWidth - w - 8; }
  el.style.left = left + 'px';
  el.style.bottom = (window.innerHeight - anchorRect.top + 6) + 'px';
}
// Usage: _positionPicker(picker, btn.getBoundingClientRect(), 280);
```
All pickers are `position: fixed; z-index: 1000` in CSS.

### Current File Button
- `#cur-file-btn` lives as FIRST child of `#tb-chips`
- `updateCurrentFileBtn()` toggles `.hidden` and `.included` class
- `refreshInputTop()` = `inputTop.hidden = ctxLine.hidden && attachments.length === 0 && currentFile === null`
- When included: `handleSend()` passes `currentFileRef: currentFile.uri` in the send payload
- Extension's `send` handler does `await vscode.workspace.fs.stat(refUri)` then adds to droppedItems

### Thinking / Effort
- `thinkingEnabled` (bool, JS state) + `currentEffort` (string, JS state) are SEPARATE
- `thinkingEnabled=false` → sends `setEffort({ effort: null })` → `chatHandler.setEffort(undefined)` → no `--effort` flag
- `thinkingEnabled=true` → sends `setEffort({ effort: currentEffort })` → passes `--effort low/medium/high`
- `setState` from extension: `effort: this.chatHandler.getEffort() ?? null`

### Checkpoint Restore
- Before each `runRequest`: `checkpointHash = await this._gitHash(root)` (runs `git rev-parse HEAD`)
- `streamEnd` includes `checkpointHash` in payload
- Each assistant message gets a `↩ restore checkpoint` button (hover to reveal)
- Click → confirmation modal → `git reset --hard {hash}` in workspaceRoot

### MCP Management
- Reads/writes `~/.claude.json` directly
- `mcpServers` key = server definitions
- `disabledMcpServers` key = array of disabled server names
- `_toggleMCP(name)` adds/removes from disabledMcpServers array
- `_removeMCP(name)` deletes from mcpServers object

### Paste Image
- `document.addEventListener('paste', ...)` in chat.js
- Grabs first `image/*` item from `e.clipboardData.items`
- `FileReader.readAsDataURL(blob)` → posts `pasteImage { dataUrl, mimeType }` to extension
- Extension writes base64 to `os.tmpdir()/avn-paste-{ts}.{ext}`, creates DroppedItem
- Temp files cleaned up in `webviewView.onDidDispose`

### Live Progress (tool use)
- `chatHandler.runClaude()` calls `response.progress(block.name, block.input)` for each `tool_use` block
- `claudeViewProvider.runRequest()` sends `{ type: 'progressEvent', toolName, toolInput }`
- Webview appends to `progressItems[]`, renders `.progress-live` list with `.active` on last item
- On `streamEnd`: collapses into `<details class="msg-progress-summary">` with file/command count summary
- On `streamEnd`: appends `.msg-meta` div (opacity:0, visible on hover) and `.msg-restore-btn`

### Numbered List / Blockquote Continuation
In textarea `keydown`, before the `Enter` handler:
```js
if (e.key === 'Enter' && e.shiftKey) {
  // Check if current line matches /^(\d+)\. ([\s\S]*)$/ or /^> ([\s\S]*)$/
  // If content is empty → exit format (remove prefix)
  // If content exists → insert '\n' + next prefix (incremented number or '> ')
}
```

### File Picker — Already-Added Greyed Out
`renderFileResults()` builds a Set of `attachments[].uri` + currentFile.uri (if included).
Items in the set get `.fp-added` class: `opacity:.4; cursor:default; pointer-events:none on hover`.
Auto-highlight (`fpHighIdx`) skips added items and lands on first non-added.

### processManager.ts — CLI flags
```ts
args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model]
if (sessionId)  args.push('--resume', sessionId)
if (yoloMode)   args.push('--dangerously-skip-permissions')
if (effortLevel) args.push('--effort', effortLevel)
// Prompt written to stdin, stdin closed
```

---

## JS State Variables (chat.js)

```js
let streaming          = false;
let currentEl          = null;        // current assistant message body div
let currentRaw         = '';          // accumulated markdown text
let attachments        = [];          // { name, uri, isFolder?, isImage?, dataUrl?, width?, height? }
let availableModels    = [];
let atMentionStart     = -1;
let fpMode             = 'none';      // 'none' | 'at' | 'plus'
let fpHighIdx          = -1;          // highlighted item in file picker
let cpHighIdx          = -1;          // highlighted item in cmd picker
let fpSearchTimer      = null;
let currentDisplayMode = 'auto';      // 'ask' | 'auto' | 'plan'
let currentEffort      = 'high';      // effort level regardless of thinking on/off
let progressItems      = [];          // { toolName, toolInput } array for current stream
let progressEl         = null;        // .msg-progress div for current stream
let currentFile        = null;        // { name, uri } — active VS Code editor file
let currentFileIncluded = false;      // whether cur-file-btn is active
let thinkingEnabled    = false;       // whether extended thinking is on
```

---

## Known Issues / TODOs

1. `src/conversationStore.ts` — dead code, never imported, safe to delete
2. Inline completions (`completionProvider.ts`) — wired but uncertain if working
3. Session message history — switching sessions shows empty UI (Claude context lives server-side via `--resume`)
4. Image context — base64 thumbnail shown in UI but only file path sent to Claude via `assembleContext`
5. Voice input (mic button) — UI exists, not implemented
6. `switchBudget()` in ChatHandler still has `thinkingModels` gate (old command palette path, not used by new UI)
7. Checkpoint restore only works in git repos; no stash for uncommitted changes before the request

---

## package.json Key Contributions

```json
"viewsContainers": { "activitybar": [{ "id": "claude-sidebar", "title": "AVN Chat" }] },
"views": { "claude-sidebar": [{ "type": "webview", "id": "claude.chatView", "name": "Chat" }] },
"commands": [
  "claude.openChat", "claude.toggleYolo", "claude.showUsage",
  "claude.switchModel", "claude.switchBudget", "claude.indexProject"
],
"configuration": {
  "claude.models": ["claude-opus-4-7", "claude-sonnet-4-6", ...],
  "claude.defaultModel": "claude-sonnet-4-6",
  "claude.dailyTokenLimit": 0,
  "claude.maxFolderContextKb": 500,
  "claude.thinkingModels": ["claude-opus-4-7", "claude-opus-4-5"]
}
```

---

## CSS Selector Reference

| Selector | What it is |
|----------|------------|
| `#input-card` | The floating input card, 3-region, `overflow:hidden`, `border-radius:12px` |
| `#input-top` | Top region — chips + ctx-line. Hidden when empty via `refreshInputTop()` |
| `#tb-chips` | Unified `flex-wrap` chip container — holds cur-file-btn AND attachment chips |
| `#cur-file-btn` | Current file toggle chip, first child of `#tb-chips` |
| `.tb-chip` | Attachment chip. `.chip-new` → plays `chipPop` animation (new chips only) |
| `#input-middle` | Textarea wrapper, `padding:10px 12px 6px` |
| `#user-input` | Textarea, `max-height:160px`, `overflow-y:auto` |
| `#input-bottom` | Bottom action bar — `[+][/][model][mode][⚙] ... [mic][send]` |
| `#model-picker` | Fixed-position popup, `width:260px` |
| `#mode-picker` | Fixed-position popup, `width:280px` — modes + thinking toggle + effort |
| `#cmd-picker` | Fixed-position popup, `width:260px` |
| `#file-picker` | Fixed-position popup, `width:280px` |
| `#tools-panel` | Fixed-position popup, `width:300px` — MCP manager |
| `.msg-progress` | Live tool-use list during streaming |
| `.msg-progress-summary` | `<details>` collapsed summary after `streamEnd` |
| `.msg-meta` | Hover-reveal metadata: model · effort · tokens |
| `.msg-restore-btn` | Hover-reveal checkpoint restore button |
| `.thinking-toggle` | Pill toggle in mode picker for Extended Thinking |
| `.mode-effort-row.thinking-off` | Effort row dimmed when thinking is off |
| `.fp-item.fp-added` | Greyed-out already-added file in picker |
