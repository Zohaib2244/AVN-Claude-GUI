import * as cp from 'child_process';
import * as path from 'path';

export interface Hunk {
  newStart: number;      // 1-based first new line
  newCount: number;      // number of lines added (0 = pure deletion)
  oldLines: string[];    // removed line contents
  newLines: string[];    // added line contents
}

/**
 * Run `git diff <baseHash> -- <relPath> -U0` and parse into hunks.
 * Returns [] if the file is unchanged or the command fails.
 */
export function computeFileHunks(baseHash: string, absPath: string, cwd: string): Promise<Hunk[]> {
  const relPath = path.relative(cwd, absPath);
  const gitPath = relPath.split(path.sep).join('/');
  return new Promise(resolve => {
    cp.exec(
      `git diff ${baseHash} -U0 -- "${gitPath}"`,
      { cwd, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout.trim()) { resolve([]); return; }
        resolve(parseUnifiedDiff(stdout));
      },
    );
  });
}

/** Parse unified-diff output (with -U0 context) into hunks. */
export function parseUnifiedDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = diff.split('\n');
  let current: Hunk | null = null;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) { hunks.push(current); }
      // @@ -oldStart[,oldCount] +newStart[,newCount] @@
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) { current = null; continue; }
      current = {
        newStart: parseInt(m[3], 10),
        newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
        oldLines: [],
        newLines: [],
      };
    } else if (current && line.startsWith('-') && !line.startsWith('---')) {
      current.oldLines.push(line.slice(1));
    } else if (current && line.startsWith('+') && !line.startsWith('+++')) {
      current.newLines.push(line.slice(1));
    }
  }
  if (current) { hunks.push(current); }
  return hunks;
}
