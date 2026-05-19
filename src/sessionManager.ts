import * as vscode from 'vscode';

export interface ChatSession {
  id: string;
  name: string;
  claudeSessionId: string | undefined;
  model: string;
  mode: 'agent' | 'plan';
  createdAt: number;
  updatedAt: number;
  preview: string;
}

export class SessionManager {
  private static readonly SK = 'avnchat.sessions.';
  private static readonly AK = 'avnchat.active.';

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private sk(root: string): string { return SessionManager.SK + this.rk(root); }
  private ak(root: string): string { return SessionManager.AK + this.rk(root); }
  private rk(root: string): string {
    let h = 0;
    for (let i = 0; i < root.length; i++) { h = (h * 31 + root.charCodeAt(i)) >>> 0; }
    return h.toString(36);
  }

  list(root: string): ChatSession[] {
    return this.ctx.workspaceState.get<ChatSession[]>(this.sk(root), []);
  }

  private write(root: string, sessions: ChatSession[]): void {
    this.ctx.workspaceState.update(this.sk(root), sessions);
  }

  activeId(root: string): string | undefined {
    return this.ctx.workspaceState.get<string>(this.ak(root));
  }

  active(root: string): ChatSession | undefined {
    const id = this.activeId(root);
    return id ? this.list(root).find(s => s.id === id) : undefined;
  }

  setActive(root: string, id: string): void {
    this.ctx.workspaceState.update(this.ak(root), id);
  }

  create(root: string, name?: string, model = 'claude-sonnet-4-6', mode: 'agent' | 'plan' = 'agent'): ChatSession {
    const all = this.list(root);
    const id  = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const session: ChatSession = {
      id,
      name:            name ?? `Chat ${all.length + 1}`,
      claudeSessionId: undefined,
      model,
      mode,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      preview:   '',
    };
    this.write(root, [session, ...all]);
    this.setActive(root, id);
    return session;
  }

  update(root: string, id: string, patch: Partial<ChatSession>): void {
    const all = this.list(root).map(s =>
      s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s
    );
    // Keep most-recently-updated at the top
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    this.write(root, all);
  }

  rename(root: string, id: string, name: string): void {
    this.update(root, id, { name });
  }

  delete(root: string, id: string): string | undefined {
    const kept = this.list(root).filter(s => s.id !== id);
    this.write(root, kept);
    if (this.activeId(root) === id) {
      const next = kept[0]?.id;
      this.ctx.workspaceState.update(this.ak(root), next);
      return next;
    }
    return this.activeId(root);
  }

  /** Return the active session, creating a default one if none exist yet. */
  ensureActive(root: string, model: string, mode: 'agent' | 'plan'): ChatSession {
    return this.active(root) ?? this.create(root, 'New Chat', model, mode);
  }
}
