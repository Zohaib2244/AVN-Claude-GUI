export interface ChatStream {
  markdown(text: string): void;
  progress?(toolName: string, toolInput: Record<string, unknown>): void;
  done?(stats: { inputTokens: number; outputTokens: number; model: string; effort?: string }): void;
}

export interface ClaudeStreamEvent {
  type: 'system' | 'assistant' | 'user' | 'result' | 'error';
  subtype?: string;
  session_id?: string;
  message?: {
    id: string;
    role: string;
    content: ContentBlock[];
    stop_reason?: string;
    usage?: TokenUsage;
  };
  result?: string;
  error?: string;
  usage?: TokenUsage;
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface FileEdit {
  path: string;
  content: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export type ThinkingBudget = 'low' | 'medium' | 'high' | 'max';

export interface SymbolRef {
  name: string;
  filePath: string;
  line: number;
  kind: string;
}

export const THINKING_BUDGET_TOKENS: Record<ThinkingBudget, number> = {
  low: 1024,
  medium: 4096,
  high: 10000,
  max: 32000,
};

export interface UsageRecord {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageSummary {
  sessionTokens: number;
  dailyTokens: number;
  weeklyTokens: number;
  sessionRequests: number;
}
