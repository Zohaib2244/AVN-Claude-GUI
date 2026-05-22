import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

/**
 * Serves the HEAD-version of a file via a virtual URI so vscode.diff can show
 * before/after without writing to disk. URI shape:
 *   avn-original:/show?rel=<encoded-relpath>&cwd=<encoded-root>
 */
export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'avn-original';

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const rel    = params.get('rel') ? decodeURIComponent(params.get('rel')!) : '';
    const cwd    = params.get('cwd') ? decodeURIComponent(params.get('cwd')!) : undefined;
    const git    = rel.split(path.sep).join('/');
    return new Promise(resolve => {
      cp.exec(`git show "HEAD:${git}"`, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? '' : stdout);
      });
    });
  }
}

/**
 * After an AI turn, open a diff editor for each file changed vs HEAD.
 * If more than `threshold` files changed, ask the user before opening all of them.
 */
export async function showChangedFileDiffs(root: string, threshold = 5): Promise<void> {
  const files = await listChangedFiles(root);
  if (files.length === 0) { return; }

  if (files.length > threshold) {
    const pick = await vscode.window.showInformationMessage(
      `AVN changed ${files.length} files. Open all diff views?`,
      { modal: false },
      'Open all',
      'Show list',
      'Skip',
    );
    if (pick === 'Skip' || pick === undefined) { return; }
    if (pick === 'Show list') {
      const chosen = await vscode.window.showQuickPick(files, {
        canPickMany: true, placeHolder: 'Select files to open in diff view',
      });
      if (!chosen || chosen.length === 0) { return; }
      for (const f of chosen) { await openOne(root, f); }
      return;
    }
  }
  for (const f of files) { await openOne(root, f); }
}

async function openOne(root: string, relPath: string): Promise<void> {
  const abs        = path.join(root, relPath);
  const currentUri = vscode.Uri.file(abs);
  const q          = `rel=${encodeURIComponent(relPath)}&cwd=${encodeURIComponent(root)}`;
  const originalUri = vscode.Uri.parse(`${OriginalContentProvider.scheme}:/show?${q}`);
  const title      = `${path.basename(relPath)}  (HEAD ↔ working)`;
  await vscode.commands.executeCommand('vscode.diff', originalUri, currentUri, title, {
    preview:      true,
    viewColumn:   vscode.ViewColumn.Beside,
  });
}

function listChangedFiles(cwd: string): Promise<string[]> {
  return new Promise(resolve => {
    cp.exec('git diff --name-only HEAD', { cwd }, (err, stdout) => {
      if (err) { resolve([]); return; }
      resolve(stdout.split('\n').map(s => s.trim()).filter(Boolean));
    });
  });
}
