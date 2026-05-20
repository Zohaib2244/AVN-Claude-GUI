import * as vscode from 'vscode';
import { UsageTracker } from './usageTracker';

export type ClaudeStatus = 'idle' | 'thinking' | 'error';

export class StatusBarManager implements vscode.Disposable {
  private statusItem: vscode.StatusBarItem;
  private tokenItem:  vscode.StatusBarItem;
  private spinnerFrames = ['⟳', '↻', '↺', '⟲'];
  private spinnerIndex  = 0;
  private spinnerTimer: NodeJS.Timeout | undefined;
  private status: ClaudeStatus = 'idle';
  private usageTracker: UsageTracker;
  private hasWarnedLimit = false;

  constructor(usageTracker: UsageTracker) {
    this.usageTracker = usageTracker;

    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = 'claude.showOutput';
    this.statusItem.show();

    this.tokenItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.tokenItem.command = 'claude.showUsage';
    this.tokenItem.show();

    this.render();
  }

  setStatus(status: ClaudeStatus): void {
    this.status = status;
    if (status === 'thinking') { this.startSpinner(); } else { this.stopSpinner(); }
    this.render();
  }

  refreshTokens(): void {
    const pct = this.usageTracker.limitPercent();
    if (pct >= 90 && !this.hasWarnedLimit) {
      this.hasWarnedLimit = true;
      vscode.window.showWarningMessage(`Claude: Daily token usage is at ${pct}% of your configured limit.`);
    }
    this.render();
  }

  /** Kept for call-site compatibility — model/yolo/budget now live in the webview footer. */
  setModel(_model: string): void {}
  setYolo(_enabled: boolean): void {}
  setBudget(_budget: string | undefined): void {}

  private startSpinner(): void {
    if (this.spinnerTimer) { return; }
    this.spinnerTimer = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
      this.renderStatus();
    }, 150);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) { clearInterval(this.spinnerTimer); this.spinnerTimer = undefined; }
    this.spinnerIndex = 0;
  }

  private renderStatus(): void {
    switch (this.status) {
      case 'idle':
        this.statusItem.text    = '● Claude';
        this.statusItem.color   = undefined;
        this.statusItem.tooltip = 'Claude — click to view debug output';
        break;
      case 'thinking':
        this.statusItem.text    = `${this.spinnerFrames[this.spinnerIndex]} Claude`;
        this.statusItem.color   = undefined;
        this.statusItem.tooltip = 'Claude is thinking…';
        break;
      case 'error':
        this.statusItem.text    = '✕ Claude';
        this.statusItem.color   = new vscode.ThemeColor('statusBarItem.errorForeground');
        this.statusItem.tooltip = 'Claude — error (click for details)';
        break;
    }
  }

  private render(): void {
    this.renderStatus();
    const daily = this.usageTracker.dailyTokens();
    const pct   = this.usageTracker.limitPercent();
    const config = vscode.workspace.getConfiguration('claude');
    const limit: number = config.get('dailyTokenLimit', 0);

    let text = formatTokens(daily);
    if (limit > 0) { text += ` / ${formatTokens(limit)}`; }

    if (pct >= 90) {
      text = `⚠ ${text}`;
      this.tokenItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.tokenItem.color           = new vscode.ThemeColor('statusBarItem.warningForeground');
    } else {
      this.tokenItem.backgroundColor = undefined;
      this.tokenItem.color           = undefined;
    }

    this.tokenItem.text    = text;
    this.tokenItem.tooltip = limit > 0
      ? `Daily usage: ${pct}% of ${formatTokens(limit)} limit — click for details`
      : 'Daily token usage — click for details';
  }

  dispose(): void {
    this.stopSpinner();
    this.statusItem.dispose();
    this.tokenItem.dispose();
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M tok`; }
  if (n >= 1_000)     { return `${(n / 1_000).toFixed(1)}k tok`; }
  return `${n} tok`;
}
