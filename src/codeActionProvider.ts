import * as vscode from 'vscode';

export const CODE_ACTION_KINDS = {
  explain:   vscode.CodeActionKind.Empty.append('claude.explain'),
  fix:       vscode.CodeActionKind.QuickFix.append('claude.fix'),
  refactor:  vscode.CodeActionKind.Refactor.append('claude.refactor'),
  addTests:  vscode.CodeActionKind.Empty.append('claude.addTests'),
  addDocs:   vscode.CodeActionKind.Empty.append('claude.addDocs'),
  findBugs:  vscode.CodeActionKind.Empty.append('claude.findBugs'),
  custom:    vscode.CodeActionKind.Empty.append('claude.custom'),
};

export class ClaudeCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = Object.values(CODE_ACTION_KINDS);

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    if (range instanceof vscode.Selection && range.isEmpty) { return []; }
    if (range instanceof vscode.Range && range.isEmpty) { return []; }

    return [
      this.make('Claude: Explain this',        'claude.action.explain',    CODE_ACTION_KINDS.explain),
      this.make('Claude: Fix this',            'claude.action.fix',        CODE_ACTION_KINDS.fix),
      this.make('Claude: Refactor this',       'claude.action.refactor',   CODE_ACTION_KINDS.refactor),
      this.make('Claude: Add tests',           'claude.action.addTests',   CODE_ACTION_KINDS.addTests),
      this.make('Claude: Add documentation',   'claude.action.addDocs',    CODE_ACTION_KINDS.addDocs),
      this.make('Claude: Find bugs',           'claude.action.findBugs',   CODE_ACTION_KINDS.findBugs),
      this.make('Claude: Custom prompt…',      'claude.action.custom',     CODE_ACTION_KINDS.custom),
    ];
  }

  private make(title: string, command: string, kind: vscode.CodeActionKind): vscode.CodeAction {
    const action = new vscode.CodeAction(title, kind);
    action.command = { title, command };
    return action;
  }
}

export function buildCodeActionPrompt(
  actionType: string,
  selection: string,
  filePath: string,
  languageId: string,
  surroundingCode: string,
  diagnostics: string,
  customInstruction?: string,
): string {
  const codeBlock = `<selected-code file="${filePath}" lang="${languageId}">\n${selection}\n</selected-code>`;
  const surroundBlock = surroundingCode
    ? `<surrounding-code>\n${surroundingCode}\n</surrounding-code>`
    : '';
  const diagBlock = diagnostics
    ? `<diagnostics>\n${diagnostics}\n</diagnostics>`
    : '';

  const instructions: Record<string, string> = {
    explain:  'Explain what this code does. Be concise and clear.',
    fix:      'Fix the issues in this code. Apply edits directly to the file.',
    refactor: 'Refactor this code to improve readability, performance, or structure. Apply edits directly.',
    addTests: 'Generate comprehensive unit tests for this code. Create or append to the appropriate test file.',
    addDocs:  'Add docstrings, JSDoc comments, or inline comments to this code. Apply edits directly.',
    findBugs: 'Identify potential bugs, edge cases, or issues in this code. List findings clearly. Do NOT auto-edit.',
    custom:   customInstruction ?? '',
  };

  const instruction = instructions[actionType] ?? '';

  return [codeBlock, surroundBlock, diagBlock, `<instruction>${instruction}</instruction>`]
    .filter(Boolean)
    .join('\n\n');
}

export function getDiagnosticsText(
  document: vscode.TextDocument,
  range: vscode.Range,
): string {
  const diags = vscode.languages.getDiagnostics(document.uri);
  const relevant = diags.filter(d => range.intersection(d.range));
  if (!relevant.length) { return ''; }
  return relevant
    .map(d => `[${severityLabel(d.severity)}] Line ${d.range.start.line + 1}: ${d.message}`)
    .join('\n');
}

function severityLabel(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:       return 'ERROR';
    case vscode.DiagnosticSeverity.Warning:     return 'WARNING';
    case vscode.DiagnosticSeverity.Information: return 'INFO';
    default: return 'HINT';
  }
}

export function getSurroundingCode(
  document: vscode.TextDocument,
  range: vscode.Range,
  lines = 30,
): string {
  const startLine = Math.max(0, range.start.line - lines);
  const endLine   = Math.min(document.lineCount - 1, range.end.line + lines);
  return document.getText(new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length));
}
