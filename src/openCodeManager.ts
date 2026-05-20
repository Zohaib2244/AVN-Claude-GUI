import * as vscode from 'vscode';
import * as cp from 'child_process';

export interface OpenCodeInvokeOptions {
  model: string;
  sessionId?: string;
  workspaceRoot: string;
  signal?: AbortSignal;
  onText:  (text: string) => void;
  onTool:  (name: string, input: Record<string, unknown>) => void;
  onDone:  (sessionId: string | undefined, inputTokens: number, outputTokens: number) => void;
  onError: (err: Error) => void;
}

// Loose shape for NDJSON events emitted by `opencode run --format json`
interface OCEvent {
  type?:       string;
  text?:       string;
  name?:       string;
  input?:      Record<string, unknown>;
  session_id?: string;
  tokens?:     { input?: number; output?: number; reasoning?: number };
  error?:      string;
  message?:    string;
  delta?:      { type?: string; text?: string };
  content?:    Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
}

export class OpenCodeManager implements vscode.Disposable {
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('OpenCode (Debug)');
  }

  invoke(prompt: string, opts: OpenCodeInvokeOptions): void {
    const args = ['run', '--format', 'json', '--model', opts.model];
    if (opts.sessionId) { args.push('--session', opts.sessionId); }

    this.outputChannel.appendLine(`[spawn] opencode ${args.join(' ')} "<prompt len=${prompt.length}>"`);

    let proc: cp.ChildProcess;
    try {
      // Prompt is the final positional argument — use shell:false so no escaping needed
      proc = cp.spawn('opencode', [...args, prompt], {
        cwd:   opts.workspaceRoot,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      opts.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        try { proc.kill('SIGTERM'); } catch { /* already exited */ }
      });
    }

    let buffer        = '';
    let finalSession: string | undefined;
    let inputTokens   = 0;
    let outputTokens  = 0;
    let stepDone      = false;

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try {
          const ev = JSON.parse(trimmed) as OCEvent;
          if (ev.session_id) { finalSession = ev.session_id; }
          if (ev.tokens) {
            inputTokens  = ev.tokens.input  ?? inputTokens;
            outputTokens = ev.tokens.output ?? outputTokens;
          }
          this.dispatchEvent(ev, opts);
          if (ev.type === 'step_finish' && !stepDone) {
            stepDone = true;
            opts.onDone(finalSession, inputTokens, outputTokens);
            // Force-kill after brief delay to handle the v0.15+ hang-on-exit bug
            setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }, 600);
          }
        } catch {
          // Non-JSON line — pass through as plain text (progress messages, etc.)
          if (trimmed && !trimmed.startsWith('#')) { opts.onText(trimmed + '\n'); }
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      this.outputChannel.appendLine(`[stderr] ${chunk.toString('utf8').trim()}`);
    });

    proc.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        opts.onError(new Error('ENOENT'));
      } else {
        opts.onError(err);
      }
    });

    proc.on('close', () => {
      // Flush any remaining buffered text
      if (buffer.trim()) {
        try {
          const ev = JSON.parse(buffer.trim()) as OCEvent;
          this.dispatchEvent(ev, opts);
          if (ev.session_id) { finalSession = ev.session_id; }
          if (ev.tokens) {
            inputTokens  = ev.tokens.input  ?? inputTokens;
            outputTokens = ev.tokens.output ?? outputTokens;
          }
        } catch { /* ignore */ }
      }
      if (!stepDone) { opts.onDone(finalSession, inputTokens, outputTokens); }
    });
  }

  private dispatchEvent(ev: OCEvent, opts: OpenCodeInvokeOptions): void {
    const t = ev.type;

    // Plain text chunk
    if ((t === 'text' || !t) && ev.text) { opts.onText(ev.text); return; }

    // Anthropic-style content_block_delta
    if (t === 'content_block_delta' && ev.delta?.text) { opts.onText(ev.delta.text); return; }

    // Tool use event
    if (t === 'tool_use' && ev.name) { opts.onTool(ev.name, ev.input ?? {}); return; }

    // Assistant message with content array (Claude-compat format)
    if (t === 'assistant' && Array.isArray(ev.content)) {
      for (const block of ev.content) {
        if (block.type === 'text'     && block.text) { opts.onText(block.text); }
        if (block.type === 'tool_use' && block.name) { opts.onTool(block.name, block.input ?? {}); }
      }
      return;
    }

    // Error event
    if (t === 'error') {
      opts.onText(`\n\n**Error:** ${ev.error ?? ev.message ?? 'Unknown error'}`);
    }
  }

  showOutput(): void { this.outputChannel.show(true); }

  dispose(): void { this.outputChannel.dispose(); }
}
