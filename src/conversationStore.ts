import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

interface PersistedSession {
  sessionId: string;
  model: string;
  savedAt: number;
}

export class ConversationStore {
  private storageDir: string;

  constructor(context: vscode.ExtensionContext) {
    this.storageDir = context.globalStorageUri.fsPath;
  }

  save(workspaceRoot: string, sessionId: string, model: string): void {
    const filePath = this.getPath(workspaceRoot);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const data: PersistedSession = { sessionId, model, savedAt: Date.now() };
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
  }

  load(workspaceRoot: string): PersistedSession | undefined {
    try {
      const raw = fs.readFileSync(this.getPath(workspaceRoot), 'utf8');
      return JSON.parse(raw) as PersistedSession;
    } catch {
      return undefined;
    }
  }

  clear(workspaceRoot: string): void {
    try { fs.unlinkSync(this.getPath(workspaceRoot)); } catch { /* already absent */ }
  }

  private getPath(workspaceRoot: string): string {
    const hash = crypto.createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 12);
    return path.join(this.storageDir, 'conversations', `${hash}.json`);
  }
}
