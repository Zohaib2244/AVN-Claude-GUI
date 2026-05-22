import * as path from 'path';
import * as vscode from 'vscode';
import { ProcessManager } from './processManager';
import { OpenCodeManager } from './openCodeManager';
import { StatusBarManager } from './statusBar';
import { UsageTracker } from './usageTracker';
import { ChatHandler } from './chatHandler';
import { InlineCompletionProvider } from './completionProvider';
import {
  ClaudeCodeActionProvider,
  buildCodeActionPrompt,
  getDiagnosticsText,
  getSurroundingCode,
} from './codeActionProvider';
import { SessionManager } from './sessionManager';
import { ProjectIndexer } from './projectIndexer';
import { ClaudeViewProvider } from './claudeViewProvider';
import { DiffCodeLensProvider } from './diffCodeLens';
import { DiffDecorator } from './diffDecorator';
import { ChatStream } from './types';

export function activate(context: vscode.ExtensionContext): void {
  const getWorkspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const processManager    = new ProcessManager();
  const openCodeManager   = new OpenCodeManager();
  const usageTracker      = new UsageTracker(context);
  const statusBar         = new StatusBarManager(usageTracker);
  const sessionManager    = new SessionManager(context);
  const chatHandler       = new ChatHandler(
    processManager,
    openCodeManager,
    statusBar,
    usageTracker,
    context,
    getWorkspaceRoot,
    sessionManager,
  );

  // ─── Diff visualization (decorations + per-hunk CodeLens) ──────────────────
  const diffDecorator = new DiffDecorator();
  const diffCodeLens  = new DiffCodeLensProvider(diffDecorator);
  context.subscriptions.push(
    diffDecorator,
    diffCodeLens,
    vscode.languages.registerCodeLensProvider({ pattern: '**' }, diffCodeLens),
    vscode.commands.registerCommand('avn.keepFileChanges', (filePath: string) => {
      viewProvider.keepFileChanges(filePath);
    }),
    vscode.commands.registerCommand('avn.revertFileChanges', (filePath: string) => {
      viewProvider.revertFileChanges(filePath);
    }),
    vscode.commands.registerCommand('avn.keepHunk', (filePath: string, idx: number) => {
      viewProvider.keepHunk(filePath, idx);
    }),
    vscode.commands.registerCommand('avn.revertHunk', (filePath: string, idx: number) => {
      viewProvider.revertHunk(filePath, idx);
    }),
    vscode.commands.registerCommand('avn.nextHunk', () => jumpToHunk(diffDecorator,  1)),
    vscode.commands.registerCommand('avn.prevHunk', () => jumpToHunk(diffDecorator, -1)),
  );

  // ─── Sidebar Webview ────────────────────────────────────────────────────────
  const viewProvider = new ClaudeViewProvider(
    context.extensionUri,
    chatHandler,
    usageTracker,
    getWorkspaceRoot,
    diffCodeLens,
    diffDecorator,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ClaudeViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ─── Inline Completions ─────────────────────────────────────────────────────
  const completionProvider = new InlineCompletionProvider(
    processManager,
    statusBar,
    () => chatHandler.getModel(),
    () => chatHandler.getYolo(),
    getWorkspaceRoot,
  );
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, completionProvider),
    completionProvider,
  );

  // ─── Code Actions ───────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { pattern: '**' },
      new ClaudeCodeActionProvider(),
      { providedCodeActionKinds: ClaudeCodeActionProvider.providedCodeActionKinds },
    )
  );

  const codeActionCommands: Array<[string, string]> = [
    ['claude.action.explain',  'explain'],
    ['claude.action.fix',      'fix'],
    ['claude.action.refactor', 'refactor'],
    ['claude.action.addTests', 'addTests'],
    ['claude.action.addDocs',  'addDocs'],
    ['claude.action.findBugs', 'findBugs'],
  ];

  for (const [cmd, actionType] of codeActionCommands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, () => runCodeAction(actionType, chatHandler, viewProvider))
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claude.action.custom', async () => {
      const instruction = await vscode.window.showInputBox({
        prompt: "Describe what you'd like Claude to do with this selection…",
        placeHolder: 'e.g., Convert this to async/await syntax',
      });
      if (instruction) { runCodeAction('custom', chatHandler, viewProvider, instruction); }
    })
  );

  // ─── Commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('claude.openChat', () =>
      vscode.commands.executeCommand(`${ClaudeViewProvider.viewType}.focus`)
    ),

    vscode.commands.registerCommand('claude.toggleYolo', () => {
      chatHandler.toggleYolo();
    }),

    vscode.commands.registerCommand('claude.switchModel', () => chatHandler.switchModel()),

    vscode.commands.registerCommand('claude.switchBudget', () => chatHandler.switchBudget()),

    vscode.commands.registerCommand('claude.showOutput', () => processManager.showOutput()),

    vscode.commands.registerCommand('claude.restartProcess', () => {
      vscode.window.showInformationMessage('Claude process restarted.');
    }),

    vscode.commands.registerCommand('claude.indexProject', async () => {
      const root = getWorkspaceRoot();
      if (!root) { vscode.window.showWarningMessage('No workspace folder open.'); return; }
      const indexer = new ProjectIndexer(processManager);
      const cts = new vscode.CancellationTokenSource();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Claude: Indexing project…', cancellable: true },
        async (_progress, cancelToken) => {
          cancelToken.onCancellationRequested(() => cts.cancel());
          const notifStream: ChatStream = {
            markdown: (text) => vscode.window.showInformationMessage(text.slice(0, 200)),
          };
          await indexer.index(root, chatHandler.getModel(), notifStream, cts.token);
        },
      );
      cts.dispose();
    }),

    // Usage now shown inside the webview with a visual progress panel
    vscode.commands.registerCommand('claude.showUsage', () => viewProvider.showUsage()),
  );

  // ─── Disposables ────────────────────────────────────────────────────────────
  context.subscriptions.push(processManager, openCodeManager, statusBar);
}

export function deactivate(): void { /* nothing */ }

/** Move the cursor to the next/prev AI-edit hunk in the active editor. */
function jumpToHunk(decorator: DiffDecorator, direction: 1 | -1): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }
  const hunks = decorator.hunksFor(editor.document.uri.fsPath);
  if (!hunks.length) { vscode.window.showInformationMessage('No AI changes in this file.'); return; }
  const cursorLine = editor.selection.active.line + 1; // 1-based
  let target: number | undefined;
  if (direction > 0) {
    const next = hunks.find(h => h.newStart > cursorLine);
    target = (next ?? hunks[0]).newStart;
  } else {
    const prev = [...hunks].reverse().find(h => h.newStart < cursorLine);
    target = (prev ?? hunks[hunks.length - 1]).newStart;
  }
  const pos   = new vscode.Position(Math.max(0, (target ?? 1) - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function runCodeAction(
  actionType: string,
  chatHandler: ChatHandler,
  viewProvider: ClaudeViewProvider,
  customInstruction?: string,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Select some code first.');
    return;
  }

  const doc         = editor.document;
  const selection   = doc.getText(editor.selection);
  const surrounding = getSurroundingCode(doc, editor.selection);
  const diagnostics = getDiagnosticsText(doc, editor.selection);

  const fullPrompt  = buildCodeActionPrompt(
    actionType, selection, doc.fileName, doc.languageId,
    surrounding, diagnostics, customInstruction,
  );
  const displayText = `/${actionType}: ${path.basename(doc.fileName)}`;

  await viewProvider.sendExternalPrompt(fullPrompt, displayText);
}
