import * as vscode from 'vscode';
import * as path from 'path';
import * as Diff from 'diff';
import { FileChange } from './changeTracker';

interface HunkRow {
  kind: 'unchanged' | 'removed' | 'added' | 'changed';
  left: string;
  right: string;
}

interface HunkCard {
  fileName: string;
  absPath: string;
  hunkIndex: number;
  isNew: boolean;
  isDeleted: boolean;
  rows: HunkRow[];
  addedCount: number;
  removedCount: number;
}

export class DiffCardsProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  show(changes: FileChange[]): void {
    if (changes.length === 0) { return; }

    const cards: HunkCard[] = [];
    for (const change of changes) {
      const patch = Diff.structuredPatch(
        change.relPath, change.relPath,
        change.beforeContent, change.afterContent,
        '', '', { context: 3 },
      );
      for (let i = 0; i < patch.hunks.length; i++) {
        const h = patch.hunks[i];
        cards.push({
          fileName:     path.basename(change.relPath),
          absPath:      change.absPath,
          hunkIndex:    i,
          isNew:        change.isNew,
          isDeleted:    change.isDeleted,
          rows:         buildRows(h.lines),
          addedCount:   h.lines.filter(l => l.startsWith('+')).length,
          removedCount: h.lines.filter(l => l.startsWith('-')).length,
        });
      }
    }

    if (cards.length === 0) { return; }

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'avn.diffCards',
        'AVN Diff Review',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true },
      );
      this.panel.onDidDispose(() => { this.panel = undefined; });
      this.panel.webview.onDidReceiveMessage((msg: { type: 'keep' | 'revert'; absPath: string; hunkIndex?: number }) => {
        const isHunk = msg.hunkIndex !== undefined;
        if (msg.type === 'keep') {
          isHunk
            ? vscode.commands.executeCommand('avn.keepHunk', msg.absPath, msg.hunkIndex)
            : vscode.commands.executeCommand('avn.keepFileChanges', msg.absPath);
        } else if (msg.type === 'revert') {
          isHunk
            ? vscode.commands.executeCommand('avn.revertHunk', msg.absPath, msg.hunkIndex)
            : vscode.commands.executeCommand('avn.revertFileChanges', msg.absPath);
        }
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    }

    this.panel.webview.html = buildHtml(cards);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}

// ─── Row alignment ────────────────────────────────────────────────────────────

function buildRows(lines: string[]): HunkRow[] {
  const rows: HunkRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('\\')) { i++; continue; }

    if (line.startsWith(' ')) {
      rows.push({ kind: 'unchanged', left: line.slice(1), right: line.slice(1) });
      i++;
    } else if (line.startsWith('-')) {
      // Collect consecutive removed lines, then look ahead for consecutive added lines
      // and pair them so that each removed/added pair shares a row.
      const removed: string[] = [];
      while (i < lines.length && lines[i].startsWith('-')) { removed.push(lines[i].slice(1)); i++; }
      const added: string[] = [];
      while (i < lines.length && lines[i].startsWith('+')) { added.push(lines[i].slice(1)); i++; }

      const len = Math.max(removed.length, added.length);
      for (let j = 0; j < len; j++) {
        const hasL = j < removed.length;
        const hasR = j < added.length;
        rows.push({
          kind:  hasL && hasR ? 'changed' : hasL ? 'removed' : 'added',
          left:  hasL ? removed[j] : '',
          right: hasR ? added[j]   : '',
        });
      }
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'added', left: '', right: line.slice(1) });
      i++;
    } else {
      i++;
    }
  }
  return rows;
}

// ─── HTML rendering ───────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function subtitle(card: HunkCard): string {
  if (card.isNew)     { return 'New file'; }
  if (card.isDeleted) { return 'Deleted'; }
  if (card.addedCount > 0 && card.removedCount === 0) {
    return `Added ${card.addedCount} line${card.addedCount === 1 ? '' : 's'}`;
  }
  if (card.removedCount > 0 && card.addedCount === 0) {
    return `Removed ${card.removedCount} line${card.removedCount === 1 ? '' : 's'}`;
  }
  return 'Modified';
}

