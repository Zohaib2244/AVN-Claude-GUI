import * as vscode from 'vscode';
import * as path from 'path';
import { ProcessManager, isAuthError } from './processManager';
import { StatusBarManager } from './statusBar';
import { UsageTracker } from './usageTracker';
import { assembleContext, getActiveEditorContext, DroppedItem } from './contextAssembler';
import { ConversationStore } from './conversationStore';
import { ProjectIndexer } from './projectIndexer';
import { ChatStream, ClaudeStreamEvent, ThinkingBudget } from './types';

export interface SessionState {
  sessionId: string | undefined;
  model: string;
  yoloMode: boolean;
  thinkingBudget: ThinkingBudget | undefined;
  droppedItems: DroppedItem[];
  mode: 'agent' | 'plan';
}

export class ChatHandler {
  private state: SessionState;
  private sessionRestored = false;

  constructor(
    private processManager: ProcessManager,
    private statusBar: StatusBarManager,
    private usageTracker: UsageTracker,
    private context: vscode.ExtensionContext,
    private getWorkspaceRoot: () => string | undefined,
    private conversationStore: ConversationStore,
  ) {
    const ws = context.workspaceState;
    const config = vscode.workspace.getConfiguration('claude');
    this.state = {
      sessionId: undefined,
      model: ws.get('selectedModel', config.get('defaultModel', 'claude-sonnet-4-5')),
      yoloMode: ws.get('yoloMode', false),
      thinkingBudget: ws.get('thinkingBudget', undefined),
      droppedItems: [],
      mode: ws.get('mode', 'agent') as 'agent' | 'plan',
    };
    this.statusBar.setYolo(this.state.yoloMode);
    this.statusBar.setModel(this.state.model);
    this.statusBar.setBudget(this.state.thinkingBudget);
  }

  getModel(): string { return this.state.model; }
  getYolo(): boolean { return this.state.yoloMode; }
  getMode(): 'agent' | 'plan' { return this.state.mode; }
  getSessionId(): string | undefined { return this.state.sessionId; }

  setMode(mode: 'agent' | 'plan'): void {
    this.state.mode = mode;
    this.context.workspaceState.update('mode', mode);
  }

  /** Directly set the model (used by in-webview model picker). */
  setModelDirect(model: string): void {
    this.state.model = model;
    this.context.workspaceState.update('selectedModel', model);
    this.statusBar.setModel(model);
  }

  /** Remove a specific dropped item by its URI string. */
  removeDroppedItemByUri(uriStr: string): void {
    const idx = this.state.droppedItems.findIndex(i => i.uri.toString() === uriStr);
    if (idx >= 0) { this.state.droppedItems.splice(idx, 1); }
  }

  /** Primary entry point used by the sidebar webview. */
  async chat(
    userText: string,
    command: string | undefined,
    response: ChatStream,
    token: vscode.CancellationToken,
    workspaceRoot: string,
  ): Promise<void> {
    // Restore persisted session on first use
    if (!this.sessionRestored) {
      this.sessionRestored = true;
      const saved = this.conversationStore.load(workspaceRoot);
      if (saved) {
        this.state.sessionId = saved.sessionId;
        this.state.model = saved.model;
        this.statusBar.setModel(this.state.model);
      }
    }

    if (command === 'index') { await this.doIndex(workspaceRoot, response, token); return; }
    if (command === 'help')  { this.doHelp(response); return; }
    if (command === 'fix')   { await this.doFileAction('fix', workspaceRoot, response, token); return; }
    if (command === 'explain') { await this.doFileAction('explain', workspaceRoot, response, token); return; }

    // Regular chat turn — only include explicit drops and active selection, NOT the whole open file
    const { selection } = getActiveEditorContext();
    const { prompt } = await assembleContext(
      userText,
      workspaceRoot,
      this.state.droppedItems,
      selection,
      undefined,
    );
    this.state.droppedItems = [];

    const finalPrompt = this.state.mode === 'plan'
      ? '<instruction>\nPlan mode: Analyze the request and outline a detailed implementation plan. Think through the approach carefully. Do NOT write or modify any files — only describe the plan.\n</instruction>\n\n' + prompt
      : prompt;

    await this.runClaude(finalPrompt, workspaceRoot, response, token);
  }

  /** Clear the current session without streaming anything — called directly by the provider. */
  clearSession(workspaceRoot: string): void {
    this.state.sessionId = undefined;
    this.conversationStore.clear(workspaceRoot);
  }

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
    let inputTokens = 0;
    let outputTokens = 0;
    let lastError: string | undefined;

