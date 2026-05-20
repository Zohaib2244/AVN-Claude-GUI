import * as path from 'path';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';
import { ChatHandler } from './chatHandler';
import { ChatStream, ThinkingBudget } from './types';
import { UsageTracker } from './usageTracker';
import { DroppedItem, getActiveEditorContext } from './contextAssembler';
import { SessionManager } from './sessionManager';

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
  sessionId?: string;
  displayMode?: string;
  effort?: string;
  dataUrl?: string;
  mimeType?: string;
  currentFileRef?: string;
  mcpName?: string;
  checkpointHash?: string;
}

export class ClaudeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claude.chatView';

  private _view?: vscode.WebviewView;
  private _currentCts?: vscode.CancellationTokenSource;
  private _pendingPosts: unknown[] = [];
  private _isReady = false;
  private _tempFiles: string[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly chatHandler: ChatHandler,
    private readonly usageTracker: UsageTracker,
    private readonly getWorkspaceRoot: () => string | undefined,
  ) {}

  private get _sessionManager(): SessionManager { return this.chatHandler.getSessionManager(); }

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

    const disposables: vscode.Disposable[] = [];
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!this._isReady) { return; }
      const name = editor ? path.basename(editor.document.fileName) : null;
      const uri  = editor ? vscode.Uri.file(editor.document.fileName).toString() : null;
      this._post({ type: 'currentFile', name, uri });
    }, null, disposables);

    webviewView.onDidDispose(() => { disposables.forEach(d => d.dispose()); this._cleanupTempFiles(); this._view = undefined; this._isReady = false; this._pendingPosts = []; });
  }

  public async sendExternalPrompt(fullPrompt: string, displayText: string): Promise<void> {
    await vscode.commands.executeCommand(`${ClaudeViewProvider.viewType}.focus`);
    const root = this.getWorkspaceRoot();
    if (!root) { vscode.window.showWarningMessage('No workspace folder open.'); return; }
    this._post({ type: 'addUserMessage', text: displayText });
    await this.runRequest(fullPrompt, undefined, root);
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

  private _pushSessions(root: string): void {
    const sessions  = this._sessionManager.list(root);
    const activeId  = this._sessionManager.activeId(root);
    this._post({ type: 'updateSessions', sessions, activeId });
  }

  private _fullState(root?: string) {
    const config = vscode.workspace.getConfiguration('claude');
    return {
      type:            'setState',
      model:           this.chatHandler.getModel(),
      displayMode:     this.chatHandler.getDisplayMode(),
      effort:          this.chatHandler.getEffort() ?? null,
      availableModels: config.get<string[]>('models', []),
    };
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    const root = this.getWorkspaceRoot();

    switch (msg.type) {

      case 'ready':
        this._isReady = true;
        this._flushPending();
        this._post(this._fullState());
        if (root) { this._pushSessions(root); }
        break;

      case 'send': {
        if (!root) { this._post({ type: 'showError', text: 'No workspace folder open.' }); return; }
        const cmd  = msg.command;
        const text = msg.text?.trim() ?? '';
        if (cmd === 'clear') {
          this.chatHandler.clearSession(root);
          this._post({ type: 'clearMessages' });
          if (root) { this._pushSessions(root); }
          return;
        }
        if (!text && !cmd) { return; }
        if (msg.currentFileRef) {
          try {
            const refUri = vscode.Uri.parse(msg.currentFileRef);
            const stat   = await vscode.workspace.fs.stat(refUri);
            this.chatHandler.addDroppedItems([{ uri: refUri, label: path.basename(refUri.fsPath), isFolder: stat.type === vscode.FileType.Directory }]);
          } catch { /* ignore */ }
        }
        await this.runRequest(text, cmd, root);
        if (root) { this._pushSessions(root); }
        break;
      }

      case 'cancel':
        this._currentCts?.cancel();
        break;

      // ── Session CRUD ────────────────────────────────────────────────────
      case 'createSession': {
        if (!root) { break; }
        this.chatHandler.createNewSession(root);
        this._post({ type: 'clearMessages' });
        this._post(this._fullState());
        this._pushSessions(root);
        break;
      }

      case 'switchSession': {
        if (!root || !msg.sessionId) { break; }
        const s = this.chatHandler.switchSession(root, msg.sessionId);
        if (s) {
          this._post({ type: 'clearMessages' });
          this._post(this._fullState());
          this._pushSessions(root);
        }
        break;
      }

      case 'deleteSession': {
        if (!root || !msg.sessionId) { break; }
        const nextId = this._sessionManager.delete(root, msg.sessionId);
        // If deleted session was active, switch to the next
        if (nextId) {
          this.chatHandler.switchSession(root, nextId);
          this._post({ type: 'clearMessages' });
          this._post(this._fullState());
        }
        this._pushSessions(root);
        break;
      }

      case 'renameSession': {
        if (!root || !msg.sessionId || !msg.name) { break; }
        this._sessionManager.rename(root, msg.sessionId, msg.name);
        this._pushSessions(root);
        break;
      }

      // ── Model / mode / yolo ────────────────────────────────────────────
      case 'selectModel':
        if (msg.model) { this.chatHandler.setModelDirect(msg.model); this._post({ type: 'setState', model: this.chatHandler.getModel() }); }
        break;

      case 'toggleYolo':
        this.chatHandler.toggleYolo();
        break;

      case 'setMode':
        if (msg.mode === 'agent' || msg.mode === 'plan') { this.chatHandler.setMode(msg.mode); }
        break;

      case 'selectMode': {
        const dm = msg.displayMode as 'ask' | 'auto' | 'plan' | undefined;
        if (dm) {
          this.chatHandler.setDisplayMode(dm);
          this._post({ type: 'setState', displayMode: this.chatHandler.getDisplayMode() });
        }
        break;
      }

      case 'setEffort': {
        const effort = (msg.effort || undefined) as ThinkingBudget | undefined;
        this.chatHandler.setEffort(effort);
        break;
      }

      case 'pasteImage': {
        if (!msg.dataUrl) { break; }
        try {
          const b64match = msg.dataUrl.match(/^data:[^;]+;base64,(.+)$/);
          if (!b64match) { break; }
          const mimeType = msg.mimeType ?? 'image/png';
          const ext      = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
          const tmpPath  = path.join(os.tmpdir(), `avn-paste-${Date.now()}.${ext}`);
          fs.writeFileSync(tmpPath, Buffer.from(b64match[1], 'base64'));
          this._tempFiles.push(tmpPath);
          const uri  = vscode.Uri.file(tmpPath);
          const item: DroppedItem = { uri, label: `pasted-image.${ext}`, isFolder: false };
          this.chatHandler.addDroppedItems([item]);
          await this._postFilesAttached([item]);
        } catch { /* ignore */ }
        break;
      }

      case 'switchBudget':
        await this.chatHandler.switchBudget();
        break;

      // ── Context ────────────────────────────────────────────────────────
      case 'requestContext': {
        const { selection, activeFile } = getActiveEditorContext();
        if (selection) {
          this._post({ type: 'contextInfo', kind: 'selection', file: path.basename(selection.filePath), lines: selection.text.split('\n').length });
        } else {
          this._post({ type: 'contextInfo', kind: 'none' });
        }
        const curFile = selection || activeFile;
        this._post({ type: 'currentFile', name: curFile ? path.basename(curFile.filePath) : null, uri: curFile ? vscode.Uri.file(curFile.filePath).toString() : null });
        break;
      }

      // ── File drop ──────────────────────────────────────────────────────
      case 'drop': {
        const rawUris = (msg.uriList ?? '').split(/\r?\n/).filter((u: string) => u.trim() && !u.startsWith('#'));
        const items   = await this._urisToItems(rawUris);
        if (items.length > 0) { this.chatHandler.addDroppedItems(items); await this._postFilesAttached(items); }
        break;
      }

      // ── @ file search ──────────────────────────────────────────────────
      case 'searchFiles': {
        const query = (msg.query ?? '').toLowerCase().trim();
        const wsUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!wsUri) { this._post({ type: 'fileSearchResults', files: [] }); break; }
        try {
          const fileUris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}', 400);
          const dirSet   = new Set<string>();
          fileUris.forEach(u => {
            const rel = vscode.workspace.asRelativePath(u);
            const parts = rel.split('/');
            for (let i = 1; i < parts.length; i++) { dirSet.add(parts.slice(0, i).join('/')); }
          });
          type FR = { name: string; relPath: string; uri: string; isFolder: boolean; ext: string };
          const results: FR[] = [];
          Array.from(dirSet)
            .filter(d => !query || d.toLowerCase().includes(query) || path.basename(d).toLowerCase().includes(query))
            .sort().slice(0, 20)
            .forEach(d => { const parent = path.dirname(d); results.push({ name: path.basename(d), relPath: parent === '.' ? '' : parent + '/', uri: vscode.Uri.joinPath(wsUri, d).toString(), isFolder: true, ext: '' }); });
          fileUris
            .filter(u => { const rel = vscode.workspace.asRelativePath(u); return !query || rel.toLowerCase().includes(query) || path.basename(u.fsPath).toLowerCase().includes(query); })
            .sort((a, b) => vscode.workspace.asRelativePath(a).localeCompare(vscode.workspace.asRelativePath(b)))
            .slice(0, 30)
            .forEach(u => { const rel = vscode.workspace.asRelativePath(u); const parent = path.dirname(rel); results.push({ name: path.basename(u.fsPath), relPath: parent === '.' ? '' : parent + '/', uri: u.toString(), isFolder: false, ext: path.extname(u.fsPath).slice(1).toLowerCase() }); });
          this._post({ type: 'fileSearchResults', files: results.slice(0, 35) });
        } catch { this._post({ type: 'fileSearchResults', files: [] }); }
        break;
      }

      // ── Add file via @ picker ──────────────────────────────────────────
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

      case 'clearAttachments':
        this.chatHandler.clearDroppedItems();
        break;

      case 'restoreCheckpoint': {
        if (!root || !msg.checkpointHash) { break; }
        const confirmed = await vscode.window.showWarningMessage(
          `Restore workspace to the git state before this prompt? Uncommitted changes since then will be lost.`,
          { modal: true }, 'Restore', 'Cancel',
        );
        if (confirmed !== 'Restore') { break; }
        const ok = await this._gitRestore(msg.checkpointHash, root);
        if (ok) {
          vscode.window.showInformationMessage('Workspace restored to checkpoint.');
        } else {
          vscode.window.showErrorMessage('Failed to restore checkpoint. Make sure git is available and the workspace is a git repository.');
        }
        break;
      }

      case 'getMCPs':
        this._post({ type: 'mcpList', mcps: this._getMCPs() });
        break;

      case 'toggleMCP': {
        if (msg.mcpName) { this._toggleMCP(msg.mcpName); }
        this._post({ type: 'mcpList', mcps: this._getMCPs() });
        break;
      }

      case 'removeMCP': {
        if (msg.mcpName) { this._removeMCP(msg.mcpName); }
        this._post({ type: 'mcpList', mcps: this._getMCPs() });
        break;
      }

      case 'addMCP': {
        await this._promptAddMCP();
        this._post({ type: 'mcpList', mcps: this._getMCPs() });
        break;
      }
    }
  }

  private async _toAttachmentPayload(item: DroppedItem) {
    const base = { name: item.label, uri: item.uri.toString() };
    if (item.isFolder) { return { ...base, isFolder: true }; }
    const ext = path.extname(item.label).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      try {
        const bytes = await vscode.workspace.fs.readFile(item.uri);
        if (bytes.length < 5 * 1024 * 1024) {
          const mime    = IMAGE_MIME[ext] ?? 'image/png';
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

  private async runRequest(text: string, command: string | undefined, root: string): Promise<void> {
    this._currentCts?.dispose();
    this._currentCts = new vscode.CancellationTokenSource();
    const token = this._currentCts.token;
    const checkpointHash = await this._gitHash(root);
    this._post({ type: 'streamStart' });
    this._post({ type: 'setStatus', status: 'thinking' });
    let endStats: { inputTokens: number; outputTokens: number; model: string; effort?: string } | undefined;
    const stream: ChatStream = {
      markdown: (chunk: string) => this._post({ type: 'streamChunk', text: chunk }),
      progress: (toolName: string, toolInput: Record<string, unknown>) => this._post({ type: 'progressEvent', toolName, toolInput }),
      done:     (stats) => { endStats = stats; },
    };
    try {
      await this.chatHandler.chat(text, command, stream, token, root);
    } catch (err) {
      this._post({ type: 'streamChunk', text: `\n\n**Error:** ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      this._post({ type: 'streamEnd', ...(endStats ?? { model: this.chatHandler.getModel() }), checkpointHash });
      this._post({ type: 'setStatus', status: 'idle' });
    }
  }

  private _claudeSettingsPath(): string { return path.join(os.homedir(), '.claude.json'); }

  private _readClaudeSettings(): Record<string, unknown> {
    try { return JSON.parse(fs.readFileSync(this._claudeSettingsPath(), 'utf8')) as Record<string, unknown>; }
    catch { return {}; }
  }

  private _writeClaudeSettings(settings: Record<string, unknown>): void {
    fs.writeFileSync(this._claudeSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  }

  private _getMCPs(): Array<{ name: string; command: string; disabled: boolean }> {
    const settings = this._readClaudeSettings();
    const servers  = (settings.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
    const disabled = (settings.disabledMcpServers ?? []) as string[];
    return Object.entries(servers).map(([name, cfg]) => ({
      name, command: String(cfg.command ?? ''), disabled: disabled.includes(name),
    }));
  }

  private _toggleMCP(name: string): void {
    const settings = this._readClaudeSettings();
    const disabled = [...((settings.disabledMcpServers ?? []) as string[])];
    const idx = disabled.indexOf(name);
    if (idx >= 0) { disabled.splice(idx, 1); } else { disabled.push(name); }
    settings.disabledMcpServers = disabled;
    this._writeClaudeSettings(settings);
  }

  private _removeMCP(name: string): void {
    const settings = this._readClaudeSettings();
    const servers = (settings.mcpServers ?? {}) as Record<string, unknown>;
    delete servers[name];
    settings.mcpServers = servers;
    this._writeClaudeSettings(settings);
  }

  private async _promptAddMCP(): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: 'MCP server name (e.g. brave-search)', ignoreFocusOut: true });
    if (!name) { return; }
    const cmd = await vscode.window.showInputBox({ prompt: 'Command + args (e.g. npx -y @mcp/package)', ignoreFocusOut: true });
    if (!cmd) { return; }
    const parts = cmd.trim().split(/\s+/);
    const settings = this._readClaudeSettings();
    const servers = (settings.mcpServers ?? {}) as Record<string, unknown>;
    servers[name] = { type: 'stdio', command: parts[0], args: parts.slice(1) };
    settings.mcpServers = servers;
    this._writeClaudeSettings(settings);
    vscode.window.showInformationMessage(`MCP "${name}" added. Restart the session to apply.`);
  }

  private async _gitHash(cwd: string): Promise<string | undefined> {
    return new Promise(resolve => {
      cp.exec('git rev-parse HEAD', { cwd }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined));
    });
  }

  private async _gitRestore(hash: string, cwd: string): Promise<boolean> {
    return new Promise(resolve => {
      cp.exec(`git reset --hard ${hash}`, { cwd }, (err) => resolve(!err));
    });
  }

  private _cleanupTempFiles(): void {
    for (const f of this._tempFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    this._tempFiles = [];
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce       = crypto.randomBytes(16).toString('hex');
    const csp         = webview.cspSource;
    const styleUri    = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
    const scriptUri   = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js'));
    const iconBaseUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icons'));

    const HAND_SVG   = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`;
    const CODE_SVG   = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
    const PLAN_SVG   = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1.5"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/></svg>`;
    const EFFORT_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="8" cy="6" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="16" cy="12" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="12" cy="18" r="2" fill="currentColor" stroke="none"/></svg>`;
    const FILE_SVG   = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
    const BRAIN_SVG  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3z"/></svg>`;
    const TOOLS_SVG  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${csp} https: data: blob:; style-src ${csp}; script-src 'nonce-${nonce}';">
  <meta name="icon-base" content="${iconBaseUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>AVN Chat</title>
</head>
<body>

  <!-- Header -->
  <div id="header">
    <div id="status-dot"></div>
    <span id="header-title">AVN Chat</span>
    <button class="hdr-btn" id="sessions-btn" title="Sessions">&#9776;</button>
    <button class="hdr-btn" id="clear-btn"    title="Clear conversation">&#128465;</button>
  </div>

  <!-- Main scroll area -->
  <div id="main-area">
    <div id="messages">
      <div id="empty-state">
        <div id="empty-icon">&#10022;</div>
        <div id="empty-title">AVN Chat</div>
        <div id="empty-sub">Drop files or type <strong>@</strong> to attach.<br>Press <strong>/</strong> for quick commands.</div>
      </div>
    </div>

    <!-- Drop overlay -->
    <div id="drop-overlay">
      <div id="drop-plus">+</div>
      <span>Drop files or folders</span>
    </div>

    <!-- Sessions panel (overlay) -->
    <div id="sessions-panel" hidden>
      <div id="sp-header">
        <span id="sp-title">Sessions</span>
        <button id="sp-new"   title="New session">+ New</button>
        <button id="sp-close" title="Close">&#215;</button>
      </div>
      <div id="sp-list"></div>
    </div>

    <!-- Usage panel (overlay) -->
    <div id="usage-panel" hidden>
      <div id="usage-header"><span>Token Usage</span><button id="usage-close">&#215;</button></div>
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
      <button class="cp-item" data-cmd="fix"><span class="cp-cmd">/fix</span><span class="cp-desc">Fix issues in the current file</span></button>
      <button class="cp-item" data-cmd="explain"><span class="cp-cmd">/explain</span><span class="cp-desc">Explain the current file</span></button>
    </div>
    <div class="cp-group">
      <div class="cp-group-label">Project</div>
      <button class="cp-item" data-cmd="index"><span class="cp-cmd">/index</span><span class="cp-desc">Index project files for context</span></button>
    </div>
    <div class="cp-group">
      <div class="cp-group-label">Conversation</div>
      <button class="cp-item" data-cmd="help"><span class="cp-cmd">/help</span><span class="cp-desc">Show all available commands</span></button>
      <button class="cp-item" data-cmd="clear"><span class="cp-cmd">/clear</span><span class="cp-desc">Clear conversation history</span></button>
    </div>
  </div>

  <!-- File picker -->
  <div id="file-picker" hidden>
    <div id="fp-header">
      <span>Add file or folder</span>
      <button id="fp-close">&#215;</button>
    </div>
    <input id="fp-search" type="text" placeholder="Search files and folders…" autocomplete="off" spellcheck="false">
    <div id="fp-results"></div>
  </div>

  <!-- Floating input card (3 separated regions) -->
  <div id="input-card">

    <!-- TOP: current file · attached chips · selected context -->
    <div id="input-top" hidden>
      <div id="ctx-line" hidden>
        <span id="ctx-text-inner"></span>
        <button id="ctx-dismiss-btn" title="Dismiss">&#215;</button>
      </div>
      <div id="tb-chips">
        <button id="cur-file-btn" hidden title="Include current file in context">${FILE_SVG}<span id="cur-file-name"></span></button>
      </div>
    </div>

    <!-- MIDDLE: text input -->
    <div id="input-middle">
      <textarea id="user-input" placeholder="Message AVN Chat…" rows="1"></textarea>
    </div>

    <!-- BOTTOM: action bar -->
    <div id="input-bottom">
      <button id="add-btn" title="Add files (+)">+</button>
      <button id="cmd-btn" title="Commands (/)">&#8725;</button>
      <button id="model-btn" title="Click to switch model">avnchat</button>
      <button id="display-mode-btn" title="Switch mode">
        <span class="dm-opt" data-dm="ask">${HAND_SVG}<span>Ask before edits</span></span>
        <span class="dm-opt" data-dm="auto">${CODE_SVG}<span>Edit automatically</span></span>
        <span class="dm-opt" data-dm="plan">${PLAN_SVG}<span>Plan mode</span></span>
      </button>
      <button id="tools-btn" title="Tools &amp; MCP Servers">${TOOLS_SVG}</button>
      <div class="btn-spacer"></div>
      <button id="mic-btn" title="Voice input (coming soon)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" opacity=".5">
          <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 3.01-3.03 5.36-6.01 5.93V19h2a1 1 0 010 2H9a1 1 0 010-2h2v-2.07C7.12 16.36 4.58 14.01 4.09 11H5.1c.47 2.49 2.67 4.36 5.22 4.89a7.003 7.003 0 007.37-4.89h1.22z"/>
        </svg>
      </button>
      <button id="send-btn" title="Send (Enter)" disabled>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
        </svg>
      </button>
    </div>
  </div>

  <!-- Popup pickers: fixed-position, positioned by JS near their trigger buttons -->
  <div id="model-picker" hidden>
    <div id="mp-title">Select Model</div>
    <div id="mp-list"></div>
  </div>
  <div id="mode-picker" hidden>
    <div class="mp2-header">
      <span class="mp2-title">Modes</span>
      <span class="mp2-hint">&#8679; + tab to switch</span>
    </div>
    <button class="mode-item" data-display-mode="ask">
      <div class="mode-item-icon">${HAND_SVG}</div>
      <div class="mode-item-text">
        <span class="mode-item-name">Ask before edits</span>
        <span class="mode-item-desc">Claude will ask for approval before making each edit</span>
      </div>
      <span class="mode-item-check">&#10003;</span>
    </button>
    <button class="mode-item" data-display-mode="auto">
      <div class="mode-item-icon">${CODE_SVG}</div>
      <div class="mode-item-text">
        <span class="mode-item-name">Edit automatically</span>
        <span class="mode-item-desc">Claude will edit your selected text or the whole file</span>
      </div>
      <span class="mode-item-check">&#10003;</span>
    </button>
    <button class="mode-item" data-display-mode="plan">
      <div class="mode-item-icon">${PLAN_SVG}</div>
      <div class="mode-item-text">
        <span class="mode-item-name">Plan mode</span>
        <span class="mode-item-desc">Claude will explore the code and present a plan before editing</span>
      </div>
      <span class="mode-item-check">&#10003;</span>
    </button>
    <div class="mode-thinking-row">
      <div class="mode-item-icon">${BRAIN_SVG}</div>
      <span class="mode-effort-label">Extended Thinking</span>
      <button id="thinking-toggle" class="thinking-toggle" title="Toggle extended thinking"><div class="thinking-toggle-knob"></div></button>
    </div>
    <div class="mode-effort-row" id="effort-row">
      <div class="mode-item-icon">${EFFORT_SVG}</div>
      <span class="mode-effort-label">Effort</span>
      <span id="effort-level-text"></span>
      <div id="effort-dots">
        <button class="effort-dot" data-level="low"    title="Low effort"></button>
        <button class="effort-dot" data-level="medium" title="Medium effort"></button>
        <button class="effort-dot" data-level="high"   title="High effort"></button>
      </div>
    </div>
  </div>

  <!-- Tools / MCP panel (fixed popup) -->
  <div id="tools-panel" hidden>
    <div class="tp-header">
      <span class="tp-title">MCP Servers</span>
      <button id="tp-close">&#215;</button>
    </div>
    <div id="tp-list"></div>
    <div class="tp-footer">
      <button id="tp-add-btn">+ Add MCP</button>
      <span class="tp-hint">Changes take effect on next session</span>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
