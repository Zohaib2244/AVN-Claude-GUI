import * as Diff from 'diff';

export interface Hunk {
  newStart: number;      // 1-based first new line (unified-diff convention: oldStart-1 for pure deletions)
  newCount: number;      // number of lines added (0 = pure deletion)
  oldLines: string[];    // removed line contents
  newLines: string[];    // added line contents
}

/**
 * Diff two in-memory strings into hunks (no git involved — works for tracked,
 * dirty, untracked, and no-git content alike).
 *
 * jsdiff's structuredPatch reports `newStart` for pure-deletion hunks as the old-file
 * line number; unified-diff/git convention (which the decorator math below assumes)
 * reports it one lower — the line *after* which the deletion occurred. Adjust to match.
 */
export function computeHunks(before: string, after: string): Hunk[] {
  if (before === after) { return []; }
  const patch = Diff.structuredPatch('a', 'b', before, after, '', '', { context: 0 });
  const hunks: Hunk[] = [];
  for (const h of patch.hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of h.lines) {
      if (line.startsWith('-'))      { oldLines.push(line.slice(1)); }
      else if (line.startsWith('+')) { newLines.push(line.slice(1)); }
      // lines starting with '\' (e.g. "\ No newline at end of file") are metadata — skip
    }
    hunks.push({
      newStart: h.newLines === 0 ? h.newStart - 1 : h.newStart,
      newCount: h.newLines,
      oldLines,
      newLines,
    });
  }
  return hunks;
}
