import * as vscode from 'vscode';

export class DiffCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private _files  = new Set<string>(); // absolute paths
  private _emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._emitter.event;

  setFiles(absolutePaths: string[]): void {
    this._files = new Set(absolutePaths);
    this._emitter.fire();
  }

  removeFile(absolutePath: string): void {
    this._files.delete(absolutePath);
    this._emitter.fire();
  }

  clearAll(): void {
    this._files.clear();
    this._emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this._files.has(document.uri.fsPath)) { return []; }
    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        title: '$(check) Keep',
        command: 'avn.keepFileChanges',
        arguments: [document.uri.fsPath],
        tooltip: 'Accept AI changes to this file',
      }),
      new vscode.CodeLens(range, {
        title: '$(discard) Revert file',
        command: 'avn.revertFileChanges',
        arguments: [document.uri.fsPath],
        tooltip: 'Undo AI changes to this file only',
      }),
    ];
  }

  dispose(): void { this._emitter.dispose(); }
}
