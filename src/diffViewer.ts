import * as vscode from 'vscode';
import * as path from 'path';

/**
 * TextDocumentContentProvider that serves arbitrary in-memory "before" snapshots so
 * `vscode.diff` can show before/after without writing temp files — used for the chat's
 * "Show diff" button.
 *
 * Content is registered on demand (one entry per rendered file, per turn) and handed
 * back via an opaque id in the URI query: `avn-snapshot:/<name>?id=<id>`.
 *
 * Serving the same `beforeContent` string that drove the hunk computation (rather than
 * re-deriving it from `git show HEAD:<path>`) keeps this, the chat diff block, and the
 * editor decorations all showing exactly the same "before" — correct for tracked, dirty,
 * untracked, and no-git files alike (see ChangeTracker for how `beforeContent` is resolved).
 */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'avn-snapshot';

  private _store = new Map<string, string>();
  private _seq   = 0;

  /** Register a snapshot's content and return a URI that serves it. */
  register(relPath: string, content: string): vscode.Uri {
    const id = `${Date.now()}-${++this._seq}`;
    this._store.set(id, content);
    const name = encodeURIComponent(path.basename(relPath));
    return vscode.Uri.parse(`${SnapshotContentProvider.scheme}:/${name}?id=${id}`);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = new URLSearchParams(uri.query).get('id') ?? '';
    return this._store.get(id) ?? '';
  }
}
