import * as path from 'path';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ChatHandler } from './chatHandler';
import { ChatStream } from './types';
import { UsageTracker } from './usageTracker';
import { DroppedItem, getActiveEditorContext } from './contextAssembler';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.tiff']);
const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif',  '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.tiff': 'image/tiff',
};

interface WebviewMessage {
  type: string;
  text?: string;
  command?: string;
  mode?: string;
  model?: string;
  uri?: string;
  name?: string;
  uriList?: string;
  query?: string;
}

export class ClaudeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claude.chatView';

  private _view?: vscode.WebviewView;
  private _currentCts?: vscode.CancellationTokenSource;
  private _pendingPosts: unknown[] = [];
  private _isReady = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly chatHandler: ChatHandler,
    private readonly usageTracker: UsageTracker,
    private readonly getWorkspaceRoot: () => string | undefined,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    this._isReady = false;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = this.buildHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg));
    webviewView.onDidDispose(() => { this._view = undefined; this._isReady = false; this._pendingPosts = []; });
  }

  public async sendExternalPrompt(fullPrompt: string, displayText: string): Promise<void> {
    await vscode.commands.executeCommand(`${ClaudeViewProvider.viewType}.focus`);
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) { vscode.window.showWarningMessage('No workspace folder open.'); return; }
    this._post({ type: 'addUserMessage', text: displayText });
    await this.runRequest(fullPrompt, undefined, workspaceRoot);
  }

  public async showUsage(): Promise<void> {
    await vscode.commands.executeCommand(`${ClaudeViewProvider.viewType}.focus`);
    const summary = this.usageTracker.getSummary();
    const config  = vscode.workspace.getConfiguration('claude');
    this._post({ type: 'showUsage', session: summary.sessionTokens, daily: summary.dailyTokens, weekly: summary.weeklyTokens, requests: summary.sessionRequests, dailyLimit: config.get<number>('dailyTokenLimit', 0) });
  }

  private _post(message: unknown): void {
    if (!this._view) { return; }
    if (!this._isReady) { this._pendingPosts.push(message); return; }
    this._view.webview.postMessage(message);
  }

  private _flushPending(): void {
    const pending = this._pendingPosts.splice(0);
    for (const msg of pending) { this._view?.webview.postMessage(msg); }
  }

  private _fullState() {
    const config = vscode.workspace.getConfiguration('claude');
    return { type: 'setState', model: this.chatHandler.getModel(), mode: this.chatHandler.getMode(), yoloMode: this.chatHandler.getYolo(), availableModels: config.get<string[]>('models', []) };
  }

  // ── Convert dropped item → webview attachment payload ───────────────────
  private async _toAttachmentPayload(item: DroppedItem): Promise<{ name: string; uri: string; isFolder?: boolean; dataUrl?: string }> {
    const base = { name: item.label, uri: item.uri.toString() };
    if (item.isFolder) { return { ...base, isFolder: true }; }
    const ext = path.extname(item.label).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      try {
        const bytes = await vscode.workspace.fs.readFile(item.uri);
        if (bytes.length < 5 * 1024 * 1024) {
          const mime   = IMAGE_MIME[ext] ?? 'image/png';
          const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
          return { ...base, dataUrl };
        }
      } catch { /* fall through */ }
    }
    return base;
  }

  private async _postFilesAttached(items: DroppedItem[]): Promise<void> {
    const files = await Promise.all(items.map(i => this._toAttachmentPayload(i)));
    this._post({ type: 'filesAttached', files });
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();

    switch (msg.type) {
      case 'ready':
        this._isReady = true;
        this._flushPending();
        this._post(this._fullState());
        break;

      case 'send': {
        if (!workspaceRoot) { this._post({ type: 'showError', text: 'No workspace folder open.' }); return; }
        const cmd  = msg.command;
        const text = msg.text?.trim() ?? '';
        if (cmd === 'clear') { this.chatHandler.clearSession(workspaceRoot); this._post({ type: 'clearMessages' }); return; }
        if (!text && !cmd) { return; }
        await this.runRequest(text, cmd, workspaceRoot);
        break;
      }

      case 'cancel':
        this._currentCts?.cancel();
        break;

      case 'selectModel':
        if (msg.model) { this.chatHandler.setModelDirect(msg.model); this._post({ type: 'setState', model: this.chatHandler.getModel() }); }
        break;

      case 'switchBudget':
        await this.chatHandler.switchBudget();
        break;

      case 'toggleYolo':
        this.chatHandler.toggleYolo();
        this._post({ type: 'setState', yoloMode: this.chatHandler.getYolo() });
        break;

      case 'setMode':
        if (msg.mode === 'agent' || msg.mode === 'plan') { this.chatHandler.setMode(msg.mode); }
        break;

      case 'requestContext': {
        const { selection } = getActiveEditorContext();
        if (selection) {
          this._post({ type: 'contextInfo', kind: 'selection', file: path.basename(selection.filePath), lines: selection.text.split('\n').length });
        } else {
          this._post({ type: 'contextInfo', kind: 'none' });
        }
        break;
      }

      case 'drop': {
        const rawUris = (msg.uriList ?? '').split(/\r?\n/).filter((u: string) => u.trim() && !u.startsWith('#'));
        const items   = await this._urisToItems(rawUris);
        if (items.length > 0) { this.chatHandler.addDroppedItems(items); await this._postFilesAttached(items); }
        break;
      }

      case 'searchFiles': {
        const query = (msg.query ?? '').toLowerCase().trim();
        const wsUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!wsUri) { this._post({ type: 'fileSearchResults', files: [] }); break; }
        try {
          const fileUris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.vscode-test/**}', 400);

          // Collect unique directory paths from files
          const dirSet = new Set<string>();
          fileUris.forEach(u => {
            const rel   = vscode.workspace.asRelativePath(u);
            const parts = rel.split('/');
            for (let i = 1; i < parts.length; i++) { dirSet.add(parts.slice(0, i).join('/')); }
          });

          type FR = { name: string; relPath: string; uri: string; isFolder: boolean };
          const results: FR[] = [];

          // Folders first
          Array.from(dirSet)
            .filter(d => !query || d.toLowerCase().includes(query) || path.basename(d).toLowerCase().includes(query))
            .sort()
            .slice(0, 20)
            .forEach(d => {
              const parent = path.dirname(d);
              results.push({ name: path.basename(d), relPath: parent === '.' ? '' : parent + '/', uri: vscode.Uri.joinPath(wsUri, d).toString(), isFolder: true });
            });

          // Then files
          fileUris
            .filter(u => { const rel = vscode.workspace.asRelativePath(u); return !query || rel.toLowerCase().includes(query) || path.basename(u.fsPath).toLowerCase().includes(query); })
            .sort((a, b) => vscode.workspace.asRelativePath(a).localeCompare(vscode.workspace.asRelativePath(b)))
            .slice(0, 30)
            .forEach(u => {
              const rel    = vscode.workspace.asRelativePath(u);
              const parent = path.dirname(rel);
              results.push({ name: path.basename(u.fsPath), relPath: parent === '.' ? '' : parent + '/', uri: u.toString(), isFolder: false });
            });

          this._post({ type: 'fileSearchResults', files: results.slice(0, 35) });
        } catch { this._post({ type: 'fileSearchResults', files: [] }); }
        break;
      }

      case 'addFile': {
        if (!msg.uri) { break; }
        try {
          const uri  = vscode.Uri.parse(msg.uri);
          const stat = await vscode.workspace.fs.stat(uri);
          const item: DroppedItem = { uri, label: msg.name ?? path.basename(uri.fsPath), isFolder: stat.type === vscode.FileType.Directory };
          this.chatHandler.addDroppedItems([item]);
          await this._postFilesAttached([item]);
        } catch { /* ignore */ }
        break;
      }

      case 'removeAttachment':
        if (msg.uri) { this.chatHandler.removeDroppedItemByUri(msg.uri); }
        break;
    }
  }

  private async _urisToItems(rawUris: string[]): Promise<DroppedItem[]> {
    const items: DroppedItem[] = [];
    for (const raw of rawUris) {
      try {
        const norm = raw.trim().replace(/^vscode-file:\/\/[^/]*/, '');
        const uri  = norm.startsWith('file://') ? vscode.Uri.parse(norm) : vscode.Uri.file(norm);
        const stat = await vscode.workspace.fs.stat(uri);
        items.push({ uri, label: path.basename(uri.fsPath), isFolder: stat.type === vscode.FileType.Directory });
      } catch { /* skip */ }
    }
    return items;
  }

  private async runRequest(text: string, command: string | undefined, workspaceRoot: string): Promise<void> {
    this._currentCts?.dispose();
    this._currentCts = new vscode.CancellationTokenSource();
    const token = this._currentCts.token;
    this._post({ type: 'streamStart' });
    this._post({ type: 'setStatus', status: 'thinking' });
    const stream: ChatStream = { markdown: (chunk: string) => this._post({ type: 'streamChunk', text: chunk }) };
    try {
      await this.chatHandler.chat(text, command, stream, token, workspaceRoot);
    } catch (err) {
      this._post({ type: 'streamChunk', text: `\n\n**Error:** ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      this._post({ type: 'streamEnd' });
      this._post({ type: 'setStatus', status: 'idle' });
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce     = crypto.randomBytes(16).toString('hex');
    const csp       = webview.cspSource;
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${csp} https: data: blob:; style-src ${csp}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>AVN Chat</title>
</head>
<body>

  <!-- Header -->
  <div id="header">
    <div id="status-dot"></div>
    <span id="header-title">AVN Chat</span>
    <button class="hdr-btn" title="Clear conversation" onclick="clearConversation()">&#128465;</button>
  </div>

  <!-- Messages -->
  <div id="main-area">
    <div id="messages">
      <div id="empty-state">
        <div id="empty-icon">&#10022;</div>
        <div id="empty-title">AVN Chat</div>
        <div id="empty-sub">
          Drop files or type <strong>@</strong> to attach.<br>
          Press <strong>/</strong> for quick commands.
        </div>
      </div>
    </div>

    <!-- Drop overlay -->
    <div id="drop-overlay">
      <div id="drop-plus">+</div>
      <span>Drop files or folders</span>
    </div>

    <!-- Usage overlay -->
    <div id="usage-panel" hidden>
      <div id="usage-header"><span>Token Usage</span><button id="usage-close" onclick="closeUsage()">&#215;</button></div>
      <hr class="usage-sep">
      <div class="usage-stat">
        <div class="usage-stat-header"><span class="usage-stat-label">Session</span><span class="usage-stat-value" id="session-val">—</span></div>
        <div class="usage-track"><div class="usage-fill" id="session-fill" style="width:0%"></div></div>
      </div>
      <div class="usage-stat">
        <div class="usage-stat-header"><span class="usage-stat-label">Today</span><span class="usage-stat-value" id="daily-val">—</span></div>
        <div class="usage-track"><div class="usage-fill" id="daily-fill" style="width:0%"></div></div>
      </div>
      <div class="usage-stat">
        <div class="usage-stat-header"><span class="usage-stat-label">This week</span><span class="usage-stat-value" id="weekly-val">—</span></div>
        <div class="usage-track"><div class="usage-fill" id="weekly-fill" style="width:0%"></div></div>
      </div>
      <div id="usage-requests">—</div>
    </div>
  </div>

  <!-- Commands picker -->
  <div id="cmd-picker" hidden>
    <div class="cp-group">
      <div class="cp-group-label">Quick Actions</div>
      <button class="cp-item" data-cmd="fix">
        <span class="cp-cmd">/fix</span><span class="cp-desc">Fix issues in the current file</span>
      </button>
      <button class="cp-item" data-cmd="explain">
        <span class="cp-cmd">/explain</span><span class="cp-desc">Explain the current file</span>
      </button>
    </div>
    <div class="cp-group">
      <div class="cp-group-label">Project</div>
      <button class="cp-item" data-cmd="index">
        <span class="cp-cmd">/index</span><span class="cp-desc">Index project files for context</span>
      </button>
    </div>
    <div class="cp-group">
      <div class="cp-group-label">Conversation</div>
      <button class="cp-item" data-cmd="help">
        <span class="cp-cmd">/help</span><span class="cp-desc">Show all available commands</span>
      </button>
      <button class="cp-item" data-cmd="clear">
        <span class="cp-cmd">/clear</span><span class="cp-desc">Clear conversation history</span>
      </button>
    </div>
  </div>

  <!-- File picker -->
  <div id="file-picker" hidden>
    <div id="fp-header">
      <span>Add file or folder</span>
      <button id="fp-close" onclick="closeFilePicker(true)">&#215;</button>
    </div>
    <input id="fp-search" type="text" placeholder="Search files and folders…" autocomplete="off" spellcheck="false">
    <div id="fp-results"></div>
  </div>

  <!-- Floating input card -->
  <div id="input-card">
    <div id="ctx-line" hidden>
      <span id="ctx-text-inner"></span>
      <button id="ctx-dismiss-btn" onclick="dismissCtx()" title="Dismiss">&#215;</button>
    </div>
    <div id="input-main">
      <textarea id="user-input" placeholder="Message AVN Chat…" rows="1"></textarea>
      <button id="mic-btn" title="Voice input (coming soon)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" opacity=".5">
          <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 3.01-3.03 5.36-6.01 5.93V19h2a1 1 0 010 2H9a1 1 0 010-2h2v-2.07C7.12 16.36 4.58 14.01 4.09 11H5.1c.47 2.49 2.67 4.36 5.22 4.89a7.003 7.003 0 007.37-4.89h1.22z"/>
        </svg>
      </button>
    </div>
    <div id="input-toolbar">
      <button id="add-btn"  onclick="openAddFiles()"   title="Add files (+)">+</button>
      <button id="cmd-btn"  onclick="toggleCmdPicker()" title="Commands (/)">&#8725;</button>
      <div id="tb-chips"></div>
      <button id="send-btn" onclick="handleSend()"      title="Send (Enter)" disabled>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
        </svg>
      </button>
    </div>
  </div>

  <!-- Bottom: model picker + footer -->
  <div id="bottom-wrap">
    <div id="model-picker" hidden>
      <div id="mp-title">Select Model</div>
      <div id="mp-list"></div>
    </div>
    <div id="footer">
      <button id="model-btn" title="Click to switch model" onclick="toggleModelPicker()">avnchat</button>
      <div id="mode-toggle">
        <button class="mode-btn active" data-mode="agent">Agent</button>
        <button class="mode-btn"        data-mode="plan">Plan</button>
      </div>
      <button id="yolo-btn" title="Toggle YOLO — skip permission prompts">YOLO</button>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
