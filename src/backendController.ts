import * as vscode from 'vscode';
import { BackendType, ThinkingBudget, AvnMode } from './types';

const STATE_BACKEND  = 'avn.backend';
const STATE_MODEL    = 'avn.model';
const STATE_MODE     = 'avn.mode';
const STATE_THINKING = 'avn.thinking';

/**
 * Owns the user-facing knobs: which backend, which model, which mode,
 * thinking budget. Renders three status-bar items that open QuickPicks.
 */
export class BackendController implements vscode.Disposable {
  private modelItem: vscode.StatusBarItem;
  private modeItem:  vscode.StatusBarItem;
  private thinkItem: vscode.StatusBarItem;

  constructor(private context: vscode.ExtensionContext) {
    this.modelItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    this.modelItem.command = 'avn.switchModel';
    this.modelItem.show();

    this.modeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
    this.modeItem.command = 'avn.switchMode';
    this.modeItem.show();

    this.thinkItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 96);
    this.thinkItem.command = 'avn.switchThinking';

    this.render();
  }

  // ── Getters ────────────────────────────────────────────────────────────
  getBackend():  BackendType                  { return this.context.workspaceState.get(STATE_BACKEND, 'claude' as BackendType); }
  getModel():    string                       { return this.context.workspaceState.get(STATE_MODEL,    this._defaultModel()); }
  getMode():     AvnMode                      { return this.context.workspaceState.get(STATE_MODE,     'auto' as AvnMode); }
  getThinking(): ThinkingBudget | undefined   { return this.context.workspaceState.get(STATE_THINKING, undefined); }

  // ── Setters ────────────────────────────────────────────────────────────
  async setBackend(b: BackendType): Promise<void> {
    await this.context.workspaceState.update(STATE_BACKEND, b);
    // If current model isn't valid for the new backend, swap to the first available
    const models = this._modelsFor(b);
    if (!models.includes(this.getModel())) {
      await this.context.workspaceState.update(STATE_MODEL, models[0] ?? this._defaultModel());
    }
    this.render();
  }

  async setModel(model: string): Promise<void> {
    // Inferring backend from the model string: OpenCode models look like "provider/id"
    const inferred: BackendType = model.includes('/') ? 'opencode' : 'claude';
    await this.context.workspaceState.update(STATE_BACKEND, inferred);
    await this.context.workspaceState.update(STATE_MODEL,    model);
    this.render();
  }

  async setMode(m: AvnMode): Promise<void> {
    await this.context.workspaceState.update(STATE_MODE, m);
    this.render();
  }

  async setThinking(t: ThinkingBudget | undefined): Promise<void> {
    await this.context.workspaceState.update(STATE_THINKING, t);
    this.render();
  }

  // ── Lookups ────────────────────────────────────────────────────────────
  private _defaultModel(): string {
    return vscode.workspace.getConfiguration('avn').get<string>('defaultModel', 'claude-sonnet-4-6');
  }
  private _modelsFor(b: BackendType): string[] {
    const cfg = vscode.workspace.getConfiguration('avn');
    return b === 'claude'
      ? cfg.get<string[]>('claudeModels', [])
      : cfg.get<string[]>('openCodeModels', []);
  }
  modelsForActive(): string[] { return this._modelsFor(this.getBackend()); }
  supportsThinking(): boolean {
    const list = vscode.workspace.getConfiguration('avn').get<string[]>('thinkingModels', []);
    return list.includes(this.getModel());
  }

  // ── Rendering ──────────────────────────────────────────────────────────
  private render(): void {
    const m = this.getModel();
    // Shorten OpenCode "provider/model" → "provider/model" still, but readable
    this.modelItem.text    = `$(rocket) ${m}`;
    this.modelItem.tooltip = `Backend: ${this.getBackend()} — click to change model`;

    const mode  = this.getMode();
    const label = mode === 'ask' ? 'Ask before edits' : mode === 'auto' ? 'Edit automatically' : 'Plan mode';
    this.modeItem.text     = `$(law) ${label}`;
    this.modeItem.tooltip  = 'AVN mode — click to change';

    const t = this.getThinking();
    if (this.supportsThinking()) {
      this.thinkItem.text    = t ? `$(lightbulb) Thinking: ${t}` : '$(lightbulb) Thinking: off';
      this.thinkItem.tooltip = 'Extended thinking budget — click to change';
      this.thinkItem.show();
    } else {
      this.thinkItem.hide();
    }
  }

  dispose(): void {
    this.modelItem.dispose();
    this.modeItem.dispose();
    this.thinkItem.dispose();
  }
}