    await new Promise<void>((resolve) => {
      this.processManager.invoke(prompt, {
        model: this.state.model,
        yoloMode: this.state.yoloMode,
        effortLevel: this.getEffortLevel(),
        sessionId: this.state.sessionId,
        workspaceRoot,
        signal: abort.signal,
        onEvent: (ev: ClaudeStreamEvent) => {
          if (ev.session_id) { this.state.sessionId = ev.session_id; }

          if (ev.type === 'assistant' && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === 'text' && block.text) {
                collectedText.push(block.text);
                response.markdown(block.text);
              }
            }
            if (ev.message.usage) {
              inputTokens  += ev.message.usage.input_tokens ?? 0;
              outputTokens += ev.message.usage.output_tokens ?? 0;
            }
          }

          if (ev.type === 'result') {
            if (ev.usage) {
              inputTokens  = ev.usage.input_tokens ?? inputTokens;
              outputTokens = ev.usage.output_tokens ?? outputTokens;
            }
            if (ev.subtype === 'error' && ev.error) {
              lastError = ev.error;
            }
          }
        },
        onError: (err) => {
          if (err.message === 'ENOENT') {
            response.markdown(
              '**Claude CLI not found.** Install it from [claude.ai/code](https://claude.ai/code) and ensure it is on your PATH.'
            );
          } else {
            response.markdown(`**CLI error:** ${err.message}`);
          }
          this.statusBar.setStatus('error');
          resolve();
        },
        onDone: (sessionId) => {
          if (sessionId) { this.state.sessionId = sessionId; }
          resolve();
        },
      });
    });

    this.statusBar.setStatus('idle');

    if (lastError) {
      if (isAuthError(lastError)) {
        vscode.window.showErrorMessage(
          'Claude CLI is not authenticated. Run `claude login` in your terminal.'
        );
      } else {
        response.markdown(`\n\n**Error:** ${lastError}`);
      }
    }

    if (inputTokens || outputTokens) {
      this.usageTracker.record(inputTokens, outputTokens);
      this.statusBar.refreshTokens();
    }

    if (this.state.sessionId) {
      this.conversationStore.save(workspaceRoot, this.state.sessionId, this.state.model);
    }

    const fullText = collectedText.join('');
    await this.applyFileEdits(fullText, workspaceRoot, response, abort.signal.aborted);
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
    const summaryLines: string[] = ['**Changes applied:**', ''];

    for (const edit of edits) {
      const uri = vscode.Uri.file(edit.filePath);
      let existingContent = '';
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        existingContent = Buffer.from(bytes).toString('utf8');
      } catch { /* new file */ }

      const oldLines = existingContent.split('\n').length;
      const newLines = edit.content.split('\n').length;
      const added   = Math.max(0, newLines - oldLines);
      const removed = Math.max(0, oldLines - newLines);

      wsEdit.createFile(uri, { overwrite: true, ignoreIfExists: false });
      wsEdit.insert(uri, new vscode.Position(0, 0), edit.content);

      const relDisplayPath = path.relative(workspaceRoot, edit.filePath);
      summaryLines.push(`- \`${relDisplayPath}\`  +${added}  -${removed}`);
    }

    const applied = await vscode.workspace.applyEdit(wsEdit);
    if (applied) {
      response.markdown('\n\n' + summaryLines.join('\n'));
    } else {
      response.markdown('\n\n**Some edits could not be applied — check the Problems panel.**');
    }
  }

  private getEffortLevel(): ThinkingBudget | undefined {
    if (!this.state.thinkingBudget) { return undefined; }
    const config = vscode.workspace.getConfiguration('claude');
    const thinkingModels: string[] = config.get('thinkingModels', []);
    if (!thinkingModels.includes(this.state.model)) { return undefined; }
    return this.state.thinkingBudget;
  }

  private async doIndex(
    workspaceRoot: string,
    response: ChatStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const indexer = new ProjectIndexer(this.processManager);
    await indexer.index(workspaceRoot, this.state.model, response, token);
  }

  private doHelp(response: ChatStream): void {
    response.markdown([
      '**Available commands:**',
      '',
      '| Command | Description |',
      '|---------|-------------|',
      '| `/fix`     | Fix the current file |',
      '| `/explain` | Explain the current file |',
      '| `/index`   | Index project files |',
      '| `/help`    | Show this message |',
    ].join('\n'));
  }

  private async doFileAction(
    action: string,
    workspaceRoot: string,
    response: ChatStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      response.markdown('**No active file.** Open a file first.');
      return;
    }
    const doc = editor.document;
    const verb = action === 'fix' ? 'Fix this file' : 'Explain this file';
    const prompt = `<instruction>${verb}</instruction>\n<file path="${doc.fileName}" lang="${doc.languageId}">\n${doc.getText()}\n</file>`;
    await this.runClaude(prompt, workspaceRoot, response, token);
  }

  async switchModel(): Promise<void> {
    const config = vscode.workspace.getConfiguration('claude');
    const models: string[] = config.get('models', ['claude-sonnet-4-5']);
    const picked = await vscode.window.showQuickPick(
      models.map(m => ({ label: m, description: m === this.state.model ? '✓ current' : '' })),
      { placeHolder: 'Select model' },
    );
    if (!picked) { return; }
    this.state.model = picked.label;
    this.context.workspaceState.update('selectedModel', this.state.model);
    this.statusBar.setModel(this.state.model);
  }

  async switchBudget(): Promise<void> {
    const config = vscode.workspace.getConfiguration('claude');
    const thinkingModels: string[] = config.get('thinkingModels', []);
    if (!thinkingModels.includes(this.state.model)) {
      vscode.window.showInformationMessage(
        `Extended thinking not available for ${this.state.model}.`
      );
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
      options.map(o => ({
        ...o,
        description: o.value === this.state.thinkingBudget ? '✓ current' : '',
      })),
      { placeHolder: 'Select thinking budget' },
    );
    if (!picked) { return; }
    this.state.thinkingBudget = picked.value;
    this.context.workspaceState.update('thinkingBudget', this.state.thinkingBudget);
    this.statusBar.setBudget(this.state.thinkingBudget);
  }

  toggleYolo(): void {
    this.state.yoloMode = !this.state.yoloMode;
    this.context.workspaceState.update('yoloMode', this.state.yoloMode);
    this.statusBar.setYolo(this.state.yoloMode);
  }

  addDroppedItems(items: DroppedItem[]): void {
    this.state.droppedItems.push(...items);
  }

  clearDroppedItems(): void {
    this.state.droppedItems = [];
  }
}
