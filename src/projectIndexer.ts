import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ProcessManager } from './processManager';

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'out', 'dist', 'build', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.tox', 'coverage', '.nyc_output',
]);

export class ProjectIndexer {
  constructor(private processManager: ProcessManager) {}

  async index(
    workspaceRoot: string,
    model: string,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    response.markdown('Scanning project files…\n\n');

    const listing = buildFileListing(workspaceRoot);
    const prompt = [
      'Generate a project-context.md file for this codebase.',
      'Include these sections: Project Overview, Tech Stack, Directory Structure (annotated),',
      'Key Files (entry points, config, main modules), Coding Conventions, Major Dependencies.',
      'Be concise. Output ONLY the markdown — no preamble, no explanation.',
      '',
      '## File listing',
      listing,
    ].join('\n');

    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());

    let fullText = '';
    let failed = false;

    await new Promise<void>((resolve) => {
      this.processManager.invoke(prompt, {
        model,
        yoloMode: false,
        workspaceRoot,
        signal: abort.signal,
        onEvent: (ev) => {
          if (ev.type === 'assistant' && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block.type === 'text' && block.text) { fullText += block.text; }
            }
          }
          if (ev.type === 'result' && ev.subtype === 'error') { failed = true; }
        },
        onError: (err) => {
          response.markdown(`**Indexing failed:** ${err.message}`);
          failed = true;
          resolve();
        },
        onDone: () => resolve(),
      });
    });

    if (failed || !fullText.trim()) {
      if (!failed) { response.markdown('**Indexing failed:** No response from Claude.'); }
      return;
    }

    const outputDir = path.join(workspaceRoot, '.claude');
    const outputPath = path.join(outputDir, 'project-context.md');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, fullText.trim() + '\n', 'utf8');

    const uri = vscode.Uri.file(outputPath);
    response.markdown(`Project indexed. [Open project-context.md](${uri.toString()})`);

    vscode.window.showInformationMessage('Claude: Project indexed.', 'Open File').then(choice => {
      if (choice === 'Open File') { vscode.window.showTextDocument(uri); }
    });
  }
}

function buildFileListing(root: string, prefix = '', depth = 0): string {
  if (depth > 3) { return ''; }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return ''; }

  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.claude') { continue; }
    if (EXCLUDED_DIRS.has(entry.name)) { continue; }
    const icon = entry.isDirectory() ? '📁' : '📄';
    lines.push(`${prefix}${icon} ${entry.name}`);
    if (entry.isDirectory()) {
      lines.push(buildFileListing(path.join(root, entry.name), prefix + '  ', depth + 1));
    }
  }
  return lines.filter(Boolean).join('\n');
}
