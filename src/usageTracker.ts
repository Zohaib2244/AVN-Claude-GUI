import * as vscode from 'vscode';
import { UsageRecord, UsageSummary } from './types';

const STORAGE_KEY = 'claude.usageRecords';
const SESSION_START_KEY = 'claude.sessionStart';
const SESSION_REQUESTS_KEY = 'claude.sessionRequests';

export class UsageTracker {
  private context: vscode.ExtensionContext;
  private sessionStart: number;
  private sessionRequests: number;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.sessionStart = Date.now();
    this.sessionRequests = 0;
    this.pruneOldRecords();
  }

  record(inputTokens: number, outputTokens: number): void {
    const records = this.getRecords();
    records.push({ timestamp: Date.now(), inputTokens, outputTokens });
    this.context.globalState.update(STORAGE_KEY, records);
    this.sessionRequests++;
  }

  getSummary(): UsageSummary {
    const records = this.getRecords();
    const now = Date.now();
    const oneDayMs = 86_400_000;
    const oneWeekMs = 7 * oneDayMs;

    let sessionTokens = 0;
    let dailyTokens = 0;
    let weeklyTokens = 0;

    for (const r of records) {
      const total = r.inputTokens + r.outputTokens;
      if (r.timestamp >= this.sessionStart) { sessionTokens += total; }
      if (r.timestamp >= now - oneDayMs)  { dailyTokens  += total; }
      if (r.timestamp >= now - oneWeekMs) { weeklyTokens += total; }
    }

    return {
      sessionTokens,
      dailyTokens,
      weeklyTokens,
      sessionRequests: this.sessionRequests,
    };
  }

  formatSummaryText(): string {
    const s = this.getSummary();
    const config = vscode.workspace.getConfiguration('claude');
    const limit: number = config.get('dailyTokenLimit', 0);
    const lines = [
      `Session tokens:  ${fmt(s.sessionTokens)}`,
      `Daily tokens:    ${fmt(s.dailyTokens)}${limit ? ` / ${fmt(limit)} (${pct(s.dailyTokens, limit)}%)` : ''}`,
      `Weekly tokens:   ${fmt(s.weeklyTokens)}`,
      `Session requests: ${s.sessionRequests}`,
    ];
    return lines.join('\n');
  }

  dailyTokens(): number {
    return this.getSummary().dailyTokens;
  }

  limitPercent(): number {
    const config = vscode.workspace.getConfiguration('claude');
    const limit: number = config.get('dailyTokenLimit', 0);
    if (!limit) { return 0; }
    return Math.round((this.dailyTokens() / limit) * 100);
  }

  private getRecords(): UsageRecord[] {
    return this.context.globalState.get<UsageRecord[]>(STORAGE_KEY, []);
  }

  private pruneOldRecords(): void {
    const cutoff = Date.now() - 7 * 86_400_000;
    const records = this.getRecords().filter(r => r.timestamp >= cutoff);
    this.context.globalState.update(STORAGE_KEY, records);
  }
}

function fmt(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000)     { return `${(n / 1_000).toFixed(1)}k`; }
  return String(n);
}

function pct(used: number, limit: number): number {
  return Math.round((used / limit) * 100);
}
