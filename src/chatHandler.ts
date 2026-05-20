import * as vscode from 'vscode';
import * as path from 'path';
import { ProcessManager, isAuthError } from './processManager';
import { StatusBarManager } from './statusBar';
import { UsageTracker } from './usageTracker';
import { assembleContext, getActiveEditorContext, DroppedItem } from './contextAssembler';
import { SessionManager, ChatSession } from './sessionManager';
import { ProjectIndexer } from './projectIndexer';
import { ChatStream, ClaudeStreamEvent, ThinkingBudget, SymbolRef } from './types';

export interface SessionState {
  activeSessionId: string | undefined;
  claudeSessionId: string | undefined;  // the --resume ID for the CLI
  model: string;
  yoloMode: boolean;
  thinkingBudget: ThinkingBudget | undefined;
  droppedItems: DroppedItem[];
  symbolRefs: SymbolRef[];
  mode: 'agent' | 'plan';
}

export class ChatHandler {
  private state: SessionState;

  constructor(
    private processManager: ProcessManager,
    private statusBar: StatusBarManager,
    private usageTracker: UsageTracker,
    private context: vscode.ExtensionContext,
    private getWorkspaceRoot: () => string | undefined,
    private sessionManager: SessionManager,
  ) {
    const ws     = context.workspaceState;
    const config = vscode.workspace.getConfiguration('claude');
    this.state = {
      activeSessionId:  undefined,
      claudeSessionId:  undefined,
      model:            ws.get('selectedModel', config.get('defaultModel', 'claude-sonnet-4-5')),
      yoloMode:         ws.get('yoloMode', false),
      thinkingBudget:   ws.get('thinkingBudget', undefined),
      droppedItems:     [],
      symbolRefs:       [],
      mode:             ws.get('mode', 'agent') as 'agent' | 'plan',
    };
    this.statusBar.setYolo(this.state.yoloMode);
    this.statusBar.setModel(this.state.model);
    this.statusBar.setBudget(this.state.thinkingBudget);
  }

  // ── Getters ────────────────────────────────────────────────────────────────
  getModel():     string           { return this.state.model; }
  getYolo():      boolean          { return this.state.yoloMode; }
  getMode():      'agent' | 'plan' { return this.state.mode; }
  getSessionId(): string | undefined { return this.state.claudeSessionId; }
  getSessionManager(): SessionManager { return this.sessionManager; }

  getDisplayMode(): 'ask' | 'auto' | 'plan' {
    if (this.state.mode === 'plan') { return 'plan'; }
    return this.state.yoloMode ? 'auto' : 'ask';
  }

  getEffort(): ThinkingBudget | undefined { return this.state.thinkingBudget; }

  // ── Setters ────────────────────────────────────────────────────────────────
  setMode(mode: 'agent' | 'plan'): void {
    this.state.mode = mode;
    this.context.workspaceState.update('mode', mode);
    const root = this.getWorkspaceRoot();
    if (root && this.state.activeSessionId) {
      this.sessionManager.update(root, this.state.activeSessionId, { mode });
    }
  }

  setModelDirect(model: string): void {
    this.state.model = model;
    this.context.workspaceState.update('selectedModel', model);
    this.statusBar.setModel(model);
    const root = this.getWorkspaceRoot();
    if (root && this.state.activeSessionId) {
      this.sessionManager.update(root, this.state.activeSessionId, { model });
    }
  }

  toggleYolo(): void {
    this.state.yoloMode = !this.state.yoloMode;
    this.context.workspaceState.update('yoloMode', this.state.yoloMode);
    this.statusBar.setYolo(this.state.yoloMode);
  }

