import * as path from 'path';
import * as vscode from 'vscode';
import { ProcessManager } from './processManager';
import { OpenCodeManager } from './openCodeManager';
import { StatusBarManager } from './statusBar';
import { BackendController } from './backendController';
import { AvnChatParticipant } from './chatParticipant';
import { addOpenCodeModelsFlow } from './openCodeModelBrowser';
import { SnapshotContentProvider } from './diffViewer';
import { ChangeTracker } from './changeTracker';
import { DiffDecorator } from './diffDecorator';
import { DiffCodeLensProvider } from './diffCodeLens';
import * as diffActions from './diffActions';
import { InlineCompletionProvider } from './completionProvider';
import {
  ClaudeCodeActionProvider,
  buildCodeActionPrompt,
  getDiagnosticsText,
  getSurroundingCode,
} from './codeActionProvider';
import { ProjectIndexer } from './projectIndexer';
import { ChatStream, AvnMode, ThinkingBudget } from './types';

export function activate(context: vscode.ExtensionContext): void {
  const processManager  = new ProcessManager();
  const openCodeManager = new OpenCodeManager();
  const statusBar       = new StatusBarManager();
  const controller      = new BackendController(context);

  // ─── AI-edit review: change tracking, in-editor decorations + CodeLens ─────
  const changeTracker    = new ChangeTracker();
  const decorator        = new DiffDecorator();
  const codeLensProvider = new DiffCodeLensProvider(decorator);
  const snapshotProvider = new SnapshotContentProvider();

  const participant = new AvnChatParticipant(
    processManager, openCodeManager, controller, statusBar,
    changeTracker, decorator, codeLensProvider, snapshotProvider,
  );

  context.subscriptions.push(
    changeTracker, decorator, codeLensProvider,
    vscode.workspace.registerTextDocumentContentProvider(SnapshotContentProvider.scheme, snapshotProvider),
    vscode.languages.registerCodeLensProvider({ pattern: '**' }, codeLensProvider),

    // Thin wrapper so the chat's "Show diff" command link can pass plain-string URIs —
    // command-link arguments round-trip through JSON, where `vscode.Uri` objects aren't
    // guaranteed to revive correctly but strings always do.
    vscode.commands.registerCommand('avn.showDiff', (originalUriStr: string, currentUriStr: string, title: string) =>
      vscode.commands.executeCommand('vscode.diff', vscode.Uri.parse(originalUriStr), vscode.Uri.parse(currentUriStr), title)),

    vscode.commands.registerCommand('avn.keepHunk',          (absPath: string, idx: number) => diffActions.keepHunk(decorator, changeTracker, absPath, idx)),
    vscode.commands.registerCommand('avn.revertHunk',        (absPath: string, idx: number) => diffActions.revertHunk(decorator, changeTracker, absPath, idx)),
    vscode.commands.registerCommand('avn.keepFileChanges',   (absPath: string)              => diffActions.keepFileChanges(decorator, changeTracker, absPath)),
    vscode.commands.registerCommand('avn.revertFileChanges', (absPath: string)              => diffActions.revertFileChanges(decorator, changeTracker, absPath)),
  );

  // ─── Chat Participant ──────────────────────────────────────────────────────
  const chatPart = vscode.chat.createChatParticipant('avn.chat', (req, ctx, res, tok) => participant.handle(req, ctx, res, tok));
  chatPart.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'claude-icon.svg');
  chatPart.followupProvider = {
    provideFollowups(_result, _ctx, _tok) {
      return [
        { prompt: '/help',    label: 'See available commands', command: 'help' },
        { prompt: '/model',   label: 'Change model',           command: 'model' },
        { prompt: '/mode',    label: 'Change mode',            command: 'mode' },
      ];
    },
  };

  context.subscriptions.push(chatPart, processManager, openCodeManager, statusBar, controller);

  // ─── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('avn.openChat', async () => {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@avn ' });
    }),

    vscode.commands.registerCommand('avn.switchModel', () => pickModel(controller)),
    vscode.commands.registerCommand('avn.switchMode',  () => pickMode(controller)),
    vscode.commands.registerCommand('avn.switchThinking', () => pickThinking(controller)),

    vscode.commands.registerCommand('avn.addOpenCodeModel', () => addOpenCodeModelsFlow()),

    vscode.commands.registerCommand('avn.indexProject', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { vscode.window.showWarningMessage('No workspace folder open.'); return; }
      const indexer = new ProjectIndexer(processManager);
      const cts = new vscode.CancellationTokenSource();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'AVN: Indexing project…', cancellable: true },
        async (_progress, cancelToken) => {
          cancelToken.onCancellationRequested(() => cts.cancel());
          const notifStream: ChatStream = {
            markdown: (text) => vscode.window.showInformationMessage(text.slice(0, 200)),
          };
          await indexer.index(root, controller.getModel(), notifStream, cts.token);
        },
      );
      cts.dispose();
    }),
  );

  // ─── Inline Completions (kept; ghost-text suggestions on type) ────────────
  const completionProvider = new InlineCompletionProvider(
    processManager,
    statusBar,
    () => controller.getModel(),
    () => controller.getMode() === 'auto',
    () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  );
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, completionProvider),
    completionProvider,
  );

  // ─── Right-click Code Actions ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { pattern: '**' },
      new ClaudeCodeActionProvider(),
      { providedCodeActionKinds: ClaudeCodeActionProvider.providedCodeActionKinds },
    ),
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
      vscode.commands.registerCommand(cmd, () => runCodeAction(actionType, controller, processManager)),
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('claude.action.custom', async () => {
      const instruction = await vscode.window.showInputBox({
        prompt: "Describe what you'd like AVN to do with this selection…",
      });
      if (instruction) { runCodeAction('custom', controller, processManager, instruction); }
    }),
  );
}