function renderCard(card: HunkCard): string {
  const rows = card.rows.map(row => {
    const lClass = row.kind === 'removed' || row.kind === 'changed' ? 'removed'
                 : row.kind === 'added'   ? 'ghost' : '';
    const rClass = row.kind === 'added'   || row.kind === 'changed' ? 'added'
                 : row.kind === 'removed' ? 'ghost' : '';
    const lContent = row.left  !== '' ? `<code>${esc(row.left)}</code>`  : '';
    const rContent = row.right !== '' ? `<code>${esc(row.right)}</code>` : '';
    return `<div class="row"><div class="cell ${lClass}">${lContent}</div><div class="cell ${rClass}">${rContent}</div></div>`;
  }).join('');

  const encodedPath = esc(card.absPath);
  return `
<div class="card">
  <div class="card-header">
    <span class="dot"></span>
    <span class="title">Edit <strong>${esc(card.fileName)}</strong></span>
    <div class="actions">
      <button class="btn keep" data-action="keep" data-path="${encodedPath}" data-hunk="${card.hunkIndex}">Keep</button>
      <button class="btn revert" data-action="revert" data-path="${encodedPath}" data-hunk="${card.hunkIndex}">Revert</button>
    </div>
  </div>
  <div class="card-subtitle">${subtitle(card)}</div>
  <div class="diff-grid">${rows}</div>
</div>`;
}

function buildHtml(cards: HunkCard[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: 13px;
    color: var(--vscode-editor-foreground, #ccc);
    background: var(--vscode-editor-background, #1e1e1e);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .card {
    border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
    border-radius: 6px;
    overflow: hidden;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    background: var(--vscode-editorGroupHeader-tabsBackground, rgba(255,255,255,0.04));
    border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.15));
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--vscode-charts-green, #4ec9b0);
    flex-shrink: 0;
  }

  .title {
    flex: 1;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .actions { display: flex; gap: 6px; flex-shrink: 0; }

  .btn {
    padding: 2px 10px;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
    border: 1px solid transparent;
    font-family: inherit;
    line-height: 1.5;
  }

  .btn.keep {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border-color: var(--vscode-button-border, transparent);
  }
  .btn.keep:hover { background: var(--vscode-button-hoverBackground, #1177bb); }

  .btn.revert {
    background: transparent;
    color: var(--vscode-foreground, #ccc);
    border-color: var(--vscode-button-secondaryBorder, rgba(128,128,128,0.4));
  }
  .btn.revert:hover { background: rgba(128,128,128,0.15); }

  .card-subtitle {
    padding: 3px 12px 5px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    background: var(--vscode-editorGroupHeader-tabsBackground, rgba(255,255,255,0.04));
    border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.12));
  }

  .diff-grid {
    max-height: 320px;
    overflow-y: auto;
    overflow-x: auto;
  }

  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    min-height: 18px;
    border-bottom: 1px solid rgba(128,128,128,0.05);
  }
  .row:last-child { border-bottom: none; }

  .cell {
    padding: 0 8px;
    font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', 'Consolas', monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    line-height: 18px;
    white-space: pre;
    overflow: hidden;
    border-right: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.18));
  }
  .cell:last-child { border-right: none; }

  .cell.removed { background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 80, 80, 0.18)); }
  .cell.added   { background: var(--vscode-diffEditor-insertedLineBackground, rgba(70, 200, 90, 0.14)); }
  .cell.ghost {
    background: repeating-linear-gradient(
      45deg,
      rgba(128, 128, 128, 0.1) 0px, rgba(128, 128, 128, 0.1) 2px,
      transparent 2px, transparent 8px
    );
  }

  code { display: block; }
</style>
</head>
<body>
${cards.map(renderCard).join('\n')}
<script>
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) { return; }
    const h = btn.dataset.hunk;
    vscode.postMessage({
      type:      btn.dataset.action,
      absPath:   btn.dataset.path,
      hunkIndex: h !== undefined ? parseInt(h, 10) : undefined,
    });
  });
</script>
</body>
</html>`;
}