  setDisplayMode(dm: 'ask' | 'auto' | 'plan'): void {
    if (dm === 'plan') {
      this.state.mode    = 'plan';
      this.state.yoloMode = false;
    } else if (dm === 'auto') {
      this.state.mode    = 'agent';
      this.state.yoloMode = true;
    } else {
      this.state.mode    = 'agent';
      this.state.yoloMode = false;
    }
    this.context.workspaceState.update('mode', this.state.mode);
    this.context.workspaceState.update('yoloMode', this.state.yoloMode);
    this.statusBar.setYolo(this.state.yoloMode);
    const root = this.getWorkspaceRoot();
    if (root && this.state.activeSessionId) {
      this.sessionManager.update(root, this.state.activeSessionId, { mode: this.state.mode });
    }
  }

  setEffort(level: ThinkingBudget | undefined): void {
    this.state.thinkingBudget = level;
    this.context.workspaceState.update('thinkingBudget', level);
    this.statusBar.setBudget(level);
  }

  removeDroppedItemByUri(uriStr: string): void {
    const idx = this.state.droppedItems.findIndex(i => i.uri.toString() === uriStr);
    if (idx >= 0) { this.state.droppedItems.splice(idx, 1); }
  }

  // ── Session management helpers (called by provider) ────────────────────────
  /** Load the active session from SessionManager (called once per workspace open). */
  private loadSession(root: string): void {
    const s = this.sessionManager.ensureActive(root, this.state.model, this.state.mode);
    this.state.activeSessionId  = s.id;
    this.state.claudeSessionId  = s.claudeSessionId;
    this.state.model            = s.model;
    this.state.mode             = s.mode;
    this.statusBar.setModel(this.state.model);
  }

  /** Switch to a different existing session. */
  switchSession(root: string, sessionId: string): ChatSession | undefined {
    const sessions = this.sessionManager.list(root);
    const target   = sessions.find(s => s.id === sessionId);
    if (!target) { return undefined; }
    this.sessionManager.setActive(root, target.id);
    this.state.activeSessionId = target.id;
    this.state.claudeSessionId = target.claudeSessionId;
    this.state.model           = target.model;
    this.state.mode            = target.mode;
    this.statusBar.setModel(this.state.model);
    return target;
  }

  /** Create a brand-new session and make it active. */
  createNewSession(root: string): ChatSession {
    const s = this.sessionManager.create(root, undefined, this.state.model, this.state.mode);
    this.state.activeSessionId = s.id;
    this.state.claudeSessionId = undefined;
    return s;
  }

  /** Clear the current session context (called by the 'clear' command). */
  clearSession(root: string): void {
    // Wipe the Claude CLI session ID so the next turn starts fresh
    this.state.claudeSessionId = undefined;
    if (this.state.activeSessionId) {
      this.sessionManager.update(root, this.state.activeSessionId, { claudeSessionId: undefined, preview: '' });
    }
  }

  // ── Main entry point ───────────────────────────────────────────────────────
  async chat(
    userText: string,
    command: string | undefined,
    response: ChatStream,
    token: vscode.CancellationToken,
    workspaceRoot: string,
  ): Promise<void> {
    // Load active session on first use
    if (!this.state.activeSessionId) { this.loadSession(workspaceRoot); }

    if (command === 'index')   { await this.doIndex(workspaceRoot, response, token); return; }
    if (command === 'help')    { this.doHelp(response); return; }
    if (command === 'fix')     { await this.doFileAction('fix', workspaceRoot, response, token); return; }
    if (command === 'explain') { await this.doFileAction('explain', workspaceRoot, response, token); return; }

    const { selection } = getActiveEditorContext();
    const { prompt }    = await assembleContext(userText, workspaceRoot, this.state.droppedItems, selection, undefined, this.state.symbolRefs);
    this.state.droppedItems = [];
    this.state.symbolRefs   = [];

    const finalPrompt = this.state.mode === 'plan'
      ? '<instruction>\nPlan mode: Analyze and outline an implementation plan carefully. Do NOT write or modify any files.\n</instruction>\n\n' + prompt
      : prompt;

    // Update session preview with the user text
    if (this.state.activeSessionId) {
      this.sessionManager.update(workspaceRoot, this.state.activeSessionId, {
        preview: userText.slice(0, 60),
        model:   this.state.model,
        mode:    this.state.mode,
      });
    }

    await this.runClaude(finalPrompt, workspaceRoot, response, token);
  }

