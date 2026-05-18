import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { ClaudeStreamEvent, ThinkingBudget } from './types';

export interface InvokeOptions {
  model: string;
  yoloMode: boolean;
  effortLevel?: ThinkingBudget;
  sessionId?: string;
  workspaceRoot: string;
  signal?: AbortSignal;
  onEvent: (event: ClaudeStreamEvent) => void;
  onError: (err: Error) => void;
  onDone: (sessionId: string | undefined) => void;
}

export class ProcessManager implements vscode.Disposable {
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Claude Code (Debug)');
  }

  invoke(prompt: string, opts: InvokeOptions): void {
    const args = this.buildArgs(opts);

    this.outputChannel.appendLine(`[spawn] claude ${args.join(' ')}`);

    let proc: cp.ChildProcess;
    try {
      proc = cp.spawn('claude', args, {
        cwd: opts.workspaceRoot,
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      opts.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
      });
    }

    let finalSessionId: string | undefined;
    let buffer = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try {
          const event = JSON.parse(trimmed) as ClaudeStreamEvent;
          if (event.session_id) { finalSessionId = event.session_id; }
          opts.onEvent(event);
        } catch {
          this.outputChannel.appendLine(`[stdout non-json] ${trimmed}`);
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

    proc.on('close', (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim()) as ClaudeStreamEvent;
          if (event.session_id) { finalSessionId = event.session_id; }
          opts.onEvent(event);
        } catch { /* ignore */ }
      }
      this.outputChannel.appendLine(`[close] exit code ${code}`);
      opts.onDone(finalSessionId);
    });

    // Write prompt as the message content via stdin then close
    proc.stdin?.write(prompt, 'utf8');
    proc.stdin?.end();
  }

  private buildArgs(opts: InvokeOptions): string[] {
    const args: string[] = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', opts.model,
    ];

    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }

    if (opts.yoloMode) {
      args.push('--dangerously-skip-permissions');
    }

    if (opts.effortLevel !== undefined) {
      args.push('--effort', opts.effortLevel);
    }

    return args;
  }

  showOutput(): void {
    this.outputChannel.show(true);
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}

export function extractTextFromEvents(events: ClaudeStreamEvent[]): string {
  const parts: string[] = [];
  for (const ev of events) {
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text);
        }
      }
    }
    if (ev.type === 'result' && ev.result) {
      parts.push(ev.result);
    }
  }
  return parts.join('');
}

export function isAuthError(text: string): boolean {
  return /not authenticated|log in|api key|unauthorized/i.test(text);
}

export function normalizePath(p: string, workspaceRoot: string): string {
  if (path.isAbsolute(p)) { return p; }
  return path.join(workspaceRoot, p);
}
