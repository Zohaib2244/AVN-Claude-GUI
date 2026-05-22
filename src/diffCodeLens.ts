import * as vscode from 'vscode';
import { DiffDecorator } from './diffDecorator';

export class DiffCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._emitter.event;

  constructor(private readonly decorator: DiffDecorator) {}

  refresh(): void { this._emitter.fire(); }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const hunks = this.decorator.hunksFor(document.uri.fsPath);
    if (!hunks.length) { return []; }
    const filePath = document.uri.fsPath;
    const lenses: vscode.CodeLens[] = [];

    // Top-of-file: keep all / undo all for this file
    const top = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(top, {
        title:     `$(check-all) Keep all (${hunks.length})`,
        command:   'avn.keepFileChanges',
        arguments: [filePath],
        tooltip:   'Accept every AI change in this file',
      }),
      new vscode.CodeLens(top, {
        title:     '$(discard) Undo all',
        command:   'avn.revertFileChanges',
        arguments: [filePath],
        tooltip:   'Revert every AI change in this file',
      }),
    );

    // Per-hunk lenses
    hunks.forEach((h, idx) => {
      const line     = Math.max(0, h.newStart - 1);
      const range    = new vscode.Range(line, 0, line, 0);
      const summary  = `−${h.oldLines.length} +${h.newLines.length}`;
      lenses.push(
        new vscode.CodeLens(range, {
          title:     `$(check) Keep  ${summary}`,
          command:   'avn.keepHunk',
          arguments: [filePath, idx],
          tooltip:   'Accept this change',
        }),
        new vscode.CodeLens(range, {
          title:     '$(discard) Undo this',
          command:   'avn.revertHunk',
          arguments: [filePath, idx],
          tooltip:   'Revert just this change',
        }),
      );
    });

    return lenses;
  }

  dispose(): void { this._emitter.dispose(); }
}