  // ── Claude invocation ──────────────────────────────────────────────────────
  async runClaude(
    prompt: string,
    workspaceRoot: string,
    response: ChatStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());
    this.statusBar.setStatus('thinking');

    const collectedText: string[] = [];
    let inputTokens = 0, outputTokens = 0;
    let lastError: string | undefined;

    await new Promise<void>((resolve) => {
      this.processManager.invoke(prompt, {
        model:         this.state.model,
        yoloMode:      this.state.yoloMode,
        effortLevel:   this.getEffortLevel(),
        sessionId:     this.state.claudeSessionId,
        workspaceRoot,
        signal:        abort.signal,
        onEvent: (ev: ClaudeStreamEvent) => {
          if (ev.session_id) { this.state.claudeSessionId = ev.session_id; }
          if (ev.type === 'assistant' && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === 'text' && block.text) { collectedText.push(block.text); response.markdown(block.text); }
              if (block.type === 'tool_use' && block.name && response.progress) {
                response.progress(block.name, (block.input ?? {}) as Record<string, unknown>);
              }
            }
            if (ev.message.usage) {
              inputTokens  += ev.message.usage.input_tokens  ?? 0;
              outputTokens += ev.message.usage.output_tokens ?? 0;
            }
          }
          if (ev.type === 'result') {
            if (ev.usage) { inputTokens = ev.usage.input_tokens ?? inputTokens; outputTokens = ev.usage.output_tokens ?? outputTokens; }
            if (ev.subtype === 'error' && ev.error) { lastError = ev.error; }
          }
        },
        onError: (err) => {
          response.markdown(err.message === 'ENOENT'
            ? '**Claude CLI not found.** Install from [claude.ai/code](https://claude.ai/code) and ensure it is on your PATH.'
            : `**CLI error:** ${err.message}`);
          this.statusBar.setStatus('error');
          resolve();
        },
        onDone: (sid) => { if (sid) { this.state.claudeSessionId = sid; } resolve(); },
      });
    });

    if (response.done) {
      response.done({ inputTokens, outputTokens, model: this.state.model, effort: this.state.thinkingBudget });
    }

    this.statusBar.setStatus('idle');

    if (lastError) {
      if (isAuthError(lastError)) {
        vscode.window.showErrorMessage('Claude CLI is not authenticated. Run `claude login` in your terminal.');
      } else {
        response.markdown(`\n\n**Error:** ${lastError}`);
      }
    }

    if (inputTokens || outputTokens) {
      this.usageTracker.record(inputTokens, outputTokens);
      this.statusBar.refreshTokens();
    }

    // Persist the CLI session ID back to the session record
    const root = this.getWorkspaceRoot();
    if (root && this.state.activeSessionId && this.state.claudeSessionId) {
      this.sessionManager.update(root, this.state.activeSessionId, { claudeSessionId: this.state.claudeSessionId });
    }

    await this.applyFileEdits(collectedText.join(''), workspaceRoot, response, abort.signal.aborted);
  }

  private async applyFileEdits(
    responseText: string,
    workspaceRoot: string,
    response: ChatStream,
    cancelled: boolean,
  ): Promise<void> {
    const fileBlockRegex = /```(?:\w+)?:([^\n]+)\n([\s\S]*?)```/g;
    const edits: Array<{ filePath: string; content: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = fileBlockRegex.exec(responseText)) !== null) {
      const relPath = match[1].trim();
      const content = match[2];
      const absPath = path.isAbsolute(relPath) ? relPath : path.join(workspaceRoot, relPath);
      edits.push({ filePath: absPath, content });
    }
    if (!edits.length || cancelled) { return; }

    const wsEdit = new vscode.WorkspaceEdit();
    const summaryLines = ['**Changes applied:**', ''];
    for (const edit of edits) {
      const uri = vscode.Uri.file(edit.filePath);
      let existingContent = '';
      try { const bytes = await vscode.workspace.fs.readFile(uri); existingContent = Buffer.from(bytes).toString('utf8'); } catch { /* new file */ }
      const oldLines = existingContent.split('\n').length;
      const newLines = edit.content.split('\n').length;
      wsEdit.createFile(uri, { overwrite: true, ignoreIfExists: false });
      wsEdit.insert(uri, new vscode.Position(0, 0), edit.content);
      summaryLines.push(`- \`${path.relative(workspaceRoot, edit.filePath)}\`  +${Math.max(0, newLines - oldLines)}  -${Math.max(0, oldLines - newLines)}`);
    }
    const applied = await vscode.workspace.applyEdit(wsEdit);
    response.markdown('\n\n' + (applied ? summaryLines.join('\n') : '**Some edits could not be applied — check the Problems panel.**'));
  }

  private getEffortLevel(): ThinkingBudget | undefined {
    return this.state.thinkingBudget;
  }

  private async doIndex(root: string, response: ChatStream, token: vscode.CancellationToken): Promise<void> {
    await new ProjectIndexer(this.processManager).index(root, this.state.model, response, token);
  }

  private doHelp(response: ChatStream): void {
    response.markdown([
      '**Available commands:**', '',
      '| Command | Description |', '|---------|-------------|',
      '| `/fix`     | Fix issues in the current file |',
      '| `/explain` | Explain the current file |',
      '| `/index`   | Index project files |',
      '| `/help`    | Show this message |',
    ].join('\n'));
  }

  private async doFileAction(action: string, root: string, response: ChatStream, token: vscode.CancellationToken): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { response.markdown('**No active file.** Open a file first.'); return; }
    const doc  = editor.document;
    const verb = action === 'fix' ? 'Fix this file' : 'Explain this file';
    await this.runClaude(`<instruction>${verb}</instruction>\n<file path="${doc.fileName}" lang="${doc.languageId}">\n${doc.getText()}\n</file>`, root, response, token);
  }

  async switchModel(): Promise<void> {
    const config = vscode.workspace.getConfiguration('claude');
    const models: string[] = config.get('models', ['claude-sonnet-4-5']);
    const picked = await vscode.window.showQuickPick(
      models.map(m => ({ label: m, description: m === this.state.model ? '✓ current' : '' })),
      { placeHolder: 'Select model' },
    );
    if (!picked) { return; }
    this.setModelDirect(picked.label);
  }

  async switchBudget(): Promise<void> {
    const config = vscode.workspace.getConfiguration('claude');
    const thinkingModels: string[] = config.get('thinkingModels', []);
    if (!thinkingModels.includes(this.state.model)) {
      vscode.window.showInformationMessage(`Extended thinking not available for ${this.state.model}.`);
      return;
    }
    const options: Array<{ label: string; value: ThinkingBudget | undefined }> = [
      { label: 'Off', value: undefined },
      { label: 'Low (1k tokens)', value: 'low' },
      { label: 'Medium (4k tokens)', value: 'medium' },
      { label: 'High (10k tokens)', value: 'high' },
      { label: 'Max (32k tokens)', value: 'max' },
    ];
    const picked = await vscode.window.showQuickPick(
      options.map(o => ({ ...o, description: o.value === this.state.thinkingBudget ? '✓ current' : '' })),
      { placeHolder: 'Select thinking budget' },
    );
    if (!picked) { return; }
    this.state.thinkingBudget = picked.value;
    this.context.workspaceState.update('thinkingBudget', this.state.thinkingBudget);
    this.statusBar.setBudget(this.state.thinkingBudget);
  }

  addDroppedItems(items: DroppedItem[]): void  { this.state.droppedItems.push(...items); }
  clearDroppedItems(): void                     { this.state.droppedItems = []; }

  addSymbolRef(ref: SymbolRef): void    { this.state.symbolRefs.push(ref); }
  removeSymbolRef(name: string): void   { this.state.symbolRefs = this.state.symbolRefs.filter(r => r.name !== name); }
  clearSymbolRefs(): void               { this.state.symbolRefs = []; }
}
