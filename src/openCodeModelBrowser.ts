import * as vscode from 'vscode';
import * as cp from 'child_process';

interface OpenCodeModelInfo {
  fullId:   string;          // provider/model
  free:     boolean;         // both cost.input and cost.output are 0
  contextK: number;          // context length in k tokens (rounded)
}

/**
 * Runs `opencode models --verbose`, parses the output (mixed model-id lines +
 * JSON blobs), and shows a multi-select QuickPick. Selected items are appended
 * to `avn.openCodeModels` globally. Free models (cost = 0) are pre-checked.
 */
export async function addOpenCodeModelsFlow(): Promise<void> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const available = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Fetching OpenCode models…', cancellable: false },
    () => fetchOpenCodeModels(cwd),
  );

  if (available.length === 0) {
    // CLI not found or returned nothing — fall back to manual entry
    const manual = await vscode.window.showInputBox({
      prompt:      'Enter OpenCode model ID (opencode CLI not found or returned no models)',
      placeHolder: 'provider/model-id  (e.g. anthropic/claude-3-5-sonnet)',
      ignoreFocusOut: true,
    });
    if (manual) { await appendModels([manual.trim()]); }
    return;
  }

  const items: vscode.QuickPickItem[] = available.map(m => ({
    label:       m.fullId,
    description: m.free ? '★ free' : `${m.contextK}k ctx`,
    picked:      m.free,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title:       'OpenCode Models',
    placeHolder: 'Select models to add (★ = free, pre-selected)',
    canPickMany: true,
    ignoreFocusOut: true,
  });

  if (!picked || picked.length === 0) { return; }
  await appendModels(picked.map(p => p.label));
}

/** Append models to `avn.openCodeModels` config, deduped. */
async function appendModels(newIds: string[]): Promise<void> {
  const cfg     = vscode.workspace.getConfiguration('avn');
  const current = cfg.get<string[]>('openCodeModels', []);
  const merged  = Array.from(new Set([...current, ...newIds])).sort();
  await cfg.update('openCodeModels', merged, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Added ${newIds.length} OpenCode model${newIds.length > 1 ? 's' : ''}.`);
}

/** Spawn `opencode models --verbose` and parse the (admittedly hairy) output. */
function fetchOpenCodeModels(cwd: string | undefined): Promise<OpenCodeModelInfo[]> {
  return new Promise(resolve => {
    cp.exec('opencode models --verbose', { timeout: 20_000, cwd }, (err, stdout) => {
      if (err || !stdout) { resolve([]); return; }
      resolve(parseOpenCodeModels(stdout));
    });
  });
}

/**
 * The `opencode models --verbose` output interleaves "provider/id" lines with
 * pretty-printed JSON. Walk the lines: when we see a model-id, capture it; the
 * NEXT JSON object after it is its metadata.
 */
export function parseOpenCodeModels(raw: string): OpenCodeModelInfo[] {
  const out: OpenCodeModelInfo[] = [];
  const lines  = raw.split('\n');
  const idLine = /^[a-z0-9_-]+\/[a-z0-9._:@-]+$/i;
  let pendingId: string | undefined;
  let jsonBuf:   string | undefined;
  let depth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (jsonBuf === undefined) {
      if (idLine.test(trimmed)) {
        pendingId = trimmed;
        continue;
      }
      if (trimmed.startsWith('{')) {
        jsonBuf = trimmed;
        depth   = countChar(trimmed, '{') - countChar(trimmed, '}');
        if (depth === 0) { flush(); }
      }
    } else {
      jsonBuf += '\n' + line;
      depth += countChar(line, '{') - countChar(line, '}');
      if (depth === 0) { flush(); }
    }
  }

  function flush() {
    if (!jsonBuf || !pendingId) { jsonBuf = undefined; return; }
    try {
      const obj      = JSON.parse(jsonBuf);
      const inputC   = Number(obj?.cost?.input  ?? 0);
      const outputC  = Number(obj?.cost?.output ?? 0);
      const ctx      = Number(obj?.limit?.context ?? 0);
      out.push({
        fullId:   pendingId,
        free:     inputC === 0 && outputC === 0,
        contextK: Math.round(ctx / 1000),
      });
    } catch { /* not a model JSON, skip */ }
    pendingId = undefined;
    jsonBuf   = undefined;
  }

  return out;
}

function countChar(s: string, c: string): number {
  let n = 0;
  for (const ch of s) { if (ch === c) { n++; } }
  return n;
}
