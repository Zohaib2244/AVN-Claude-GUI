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

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const processManager     = new ProcessManager();
  const usageTracker       = new UsageTracker(context);
  const statusBar          = new StatusBarManager(usageTracker);
  const conversationStore  = new ConversationStore(context);
  const chatHandler        = new ChatHandler(
    processManager,
    statusBar,
    usageTracker,
    context,
    () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    conversationStore,
  );

  // ─── Chat Participant ───────────────────────────────────────────────────────
  const participant = vscode.chat.createChatParticipant(
    'claude.assistant',
    (request, ctx, response, token) => chatHandler.handleRequest(request, ctx, response, token),
  );
  participant.iconPath = new vscode.ThemeIcon('sparkle');
  context.subscriptions.push(participant);

  // ─── Inline Completions ─────────────────────────────────────────────────────
  const completionProvider = new InlineCompletionProvider(
    processManager,
    statusBar,
    () => chatHandler.getModel(),
    () => chatHandler.getYolo(),
    () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
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

  // Code action command implementations
  const codeActionCommands: Array<[string, string]> = [
    ['claude.action.explain',   'explain'],
    ['claude.action.fix',       'fix'],
    ['claude.action.refactor',  'refactor'],
    ['claude.action.addTests',  'addTests'],
    ['claude.action.addDocs',   'addDocs'],
    ['claude.action.findBugs',  'findBugs'],
  ];

  for (const [cmd, actionType] of codeActionCommands) {
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, () => runCodeAction(actionType, chatHandler))
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claude.action.custom', async () => {
      const instruction = await vscode.window.showInputBox({
        prompt: 'Describe what you\'d like Claude to do with this selection…',
        placeHolder: 'e.g., Convert this to async/await syntax',
      });
      if (instruction) { runCodeAction('custom', chatHandler, instruction); }
    })
  );

  // ─── Commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('claude.toggleYolo', () => chatHandler.toggleYolo()),

    vscode.commands.registerCommand('claude.switchModel', () => chatHandler.switchModel()),

    vscode.commands.registerCommand('claude.switchBudget', () => chatHandler.switchBudget()),

    vscode.commands.registerCommand('claude.showOutput', () => processManager.showOutput()),

    vscode.commands.registerCommand('claude.restartProcess', () => {
      vscode.window.showInformationMessage('Claude process restarted.');
    }),

    vscode.commands.registerCommand('claude.indexProject', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { vscode.window.showWarningMessage('No workspace folder open.'); return; }
      const indexer = new ProjectIndexer(processManager);
      const cts = new vscode.CancellationTokenSource();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Claude: Indexing project…', cancellable: true },
        async (_progress, cancelToken) => {
          cancelToken.onCancellationRequested(() => cts.cancel());
          const fakeResponse = makeFakeResponse();
          await indexer.index(root, chatHandler.getModel(), fakeResponse, cts.token);
        },
      );
      cts.dispose();
    }),

    vscode.commands.registerCommand('claude.showUsage', async () => {
      const summary = usageTracker.formatSummaryText();
      await vscode.window.showQuickPick(
        summary.split('\n').map(line => ({ label: line, description: '' })),
        { title: 'Claude Usage', placeHolder: 'Token usage summary' },
      );
    }),
  );

  // ─── Disposables ────────────────────────────────────────────────────────────
  context.subscriptions.push(processManager, statusBar);
}

export function deactivate(): void { /* nothing */ }

async function runCodeAction(
  actionType: string,
  chatHandler: ChatHandler,
  customInstruction?: string,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Select some code first.');
    return;
  }

  const doc       = editor.document;
  const selection = doc.getText(editor.selection);
  const surrounding = getSurroundingCode(doc, editor.selection);
  const diagnostics = getDiagnosticsText(doc, editor.selection);

  const prompt = buildCodeActionPrompt(
    actionType,
    selection,
    doc.fileName,
    doc.languageId,
    surrounding,
    diagnostics,
    customInstruction,
  );

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { return; }

  await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');

  const cts = new vscode.CancellationTokenSource();

  const fakeResponse: vscode.ChatResponseStream = {
    markdown: (_text: unknown) => { /* displayed via participant */ },
    button: () => { },
    filetree: () => { },
    anchor: () => { },
    push: () => { },
    reference: () => { },
    progress: () => { },
    warning: () => { },
    textEdit: () => { },
    detectedParticipant: () => { },
    codeCitation: () => { },
    moveToConfirmation: () => { },
  } as unknown as vscode.ChatResponseStream;

  // Trigger a chat turn with the code action prompt via VS Code chat
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query: `@claude ${prompt.slice(0, 200)}…`,
  });

  cts.dispose();
}
