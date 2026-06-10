import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { computeHunks, Hunk } from './hunkParser';

export interface TurnSnapshot {
  baseHash: string | undefined;
  /** relPath -> pre-turn working-tree content, for every file `git status` shows as
   *  dirty or untracked — i.e. every file where `HEAD:path` would be the WRONG "before". */
  dirtySnapshots: Map<string, string>;
}

export interface FileChange {
  relPath: string;
  absPath: string;
  beforeContent: string;
  afterContent: string;
  hunks: Hunk[];
  isNew: boolean;
  isDeleted: boolean;
}

/**
 * Tracks what an AI turn changed, independent of git HEAD.
 *
 * The naive `git diff <baseHash>` approach has three gaps: it misses untracked files,
 * it conflates the user's own pre-existing edits with the AI's (dirty-state attribution),
 * and it does nothing at all outside a git repo. We close all three by snapshotting the
 * actual pre-turn working-tree content of every file that could be misrepresented by HEAD
 * (dirty + untracked — bounded by `git status`, not a full-workspace scan), then diffing
 * in-memory against post-turn content with `computeHunks` (no git subprocess in the diff
 * itself, so it works uniformly for tracked/dirty/untracked/no-git content).
 */
export class ChangeTracker implements vscode.Disposable {
  private _log = vscode.window.createOutputChannel('AVN Edits');

  // absPath -> content the user explicitly "kept" — suppresses re-surfacing on later turns
  // until the file changes again (ports the accepted-snapshot behavior from b03a55b).
  private _accepted = new Map<string, string>();

  async beginTurn(root: string): Promise<TurnSnapshot> {
    const baseHash = await gitHead(root);
    const dirtySnapshots = new Map<string, string>();

    if (baseHash) {
      const dirty = await gitDirtyAndUntrackedPaths(root);
      for (const rel of dirty) {
        dirtySnapshots.set(rel, readFileSafe(path.join(root, rel)));
      }
      this._log.appendLine(`[beginTurn] baseHash=${baseHash.slice(0, 8)} dirty/untracked snapshot=${dirty.length} file(s)`);
    } else {
      this._log.appendLine('[beginTurn] not a git repo — degraded no-git tracking');
    }
    return { baseHash, dirtySnapshots };
  }

  async computeChanges(root: string, snapshot: TurnSnapshot): Promise<FileChange[]> {
    const { baseHash, dirtySnapshots } = snapshot;
    let relPaths: string[];

    if (baseHash) {
      const [changed, untracked] = await Promise.all([
        gitChangedFiles(root, baseHash),
        gitUntrackedFiles(root),
      ]);
      relPaths = [...new Set([...changed, ...untracked])];
    } else {
      // No-git fallback: we can only know about files we already snapshotted pre-turn
      // (brand-new files are undiscoverable without git). Bounded, honest degradation.
      relPaths = [...dirtySnapshots.keys()];
    }

    const changes: FileChange[] = [];
    for (const rel of relPaths) {
      const absPath = path.join(root, rel);
      const isDeleted = !fs.existsSync(absPath);
      const afterContent = isDeleted ? '' : readFileSafe(absPath);

      let beforeContent: string;
      let existedBefore: boolean;
      if (dirtySnapshots.has(rel)) {
        beforeContent = dirtySnapshots.get(rel)!;
        existedBefore = true; // it was dirty/untracked, i.e. present pre-turn
      } else if (baseHash) {
        const shown = await gitShowAtHash(root, baseHash, rel);
        beforeContent = shown.content;
        existedBefore = shown.existed;
      } else {
        beforeContent = '';
        existedBefore = false;
      }

      const hunks = computeHunks(beforeContent, afterContent);
      if (hunks.length === 0) { continue; }

      if (this._accepted.get(absPath) === afterContent) {
        continue; // user already reviewed & kept exactly this content
      }

      changes.push({
        relPath: rel,
        absPath,
        beforeContent,
        afterContent,
        hunks,
        isNew:     !existedBefore && !isDeleted,
        isDeleted,
      });
    }
    this._log.appendLine(`[computeChanges] ${changes.length} file(s) with AI hunks`);
    return changes;
  }

  /** Mark a file's current on-disk content as reviewed — won't resurface until it changes again. */
  markAccepted(absPath: string): void {
    this._accepted.set(absPath, readFileSafe(absPath));
  }

  /** Forget the accepted state — used after a revert so the file can resurface if re-edited. */
  clearAccepted(absPath: string): void {
    this._accepted.delete(absPath);
  }

  dispose(): void { this._log.dispose(); }
}

// ─── git helpers ──────────────────────────────────────────────────────────

function gitHead(cwd: string): Promise<string | undefined> {
  return new Promise(resolve => {
    cp.exec('git rev-parse HEAD', { cwd }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim() || undefined);
    });
  });
}

function gitChangedFiles(cwd: string, baseHash: string): Promise<string[]> {
  return new Promise(resolve => {
    cp.exec(`git diff --name-only ${baseHash}`, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? [] : splitLines(stdout));
    });
  });
}

function gitUntrackedFiles(cwd: string): Promise<string[]> {
  return new Promise(resolve => {
    cp.exec('git ls-files --others --exclude-standard', { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? [] : splitLines(stdout));
    });
  });
}

/** Every path whose working-tree content can differ from HEAD: dirty tracked + untracked. */
function gitDirtyAndUntrackedPaths(cwd: string): Promise<string[]> {
  return new Promise(resolve => {
    cp.exec('git status --porcelain=v1', { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const paths = new Set<string>();
      for (const raw of stdout.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line.length < 4) { continue; }
        let rest = line.slice(3);
        const arrow = rest.indexOf(' -> ');           // renames: "old -> new" — track the new path
        if (arrow !== -1) { rest = rest.slice(arrow + 4); }
        paths.add(unquotePath(rest));
      }
      resolve([...paths]);
    });
  });
}

function gitShowAtHash(cwd: string, hash: string, relPath: string): Promise<{ content: string; existed: boolean }> {
  const gitPath = relPath.split(path.sep).join('/');
  return new Promise(resolve => {
    cp.exec(`git show "${hash}:${gitPath}"`, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? { content: '', existed: false } : { content: stdout, existed: true });
    });
  });
}

function splitLines(s: string): string[] {
  return s.split('\n').map(line => unquotePath(line.trim())).filter(Boolean);
}

/** git quotes paths containing special characters in `"like\tthis"` — strip the quotes. */
function unquotePath(p: string): string {
  return /^".*"$/.test(p) ? p.slice(1, -1) : p;
}

function readFileSafe(absPath: string): string {
  try { return fs.readFileSync(absPath, 'utf8'); }
  catch { return ''; }
}
