import * as vscode from 'vscode';
import { ProcessManager } from './processManager';
import { StatusBarManager } from './statusBar';
import { ClaudeStreamEvent } from './types';

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private pendingAbort: AbortController | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private processManager: ProcessManager,
    private statusBar: StatusBarManager,
    private getModel: () => string,
    private getYolo: () => boolean,
    private getWorkspaceRoot: () => string | undefined,
  ) {}

  provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | null> {
    return new Promise((resolve) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      if (this.pendingAbort) {
        this.pendingAbort.abort();
        this.pendingAbort = undefined;
      }

      const config = vscode.workspace.getConfiguration('claude');
      const debounceMs: number = config.get('completionDebounceMs', 500);

      this.debounceTimer = setTimeout(() => {
        if (token.isCancellationRequested) {
          resolve(null);
          return;
        }
        this.fetchCompletion(document, position, token).then(resolve);
      }, debounceMs);

      token.onCancellationRequested(() => {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = undefined;
        }
        resolve(null);
      });
    });
  }

  private async fetchCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | null> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) { return null; }

    const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const suffix = document.getText(new vscode.Range(position, document.positionAt(document.getText().length)));
    const filePath = document.fileName;
    const lang = document.languageId;

    const prompt = [
      `<task>Complete the code at the cursor. Output ONLY the completion text, nothing else. No explanation.</task>`,
      `<file path="${filePath}" lang="${lang}">`,
      `<prefix>${prefix}</prefix>`,
      `<suffix>${suffix}</suffix>`,
      `</file>`,
    ].join('\n');

    const abort = new AbortController();
    this.pendingAbort = abort;

    token.onCancellationRequested(() => abort.abort());

    return new Promise<vscode.InlineCompletionList | null>((resolve) => {
      if (abort.signal.aborted) { resolve(null); return; }

      this.statusBar.setStatus('thinking');
      const collectedEvents: ClaudeStreamEvent[] = [];

      this.processManager.invoke(prompt, {
        model: this.getModel(),
        yoloMode: this.getYolo(),
        workspaceRoot,
        signal: abort.signal,
        onEvent: (ev) => collectedEvents.push(ev),
        onError: () => {
          this.statusBar.setStatus('idle');
          resolve(null);
        },
        onDone: () => {
          this.statusBar.setStatus('idle');
          if (abort.signal.aborted) { resolve(null); return; }

          const text = extractText(collectedEvents);
          if (!text.trim()) { resolve(null); return; }

          resolve(new vscode.InlineCompletionList([
            new vscode.InlineCompletionItem(text, new vscode.Range(position, position)),
          ]));
        },
      });
    });
  }

  dispose(): void {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    if (this.pendingAbort) { this.pendingAbort.abort(); }
    this.disposables.forEach(d => d.dispose());
  }
}

function extractText(events: ClaudeStreamEvent[]): string {
  const parts: string[] = [];
  for (const ev of events) {
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === 'text' && block.text) { parts.push(block.text); }
      }
    }
    if (ev.type === 'result' && ev.result) { parts.push(ev.result); }
  }
  return parts.join('');
}
