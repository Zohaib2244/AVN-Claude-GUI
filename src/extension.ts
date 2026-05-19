import * as path from 'path';
import * as vscode from 'vscode';
import { ProcessManager } from './processManager';
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
import { ConversationStore } from './conversationStore';
import { ProjectIndexer } from './projectIndexer';
import { ClaudeViewProvider } from './claudeViewProvider';
import { ChatStream } from './types';

export function activate(context: vscode.ExtensionContext): void {
  const getWorkspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const processManager    = new ProcessManager();
  const usageTracker      = new UsageTracker(context);
  const statusBar         = new StatusBarManager(usageTracker);
  const conversationStore = new ConversationStore(context);
  const chatHandler       = new ChatHandler(
    processManager,
    statusBar,
    usageTracker,
    context,
    getWorkspaceRoot,
    conversationStore,
  );

  // ─── Sidebar Webview ────────────────────────────────────────────────────────
  const viewProvider = new ClaudeViewProvider(
    context.extensionUri,
    chatHandler,
    usageTracker,
    getWorkspaceRoot,
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
  context.subscriptions.push(processManager, statusBar);
}

export function deactivate(): void { /* nothing */ }

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
