import * as vscode from 'vscode';
import { Hunk } from './hunkParser';

/**
 * Applies in-editor decorations for AI-edited hunks:
 *   • green background on added line ranges (uses VS Code diff theme colors)
 *   • bold green gutter marker beside each added line
 *   • inline "− N removed: <preview>" italic hint at the deletion site
 *   • overview-ruler ticks on the right scrollbar
 */
export class DiffDecorator implements vscode.Disposable {
  private _log = vscode.window.createOutputChannel('AVN Diff (Debug)');

  private _addedLine     = vscode.window.createTextEditorDecorationType({
    backgroundColor:    new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    isWholeLine:        true,
    overviewRulerColor: new vscode.ThemeColor('diffEditorOverview.insertedForeground'),
    overviewRulerLane:  vscode.OverviewRulerLane.Right,
  });

  private _addedGutter   = vscode.window.createTextEditorDecorationType({
    gutterIconPath:     this._svgIcon('#4ec9b0'),
    gutterIconSize:     'contain',
  });

  private _removedMark   = vscode.window.createTextEditorDecorationType({
    isWholeLine:        false,
    after: {
      margin:           '0 0 0 1em',
      color:            new vscode.ThemeColor('errorForeground'),
      fontStyle:        'italic',
    },
    overviewRulerColor: new vscode.ThemeColor('diffEditorOverview.removedForeground'),
    overviewRulerLane:  vscode.OverviewRulerLane.Right,
  });

  // filePath (absolute) -> hunks
  private _filesToHunks = new Map<string, Hunk[]>();

  constructor() {
    vscode.window.onDidChangeVisibleTextEditors(() => this._refreshAll());
    vscode.window.onDidChangeActiveTextEditor(()   => this._refreshAll());
  }

  setFileHunks(absPath: string, hunks: Hunk[]): void {
    this._log.appendLine(`[setFileHunks] ${absPath}  hunks=${hunks.length}`);
    if (hunks.length === 0) { this._filesToHunks.delete(absPath); }
    else                    { this._filesToHunks.set(absPath, hunks); }
    this._applyToFile(absPath);
  }

  getFileHunks(absPath: string): Hunk[] { return this._filesToHunks.get(absPath) ?? []; }

  removeHunk(absPath: string, hunkIdx: number): void {
    const hunks = this._filesToHunks.get(absPath);
    if (!hunks) { return; }
    hunks.splice(hunkIdx, 1);
    if (hunks.length === 0) { this._filesToHunks.delete(absPath); }
    this._applyToFile(absPath);
  }

  clearFile(absPath: string): void {
    this._filesToHunks.delete(absPath);
    this._applyToFile(absPath);
  }

  clearAll(): void {
    const paths = [...this._filesToHunks.keys()];
    this._filesToHunks.clear();
    paths.forEach(p => this._applyToFile(p));
  }

  /** Get the hunks list ordered by line number — used for next/prev nav. */
  hunksFor(absPath: string): Hunk[] {
    const list = this._filesToHunks.get(absPath) ?? [];
    return [...list].sort((a, b) => a.newStart - b.newStart);
  }

  /** Get the set of files that currently have hunks tracked. */
  changedFiles(): string[] { return [...this._filesToHunks.keys()]; }

  private _refreshAll(): void {
    for (const p of this._filesToHunks.keys()) { this._applyToFile(p); }
  }

  private _applyToFile(absPath: string): void {
    const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.fsPath === absPath);
    if (!editors.length) {
      this._log.appendLine(`[apply] ${absPath} — no visible editor (open the file to see decorations)`);
      return;
    }
    const hunks  = this._filesToHunks.get(absPath) ?? [];
    this._log.appendLine(`[apply] ${absPath} — applying ${hunks.length} hunks to ${editors.length} editor(s)`);
    const added:   vscode.DecorationOptions[] = [];
    const gutter:  vscode.DecorationOptions[] = [];
    const removed: vscode.DecorationOptions[] = [];

    for (const h of hunks) {
      const last = Math.max(0, h.newStart + h.newCount - 1);
      // Green background on added lines
      if (h.newCount > 0) {
        const range = new vscode.Range(h.newStart - 1, 0, last - 1, Number.MAX_SAFE_INTEGER);
        added.push({ range });
        // Gutter ticks on each added line
        for (let l = h.newStart; l <= last; l++) {
          gutter.push({ range: new vscode.Range(l - 1, 0, l - 1, 0) });
        }
      }
      // Inline marker for pure deletions or where lines were removed
      if (h.oldLines.length > 0) {
        const anchor = Math.max(0, h.newStart - 1);   // line above the change
        const preview = h.oldLines[0].trim().slice(0, 60);
        const hint   = h.newCount === 0
          ? `  − ${h.oldLines.length} line${h.oldLines.length > 1 ? 's' : ''} removed`
          : `  − ${h.oldLines.length} removed: ${preview}${preview.length === 60 ? '…' : ''}`;
        removed.push({
          range: new vscode.Range(anchor, 0, anchor, 0),
          renderOptions: { after: { contentText: hint, color: '#f14c4c', fontStyle: 'italic' } },
        });
      }
    }

    for (const ed of editors) {
      ed.setDecorations(this._addedLine,   added);
      ed.setDecorations(this._addedGutter, gutter);
      ed.setDecorations(this._removedMark, removed);
    }
  }

  private _svgIcon(color: string): vscode.Uri {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="6" height="16"><rect width="3" height="16" fill="${color}"/></svg>`;
    return vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
  }

  dispose(): void {
    this._addedLine.dispose();
    this._addedGutter.dispose();
    this._removedMark.dispose();
    this._log.dispose();
  }
}
