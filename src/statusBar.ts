import * as vscode from 'vscode';

export type AvnStatus = 'idle' | 'thinking' | 'error';

/** Minimal status item — shows AVN state + a spinner during work. */
export class StatusBarManager implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private frames = ['⟳', '↻', '↺', '⟲'];
  private idx = 0;
  private timer: NodeJS.Timeout | undefined;
  private status: AvnStatus = 'idle';

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.show();
    this.render();
  }

  setStatus(s: AvnStatus): void {
    this.status = s;
    if (s === 'thinking') { this.start(); } else { this.stop(); }
    this.render();
  }

  private start(): void {
    if (this.timer) { return; }
    this.timer = setInterval(() => {
      this.idx = (this.idx + 1) % this.frames.length;
      this.render();
    }, 150);
  }

  private stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.idx = 0;
  }

  private render(): void {
    switch (this.status) {
      case 'idle':
        this.item.text    = '● AVN';
        this.item.color   = undefined;
        this.item.tooltip = 'AVN — idle';
        break;
      case 'thinking':
        this.item.text    = `${this.frames[this.idx]} AVN`;
        this.item.tooltip = 'AVN — thinking…';
        break;
      case 'error':
        this.item.text    = '✕ AVN';
        this.item.color   = new vscode.ThemeColor('statusBarItem.errorForeground');
        this.item.tooltip = 'AVN — last request errored';
        break;
    }
  }

  dispose(): void { this.stop(); this.item.dispose(); }
}