export function deactivate(): void { /* nothing */ }

// ───────────────────────────────────────────────────────────────────────────
// QuickPick helpers
// ───────────────────────────────────────────────────────────────────────────

async function pickModel(controller: BackendController): Promise<void> {
  const cfg     = vscode.workspace.getConfiguration('avn');
  const claude  = cfg.get<string[]>('claudeModels',   []);
  const opencode = cfg.get<string[]>('openCodeModels', []);
  const items: vscode.QuickPickItem[] = [
    { label: 'Claude', kind: vscode.QuickPickItemKind.Separator },
    ...claude.map(m => ({ label: m, description: m === controller.getModel() ? '✓ current' : '' })),
    { label: 'OpenCode', kind: vscode.QuickPickItemKind.Separator },
    ...(opencode.length
      ? opencode.map(m => ({ label: m, description: m === controller.getModel() ? '✓ current' : '' }))
      : [{ label: '(no OpenCode models — run "AVN: Add OpenCode Model")', description: '', alwaysShow: true }]),
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select model' });
  if (!picked || picked.kind === vscode.QuickPickItemKind.Separator) { return; }
  if (picked.label.startsWith('(no OpenCode')) {
    vscode.commands.executeCommand('avn.addOpenCodeModel'); return;
  }
  await controller.setModel(picked.label);
}

async function pickMode(controller: BackendController): Promise<void> {
  const current = controller.getMode();
  const items: Array<{ label: string; value: AvnMode; description: string }> = [
    { label: 'Ask before edits',   value: 'ask',  description: current === 'ask'  ? '✓ current' : '' },
    { label: 'Edit automatically', value: 'auto', description: current === 'auto' ? '✓ current' : '' },
    { label: 'Plan mode (no edits)', value: 'plan', description: current === 'plan' ? '✓ current' : '' },
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select AVN mode' });
  if (picked) { await controller.setMode(picked.value); }
}

async function pickThinking(controller: BackendController): Promise<void> {
  if (!controller.supportsThinking()) {
    vscode.window.showInformationMessage(`Extended thinking is not supported by ${controller.getModel()}.`);
    return;
  }
  const current = controller.getThinking();
  const items: Array<{ label: string; value: ThinkingBudget | undefined; description: string }> = [
    { label: 'Off',                  value: undefined, description: current === undefined ? '✓ current' : '' },
    { label: 'Low (1k tokens)',      value: 'low',     description: current === 'low'    ? '✓ current' : '' },
    { label: 'Medium (4k tokens)',   value: 'medium',  description: current === 'medium' ? '✓ current' : '' },
    { label: 'High (10k tokens)',    value: 'high',    description: current === 'high'   ? '✓ current' : '' },
    { label: 'Max (32k tokens)',     value: 'max',     description: current === 'max'    ? '✓ current' : '' },
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Extended thinking budget' });
  if (picked) { await controller.setThinking(picked.value); }
}

// ───────────────────────────────────────────────────────────────────────────
// Code-action runner — routes right-click actions through the chat panel.
// ───────────────────────────────────────────────────────────────────────────

async function runCodeAction(
  actionType: string,
  _controller: BackendController,
  _processManager: ProcessManager,
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

  const fullPrompt = buildCodeActionPrompt(
    actionType, selection, doc.fileName, doc.languageId,
    surrounding, diagnostics, customInstruction,
  );
  const displayText = `/${actionType}: ${path.basename(doc.fileName)}`;

  // Open the chat panel with `@avn <displayText>` and the full prompt as the query body.
  // Two-step: open with summary line, then we'd need to inject the full prompt — VS Code's
  // chat.open API supports a single `query` string, so we send the full prompt directly.
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query: `@avn ${displayText}\n\n${fullPrompt}`,
  });
}
