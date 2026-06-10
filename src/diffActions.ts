import * as vscode from 'vscode';
import { DiffDecorator } from './diffDecorator';
import { ChangeTracker } from './changeTracker';
import { Hunk } from './hunkParser';

/**
 * Keep/Revert actions shared by the in-editor CodeLens commands and the chat-side
 * "Keep"/"Revert" buttons — one code path for both surfaces.
 */

/** Accept one hunk: stop tracking it. Once a file has none left, mark it reviewed. */
export function keepHunk(decorator: DiffDecorator, tracker: ChangeTracker, absPath: string, hunkIdx: number): void {
  decorator.removeHunk(absPath, hunkIdx);
  if (decorator.getFileHunks(absPath).length === 0) {
    tracker.markAccepted(absPath);
  }
}

/** Accept every hunk in a file: stop tracking and mark its current content reviewed. */
export function keepFileChanges(decorator: DiffDecorator, tracker: ChangeTracker, absPath: string): void {
  decorator.clearFile(absPath);
  tracker.markAccepted(absPath);
}

/** Revert one hunk: rewrite the file with just that change undone. */
export async function revertHunk(
  decorator: DiffDecorator,
  tracker:   ChangeTracker,
  absPath:   string,
  hunkIdx:   number,
): Promise<void> {
  const hunk = decorator.getFileHunks(absPath)[hunkIdx];
  if (!hunk) { return; }

  const uri = vscode.Uri.file(absPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  await writeWholeFile(uri, doc, revertHunkInContent(doc.getText(), hunk));

  decorator.removeHunk(absPath, hunkIdx);
  tracker.clearAccepted(absPath);
}

/** Revert every hunk in a file: undo them bottom-to-top so earlier line numbers stay valid. */
export async function revertFileChanges(
  decorator: DiffDecorator,
  tracker:   ChangeTracker,
  absPath:   string,
): Promise<void> {
  const hunks = decorator.hunksFor(absPath); // ascending by newStart
  if (!hunks.length) { return; }

  const uri = vscode.Uri.file(absPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  let content = doc.getText();
  for (let i = hunks.length - 1; i >= 0; i--) {
    content = revertHunkInContent(content, hunks[i]);
  }
  await writeWholeFile(uri, doc, content);

  decorator.clearFile(absPath);
  tracker.clearAccepted(absPath);
}

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Undo a single hunk against `content` by splicing its line range back to `oldLines`.
 * String-level (split/join on '\n') so there's no Range/Position edge-case handling for
 * insertions at EOF or replacements spanning the last line — array splice + join round-trips
 * exactly for any input, including missing trailing newlines.
 *
 * `hunk.newStart` follows unified-diff convention: 1-based first added line normally, but
 * for pure deletions (newCount === 0) it's the 0-based array index to splice the removed
 * lines back into (see hunkParser.ts for the git-vs-jsdiff convention note).
 */
function revertHunkInContent(content: string, hunk: Hunk): string {
  const lines = content.split('\n');
  if (hunk.newCount > 0) {
    lines.splice(hunk.newStart - 1, hunk.newCount, ...hunk.oldLines);
  } else {
    lines.splice(hunk.newStart, 0, ...hunk.oldLines);
  }
  return lines.join('\n');
}

async function writeWholeFile(uri: vscode.Uri, doc: vscode.TextDocument, newContent: string): Promise<void> {
  if (doc.getText() === newContent) { return; }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), newContent);
  await vscode.workspace.applyEdit(edit);
  // The AI writes straight to disk; save the revert back too so disk and editor agree
  // (otherwise the next turn's change-detection would still see the AI's on-disk version).
  if (doc.isDirty) { await doc.save(); }
}
