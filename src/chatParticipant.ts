import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProcessManager, isAuthError } from './processManager';
import { OpenCodeManager } from './openCodeManager';
import { BackendController } from './backendController';
import { StatusBarManager } from './statusBar';
import { SnapshotContentProvider } from './diffViewer';
import { ChangeTracker, FileChange, TurnSnapshot } from './changeTracker';
import { DiffDecorator } from './diffDecorator';
import { DiffCodeLensProvider } from './diffCodeLens';
import { DiffCardsProvider } from './diffCardsProvider';
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

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.tiff']);

export class AvnChatParticipant {
  // Per-session backend session IDs (Claude --resume / OpenCode --session)
  private claudeSidByChat   = new Map<string, string>();
  private openCodeSidByChat = new Map<string, string>();
  private log = vscode.window.createOutputChannel('AVN Chat (Debug)');

  constructor(
    private processManager:   ProcessManager,
    private openCodeManager:  OpenCodeManager,
    private controller:       BackendController,
    private statusBar:        StatusBarManager,
    private changeTracker:    ChangeTracker,
    private decorator:        DiffDecorator,
    private codeLensProvider: DiffCodeLensProvider,
    private snapshotProvider: SnapshotContentProvider,
    private diffCards:        DiffCardsProvider,
  ) {}

  /** Resolve ChatRequest references into prompt context, saving images to disk. */
  private async _resolveReferences(
    refs: readonly vscode.ChatPromptReference[],
    root: string,
  ): Promise<string> {
    if (!refs.length) { return ''; }

    this.log.appendLine(`\n[refs] ${refs.length} reference(s)`);
    const parts: string[] = [];

    for (const ref of refs) {
      const valueType = ref.value === null || ref.value === undefined
        ? typeof ref.value
        : (ref.value as object).constructor?.name ?? typeof ref.value;
      this.log.appendLine(`  - id=${ref.id} type=${valueType} desc=${ref.modelDescription ?? '-'}`);

      try {
        if (ref.value instanceof vscode.Uri) {
          const uri = ref.value as vscode.Uri;
          const ext = path.extname(uri.fsPath).toLowerCase();
          if (IMAGE_EXTS.has(ext)) {
            // Image: copy to .avn/images/<name> in the workspace and reference its path.
            // Claude can then open it via the Read tool.
            const saved = await this._saveImage(uri, root);
            parts.push(`<image path="${saved}" />`);
            this.log.appendLine(`    → image saved to ${saved}`);
            continue;
          }
          // Text file: read as UTF-8 (skip if file is binary-looking)
          const bytes = await vscode.workspace.fs.readFile(uri);
          if (looksBinary(bytes)) {
            parts.push(`<!-- skipped binary file: ${vscode.workspace.asRelativePath(uri)} -->`);
            this.log.appendLine(`    → skipped (binary)`);
            continue;
          }
          const text = Buffer.from(bytes).toString('utf8');
          parts.push(`<file path="${vscode.workspace.asRelativePath(uri)}">\n${text}\n</file>`);
          this.log.appendLine(`    → text file, ${text.length} chars`);
        } else if (ref.value instanceof vscode.Location) {
          const loc = ref.value as vscode.Location;
          const doc = await vscode.workspace.openTextDocument(loc.uri);
          const sel = doc.getText(loc.range);
          parts.push(`<selection file="${vscode.workspace.asRelativePath(loc.uri)}" startLine="${loc.range.start.line + 1}">\n${sel}\n</selection>`);
          this.log.appendLine(`    → selection, ${sel.length} chars`);
        } else if (typeof ref.value === 'string') {
          parts.push(`<context id="${ref.id}">\n${ref.value}\n</context>`);
          this.log.appendLine(`    → string value, ${ref.value.length} chars`);
        } else {
          this.log.appendLine(`    → unknown value shape: ${JSON.stringify(ref.value).slice(0, 200)}`);
          parts.push(`<!-- unhandled reference ${ref.id} -->`);
        }
      } catch (err) {
        this.log.appendLine(`    → error: ${err}`);
        parts.push(`<!-- failed to read reference ${ref.id}: ${err} -->`);
      }
    }
    return parts.join('\n\n');
  }

  /** Save a pasted/attached image to .avn/images/<name>.<ext> inside the workspace. */
  private async _saveImage(srcUri: vscode.Uri, root: string): Promise<string> {
    const dir = path.join(root, '.avn', 'images');
    fs.mkdirSync(dir, { recursive: true });
    const ext  = path.extname(srcUri.fsPath) || '.png';
    const stem = path.basename(srcUri.fsPath, ext) || `paste-${Date.now()}`;
    const dest = path.join(dir, `${stem}${ext}`);
    const data = await vscode.workspace.fs.readFile(srcUri);
    fs.writeFileSync(dest, Buffer.from(data));
    return path.relative(root, dest);
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

    this.log.appendLine('\n' + '═'.repeat(60));
    this.log.appendLine(`[turn] backend=${this.controller.getBackend()} model=${this.controller.getModel()} mode=${this.controller.getMode()}`);
    this.log.appendLine(`[turn] prompt: ${request.prompt.slice(0, 120)}${request.prompt.length > 120 ? '…' : ''}`);

    // ── Slash command dispatch ────────────────────────────────────────────
    if (request.command) {
      const handled = await this._handleSlashCommand(request, root, response, token);
      if (handled) { return; }
    }

    const refContext   = await this._resolveReferences(request.references, root);
    const userPrompt   = request.prompt.trim();
    const modePrefix   = this.controller.getMode() === 'plan'
      ? '<instruction>\nPlan mode: Analyze and outline an implementation plan carefully. Do NOT write or modify any files.\n</instruction>\n\n'
      : '';
    const fullPrompt = [modePrefix, refContext, userPrompt].filter(Boolean).join('\n\n');
    this.log.appendLine(`[turn] full prompt length: ${fullPrompt.length} chars`);

    const chatKey = this._chatKey(chatContext);

    // Snapshot pre-turn state so we can attribute exactly what the AI changed —
    // see ChangeTracker for why this replaces a plain `git diff <HEAD>`.
    const snapshot = await this.changeTracker.beginTurn(root);
    this.log.appendLine(`[turn] baseHash=${snapshot.baseHash?.slice(0, 8) ?? 'no-git'} dirty-snapshot=${snapshot.dirtySnapshots.size}`);

    this.statusBar.setStatus('thinking');
    try {
      if (this.controller.getBackend() === 'opencode') {
        await this._runOpenCode(fullPrompt, root, response, token, chatKey);
      } else {
        await this._runClaude(fullPrompt, root, response, token, chatKey);
      }
      if (!token.isCancellationRequested) {
        await this._reviewChanges(root, snapshot, response);
      }
    } finally {
      this.statusBar.setStatus('idle');
    }
  }

