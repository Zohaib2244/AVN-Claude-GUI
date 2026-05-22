import * as vscode from 'vscode';
import { ProcessManager, isAuthError } from './processManager';
import { OpenCodeManager } from './openCodeManager';
import { BackendController } from './backendController';
import { StatusBarManager } from './statusBar';
import { showChangedFileDiffs } from './diffViewer';
import { ClaudeStreamEvent } from './types';

const CLAUDE_SETUP = [
  '**Claude Code CLI not found.**',
  '',
  '1. Install: `npm install -g @anthropic-ai/claude-code`',
  '2. Authenticate: run `claude login` in your terminal',
  '3. Verify: `claude --version`',
  '4. Reload VS Code after installation',
].join('\n');

const OPENCODE_SETUP = [
  '**OpenCode CLI not found.**',
  '',
  '1. Install: `npm install -g opencode-ai`',
  '2. Verify: `opencode --version` in your terminal',
  '3. Set a provider API key in your shell env (e.g. `ANTHROPIC_API_KEY`)',
  '4. Reload VS Code after installation',
].join('\n');

export class AvnChatParticipant {
  // Per-session backend session IDs (Claude --resume / OpenCode --session)
  private claudeSidByChat   = new Map<string, string>();
  private openCodeSidByChat = new Map<string, string>();

  constructor(
    private processManager:  ProcessManager,
    private openCodeManager: OpenCodeManager,
    private controller:      BackendController,
    private statusBar:       StatusBarManager,
  ) {}

  /** Resolve a ChatRequest reference (Uri | Location | string) into prompt context. */
  private async _resolveReferences(refs: readonly vscode.ChatPromptReference[]): Promise<string> {
    if (!refs.length) { return ''; }
    const parts: string[] = [];
    for (const ref of refs) {
      try {
        if (ref.value instanceof vscode.Uri) {
          const bytes = await vscode.workspace.fs.readFile(ref.value);
          const text  = Buffer.from(bytes).toString('utf8');
          parts.push(`<file path="${vscode.workspace.asRelativePath(ref.value)}">\n${text}\n</file>`);
        } else if (ref.value instanceof vscode.Location) {
          const doc = await vscode.workspace.openTextDocument(ref.value.uri);
          const sel = doc.getText(ref.value.range);
          parts.push(`<selection file="${vscode.workspace.asRelativePath(ref.value.uri)}">\n${sel}\n</selection>`);
        } else if (typeof ref.value === 'string') {
          parts.push(`<context id="${ref.id}">\n${ref.value}\n</context>`);
        }
      } catch (err) {
        parts.push(`<!-- failed to read reference ${ref.id}: ${err} -->`);
      }
    }
    return parts.join('\n\n');
  }

  /** Main entry point — registered as the chat participant's request handler. */
  async handle(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      response.markdown('**No workspace folder open.** Open a folder and try again.');
      return;
    }

    // ── Slash command dispatch ────────────────────────────────────────────
    if (request.command) {
      const handled = await this._handleSlashCommand(request, root, response, token);
      if (handled) { return; }
    }

    // Build the prompt: references first, then the user's message
    const refContext   = await this._resolveReferences(request.references);
    const userPrompt   = request.prompt.trim();
    const modePrefix   = this.controller.getMode() === 'plan'
      ? '<instruction>\nPlan mode: Analyze and outline an implementation plan carefully. Do NOT write or modify any files.\n</instruction>\n\n'
      : '';
    const fullPrompt = [modePrefix, refContext, userPrompt].filter(Boolean).join('\n\n');

    // Pick the chat session ID — `chatContext.history` lets us derive a stable key
    const chatKey = this._chatKey(chatContext);

