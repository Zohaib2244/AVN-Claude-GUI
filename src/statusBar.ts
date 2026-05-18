import * as vscode from 'vscode';
import { UsageTracker } from './usageTracker';

export type ClaudeStatus = 'idle' | 'thinking' | 'error';

export class StatusBarManager implements vscode.Disposable {
  private statusItem: vscode.StatusBarItem;
  private yoloItem: vscode.StatusBarItem;
  private tokenItem: vscode.StatusBarItem;
  private spinnerFrames = ['⟳', '↻', '↺', '⟲'];
  private spinnerIndex = 0;
  private spinnerTimer: NodeJS.Timeout | undefined;
  private status: ClaudeStatus = 'idle';
  private yoloEnabled = false;
  private usageTracker: UsageTracker;

  constructor(usageTracker: UsageTracker) {
    this.usageTracker = usageTracker;

    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = 'claude.showOutput';
    this.statusItem.show();

    this.yoloItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this.yoloItem.command = 'claude.toggleYolo';

    this.tokenItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.tokenItem.command = 'claude.showUsage';
    this.tokenItem.show();

    this.render();
  }

  setStatus(status: ClaudeStatus): void {
    this.status = status;
    if (status === 'thinking') {
      this.startSpinner();
    } else {
      this.stopSpinner();
    }
    this.render();
  }

  setYolo(enabled: boolean): void {
    this.yoloEnabled = enabled;
    this.render();
  }

  refreshTokens(): void {
    this.render();
  }

  private startSpinner(): void {
    if (this.spinnerTimer) { return; }
    this.spinnerTimer = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;
      this.renderStatus();
    }, 150);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
    this.spinnerIndex = 0;
  }

  private renderStatus(): void {
    switch (this.status) {
      case 'idle':
        this.statusItem.text = '● Claude';
        this.statusItem.color = undefined;
        this.statusItem.tooltip = 'Claude — click to view debug output';
        break;
      case 'thinking':
        this.statusItem.text = `${this.spinnerFrames[this.spinnerIndex]} Claude`;
        this.statusItem.color = undefined;
        this.statusItem.tooltip = 'Claude is thinking…';
        break;
      case 'error':
        this.statusItem.text = '✕ Claude';
        this.statusItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
        this.statusItem.tooltip = 'Claude — error (click for details)';
        break;
    }
  }

  private render(): void {
    this.renderStatus();

    if (this.yoloEnabled) {
      this.yoloItem.text = '⚡ YOLO';
      this.yoloItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      this.yoloItem.tooltip = 'YOLO Mode ON — Claude skips confirmations. Click to disable.';
      this.yoloItem.show();
    } else {
      this.yoloItem.hide();
    }

    const daily = this.usageTracker.dailyTokens();
    this.tokenItem.text = daily > 0 ? formatTokens(daily) : '0 tokens';
    this.tokenItem.tooltip = 'Daily token usage — click for details';
  }

  dispose(): void {
    this.stopSpinner();
    this.statusItem.dispose();
    this.yoloItem.dispose();
    this.tokenItem.dispose();
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M tokens`; }
  if (n >= 1_000)     { return `${(n / 1_000).toFixed(1)}k tokens`; }
  return `${n} tokens`;
}