  /**
   * After an AI turn: compute exactly what changed vs the pre-turn snapshot, apply
   * in-editor decorations/CodeLens for review, and list each file in the chat reply
   * with a colored diff block plus Show diff / Keep / Revert buttons.
   */
  private async _reviewChanges(
    root:     string,
    snapshot: TurnSnapshot,
    response: vscode.ChatResponseStream,
  ): Promise<void> {
    const changes = await this.changeTracker.computeChanges(root, snapshot);
    this._applyDecorations(changes);
    this.diffCards.show(changes);
    await this._renderChangedFiles(changes, response);
  }

  /** Sync editor decorations/CodeLens with the current diff state — clears stale entries too. */
  private _applyDecorations(changes: FileChange[]): void {
    const stillChanged = new Set(changes.map(c => c.absPath));
    for (const tracked of this.decorator.changedFiles()) {
      if (!stillChanged.has(tracked)) { this.decorator.clearFile(tracked); }
    }
    for (const change of changes) {
      this.decorator.setFileHunks(change.absPath, change.hunks);
    }
    this.codeLensProvider.refresh();
  }

  /** List every changed file in the chat reply: anchor + status badge + Show diff/Keep/Revert. */
  private async _renderChangedFiles(
    changes:  FileChange[],
    response: vscode.ChatResponseStream,
  ): Promise<void> {
    this.log.appendLine(`[diff] ${changes.length} file(s) with AI changes`);
    if (changes.length === 0) { return; }

    response.markdown(`\n\n---\n\n**${changes.length} file${changes.length > 1 ? 's' : ''} changed:**\n`);

    for (const change of changes) {
      const currentUri  = vscode.Uri.file(change.absPath);
      const originalUri = this.snapshotProvider.register(change.relPath, change.beforeContent);
      const title       = `${path.basename(change.relPath)}  (before ↔ after)`;
      const added       = change.hunks.reduce((n, h) => n + h.newLines.length, 0);
      const removed     = change.hunks.reduce((n, h) => n + h.oldLines.length, 0);
      const status      = change.isNew ? 'new file' : change.isDeleted ? 'deleted' : `+${added} −${removed}`;

      response.markdown('\n');
      response.anchor(currentUri, change.relPath);
      response.markdown(` _(${status})_\n`);
      response.markdown(actionLinks(originalUri, currentUri, title, change.absPath));

      this.log.appendLine(`  · ${change.relPath} (+${added} −${removed})`);
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
        const fullPrompt = `<instruction>${verb}</instruction>\n<file path="${doc.fileName}" lang="${doc.languageId}">\n${doc.getText()}\n</file>`;
        const snapshot = await this.changeTracker.beginTurn(root);
        const chatKey  = 'slash';
        if (this.controller.getBackend() === 'opencode') {
          await this._runOpenCode(fullPrompt, root, response, _token, chatKey);
        } else {
          await this._runClaude(fullPrompt, root, response, _token, chatKey);
        }
        if (!_token.isCancellationRequested) {
          await this._reviewChanges(root, snapshot, response);
        }
        return true;
      }
    }
    return false;
  }

  private _chatKey(chatContext: vscode.ChatContext): string {
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

// ─── Helpers ──────────────────────────────────────────────────────────────

function looksBinary(bytes: Uint8Array): boolean {
  // Cheap heuristic: any NUL byte in the first 4KB → binary
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) { if (bytes[i] === 0) { return true; } }
  return false;
}

/**
 * Render Show diff / Keep / Revert as one row of inline command links instead of
 * `response.button()`, which the chat view stacks vertically — links in a single
 * markdown paragraph lay out horizontally. Routed through `avn.showDiff` (rather than
 * calling `vscode.diff` directly) because command-link arguments round-trip through
 * JSON — plain strings survive that; `vscode.Uri` objects are not guaranteed to.
 */
function actionLinks(originalUri: vscode.Uri, currentUri: vscode.Uri, title: string, absPath: string): vscode.MarkdownString {
  const args = (...vals: string[]) => encodeURIComponent(JSON.stringify(vals));
  const sep  = '&nbsp;&nbsp;·&nbsp;&nbsp;';
  const md = new vscode.MarkdownString(
    `[$(diff) Show diff](command:avn.showDiff?${args(originalUri.toString(), currentUri.toString(), title)})` +
    `${sep}[$(check) Keep](command:avn.keepFileChanges?${args(absPath)})` +
    `${sep}[$(discard) Revert](command:avn.revertFileChanges?${args(absPath)})\n`,
    true,
  );
  md.isTrusted = { enabledCommands: ['avn.showDiff', 'avn.keepFileChanges', 'avn.revertFileChanges'] };
  return md;
}
