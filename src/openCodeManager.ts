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

// Deliberately loose — covers every known OpenCode/AI-SDK NDJSON shape
type OCEvent = Record<string, unknown> & {
  type?:       string;
  text?:       string;
  content?:    unknown;
  name?:       string;
  input?:      Record<string, unknown>;
  session_id?: string;
  sessionId?:  string;
  tokens?:     { input?: number; output?: number; reasoning?: number };
  usage?:      { input_tokens?: number; output_tokens?: number; promptTokens?: number; completionTokens?: number };
  error?:      string;
  message?:    unknown;
  delta?:      { type?: string; text?: string; textDelta?: string };
  result?:     string;
  output?:     string;
  response?:   string;
};

// All event types that signal the end of a response
const DONE_TYPES = new Set([
  'step_finish', 'message_stop', 'done', 'finish', 'complete',
  'end', 'response_complete', 'stream_end', 'StepFinish', 'MessageStop',
]);

// Regex matching a bare "provider/model-id" status line OpenCode prints before JSON
const MODEL_LINE_RE = /^[a-z0-9_-]+\/[a-z0-9._:@-]+$/i;

export class OpenCodeManager implements vscode.Disposable {
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('OpenCode (Debug)');
  }

  invoke(prompt: string, opts: OpenCodeInvokeOptions): void {
    const args = ['run', '--format', 'json', '--model', opts.model];
    if (opts.sessionId) { args.push('--session', opts.sessionId); }

    this.outputChannel.appendLine(`\n${'─'.repeat(60)}`);
    this.outputChannel.appendLine(`[spawn] opencode ${args.join(' ')}`);
    this.outputChannel.appendLine(`[prompt] ${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`);

    let proc: cp.ChildProcess;
    try {
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

    let buffer       = '';
    let finalSession: string | undefined;
    let inputTokens  = 0;
    let outputTokens = 0;
    let stepDone     = false;

    // Hard 5-min safety net so the UI never blocks forever
    const hardTimeout = setTimeout(() => {
      if (!stepDone) {
        this.outputChannel.appendLine('[timeout] No done event after 5 min — force-killing');
        stepDone = true;
        opts.onDone(finalSession, inputTokens, outputTokens);
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }, 5 * 60_000);

    const finish = () => {
      if (stepDone) { return; }
      clearTimeout(hardTimeout);
      stepDone = true;
      opts.onDone(finalSession, inputTokens, outputTokens);
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }

        // Log every raw line for debugging
        this.outputChannel.appendLine(`[raw] ${trimmed}`);

        try {
          const ev = JSON.parse(trimmed) as OCEvent;

          // Session ID (both casings)
          const sid = ev.session_id ?? ev.sessionId;
          if (typeof sid === 'string') { finalSession = sid; }

          // Token counts — handle multiple field name conventions
          if (ev.tokens) {
            inputTokens  = (ev.tokens.input  ?? inputTokens);
            outputTokens = (ev.tokens.output ?? outputTokens);
          }
          if (ev.usage) {
            inputTokens  = ((ev.usage.input_tokens   ?? ev.usage.promptTokens)     ?? inputTokens);
            outputTokens = ((ev.usage.output_tokens  ?? ev.usage.completionTokens) ?? outputTokens);
          }

          const isDone = ev.type ? DONE_TYPES.has(ev.type) : false;

          if (isDone) {
            // Some CLIs bundle the full response text in the finish event
            const resultText = ev.result ?? ev.output ?? ev.response;
            if (typeof resultText === 'string' && resultText.trim()) {
              opts.onText(resultText);
            }
            // Small delay so any last text events flush before we resolve
            setTimeout(() => {
              clearTimeout(hardTimeout);
              if (!stepDone) {
                stepDone = true;
                opts.onDone(finalSession, inputTokens, outputTokens);
              }
              setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }, 600);
            }, 150);
          } else {
            this.extractText(ev, opts);
          }

        } catch {
          // Non-JSON line — pass through as plain text, but skip model-id status lines
          // (OpenCode prints "provider/model-id" before the JSON stream starts)
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('[') && !MODEL_LINE_RE.test(trimmed)) {
            opts.onText(trimmed + '\n');
          }
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      this.outputChannel.appendLine(`[stderr] ${text}`);
    });

    proc.on('error', (err) => {
      clearTimeout(hardTimeout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        opts.onError(new Error('ENOENT'));
      } else {
        opts.onError(err);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(hardTimeout);
      this.outputChannel.appendLine(`[close] exit code ${code}`);
      if (buffer.trim()) {
        try {
          const ev = JSON.parse(buffer.trim()) as OCEvent;
          const sid = ev.session_id ?? ev.sessionId;
          if (typeof sid === 'string') { finalSession = sid; }
          this.extractText(ev, opts);
        } catch { /* ignore */ }
      }
      finish();
    });
  }

  /** Extract and forward text from any known OpenCode/AI-SDK event format. */
  private extractText(ev: OCEvent, opts: OpenCodeInvokeOptions): void {
    const t = ev.type ?? '';

    // ── Format 1: direct `text` field ──────────────────────────────────────
    if (typeof ev.text === 'string' && ev.text) { opts.onText(ev.text); return; }

    // ── Format 2: AI SDK text delta (`textDelta`) ───────────────────────────
    if (typeof ev.textDelta === 'string' && ev.textDelta) { opts.onText(ev.textDelta); return; }

    // ── Format 3: content_block_delta (Anthropic streaming) ─────────────────
    if (ev.delta) {
      const d = ev.delta as { text?: string; textDelta?: string; type?: string };
      const dText = d.text ?? d.textDelta;
      if (typeof dText === 'string' && dText) { opts.onText(dText); return; }
    }

    // ── Format 4: `content` as a plain string ───────────────────────────────
    if (typeof ev.content === 'string' && ev.content) { opts.onText(ev.content); return; }

    // ── Format 5: `content` as a block array (Anthropic-compatible) ─────────
    if (Array.isArray(ev.content)) {
      for (const block of ev.content as Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }>) {
        if (block.type === 'text'     && block.text) { opts.onText(block.text); }
        if (block.type === 'tool_use' && block.name) { opts.onTool(block.name, block.input ?? {}); }
      }
      return;
    }

    // ── Format 6: `message` wrapper (various shapes) ─────────────────────────
    if (ev.message && typeof ev.message === 'object') {
      const msg = ev.message as { content?: unknown; text?: string };
      if (typeof msg.text === 'string' && msg.text)            { opts.onText(msg.text); return; }
      if (typeof msg.content === 'string' && msg.content)      { opts.onText(msg.content); return; }
      if (Array.isArray(msg.content)) {
        for (const b of msg.content as Array<{ type?: string; text?: string }>) {
          if (b.type === 'text' && b.text) { opts.onText(b.text); }
        }
        return;
      }
    }

    // ── Format 7: tool_use ──────────────────────────────────────────────────
    if (t === 'tool_use' && typeof ev.name === 'string') {
      opts.onTool(ev.name, (ev.input ?? {}) as Record<string, unknown>); return;
    }

    // ── Format 8: error ─────────────────────────────────────────────────────
    if (t === 'error') {
      const msg = ev.error ?? ev.message;
      opts.onText(`\n\n**Error:** ${typeof msg === 'string' ? msg : 'Unknown OpenCode error'}`);
    }
  }

  showOutput(): void { this.outputChannel.show(true); }

  dispose(): void { this.outputChannel.dispose(); }
}