    this.statusBar.setStatus('thinking');
    try {
      if (this.controller.getBackend() === 'opencode') {
        await this._runOpenCode(fullPrompt, root, response, token, chatKey);
      } else {
        await this._runClaude(fullPrompt, root, response, token, chatKey);
      }
      // After the AI finishes, surface every file it changed via VS Code's diff editor.
      if (!token.isCancellationRequested) {
        await showChangedFileDiffs(root);
      }
    } finally {
      this.statusBar.setStatus('idle');
    }
  }

  /**
   * Returns true if the command was fully handled (no backend invocation needed).
   * /fix and /explain return false because they augment the prompt and continue.
   */
  private async _handleSlashCommand(
    request:  vscode.ChatRequest,
    root:     string,
    response: vscode.ChatResponseStream,
    _token:   vscode.CancellationToken,
  ): Promise<boolean> {
    switch (request.command) {
      case 'help':
        response.markdown([
          '**AVN slash commands:**',
          '',
          '| Command | Action |',
          '|---|---|',
          '| `/fix`     | Fix issues in the active editor file |',
          '| `/explain` | Explain the active editor file |',
          '| `/index`   | Build `.claude/project-context.md` |',
          '| `/model`   | Switch model |',
          '| `/mode`    | Switch mode: Ask / Auto / Plan |',
          '| `/think`   | Toggle extended thinking budget (Claude only) |',
          '| `/help`    | Show this list |',
        ].join('\n'));
        return true;

      case 'model':    await vscode.commands.executeCommand('avn.switchModel');    return true;
      case 'mode':     await vscode.commands.executeCommand('avn.switchMode');     return true;
      case 'think':    await vscode.commands.executeCommand('avn.switchThinking'); return true;
      case 'index':    await vscode.commands.executeCommand('avn.indexProject');
                       response.markdown('Indexing started — see the notification for progress.');
                       return true;

      case 'fix':
      case 'explain': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { response.markdown('**No active file.** Open a file first.'); return true; }
        const doc = editor.document;
        const verb = request.command === 'fix' ? 'Fix this file' : 'Explain this file';
        // Inject the file content into the request — fall through to backend by mutating prompt.
        // We achieve this by directly invoking the backend here with the augmented prompt.
        const fullPrompt = `<instruction>${verb}</instruction>\n<file path="${doc.fileName}" lang="${doc.languageId}">\n${doc.getText()}\n</file>`;
        if (this.controller.getBackend() === 'opencode') {
          await this._runOpenCode(fullPrompt, root, response, _token, this._chatKey({ history: [] } as vscode.ChatContext));
        } else {
          await this._runClaude(fullPrompt, root, response, _token, this._chatKey({ history: [] } as vscode.ChatContext));
        }
        return true;
      }
    }
    return false;
  }

  private _chatKey(chatContext: vscode.ChatContext): string {
    // The history list is per-chat-session; first entry's metadata can key it.
    // If empty, generate a stable key from the participant id alone.
    if (chatContext.history.length === 0) { return 'fresh'; }
    const first = chatContext.history[0];
    return first instanceof vscode.ChatRequestTurn
      ? `${first.participant ?? 'avn'}-${chatContext.history.length}`
      : 'unknown';
  }

  private async _runClaude(
    prompt:   string,
    root:     string,
    response: vscode.ChatResponseStream,
    token:    vscode.CancellationToken,
    chatKey:  string,
  ): Promise<void> {
    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());

    const collectedText: string[] = [];
    let lastError: string | undefined;

    await new Promise<void>((resolve) => {
      this.processManager.invoke(prompt, {
        model:       this.controller.getModel(),
        yoloMode:    this.controller.getMode() === 'auto',
        effortLevel: this.controller.getThinking(),
        sessionId:   this.claudeSidByChat.get(chatKey),
        workspaceRoot: root,
        signal:      abort.signal,
        onEvent: (ev: ClaudeStreamEvent) => {
          if (ev.session_id) { this.claudeSidByChat.set(chatKey, ev.session_id); }
          if (ev.type === 'assistant' && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === 'text' && block.text) {
                collectedText.push(block.text);
                response.markdown(block.text);
              }
              if (block.type === 'tool_use' && block.name) {
                response.progress(this._toolLabel(block.name, block.input ?? {}));
              }
            }
          }
          if (ev.type === 'result' && ev.subtype === 'error' && ev.error) {
            lastError = ev.error;
          }
        },
        onError: (err) => {
          response.markdown(err.message === 'ENOENT' ? CLAUDE_SETUP : `**Claude CLI error:** ${err.message}`);
          resolve();
        },
        onDone: (sid) => { if (sid) { this.claudeSidByChat.set(chatKey, sid); } resolve(); },
      });
    });

    if (lastError) {
      if (isAuthError(lastError)) {
        response.markdown('\n\n**Claude is not authenticated.** Run `claude login` in your terminal and try again.');
      } else {
        response.markdown(`\n\n**Error:** ${lastError}`);
      }
    }
  }

  private async _runOpenCode(
    prompt:   string,
    root:     string,
    response: vscode.ChatResponseStream,
    token:    vscode.CancellationToken,
    chatKey:  string,
  ): Promise<void> {
    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());

    await new Promise<void>((resolve) => {
      this.openCodeManager.invoke(prompt, {
        model:        this.controller.getModel(),
        sessionId:    this.openCodeSidByChat.get(chatKey),
        workspaceRoot: root,
        signal:       abort.signal,
        onText:  (text)        => response.markdown(text),
        onTool:  (name, input) => response.progress(this._toolLabel(name, input)),
        onDone:  (sid)         => { if (sid) { this.openCodeSidByChat.set(chatKey, sid); } resolve(); },
        onError: (err)         => {
          response.markdown(err.message === 'ENOENT' ? OPENCODE_SETUP : `**OpenCode error:** ${err.message}`);
          resolve();
        },
      });
    });
  }

  private _toolLabel(name: string, input: Record<string, unknown>): string {
    const fp = String(input.file_path ?? input.path ?? input.pattern ?? '');
    switch (name) {
      case 'Read':      return fp ? `Reading ${fp}` : 'Reading';
      case 'Write':     return fp ? `Writing ${fp}` : 'Writing';
      case 'Edit':      return fp ? `Editing ${fp}` : 'Editing';
      case 'MultiEdit': return fp ? `Editing ${fp}` : 'Editing';
      case 'Bash':      return `Running command: ${String(input.command ?? '').slice(0, 80)}`;
      case 'Glob':      return `Searching for ${String(input.pattern ?? '')}`;
      case 'Grep':      return `Searching: ${String(input.pattern ?? input.query ?? '')}`;
      case 'WebFetch':  return `Fetching ${String(input.url ?? '')}`;
      case 'WebSearch': return `Web search: ${String(input.query ?? '')}`;
      case 'TodoWrite': return 'Updating task list';
      default:          return `Using ${name}`;
    }
  }
}

