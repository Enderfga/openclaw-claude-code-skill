/**
 * Shared types for openclaw-claude-code plugin
 */

// ─── Permission & Effort ─────────────────────────────────────────────────────

export type PermissionMode =
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'default'
  | 'delegate'
  | 'dontAsk'
  | 'plan'
  | 'auto';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max' | 'auto';

// ─── Session Config ──────────────────────────────────────────────────────────

export interface SessionConfig {
  name: string;
  cwd: string;
  model?: string;
  baseUrl?: string;
  permissionMode: PermissionMode;
  // Tool control
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string[];
  // Limits
  maxTurns?: number;
  maxBudgetUsd?: number;
  // System prompts
  systemPrompt?: string;
  appendSystemPrompt?: string;
  // Permissions
  dangerouslySkipPermissions?: boolean;
  // Agents
  agents?: Record<string, { description?: string; prompt: string }>;
  agent?: string;
  // Session identity
  customSessionId?: string;
  sessionName?: string;
  claudeResumeId?: string;
  forkSession?: boolean;
  // Directories
  addDir?: string[];
  // Effort & model
  effort?: EffortLevel;
  modelOverrides?: Record<string, string>;
  enableAutoMode?: boolean;
  resolvedModel?: string;
  // New CLI flags
  bare?: boolean;
  worktree?: string | boolean;
  fallbackModel?: string;
  jsonSchema?: string;
  mcpConfig?: string | string[];
  settings?: string;
  noSessionPersistence?: boolean;
  betas?: string | string[];
  enableAgentTeams?: boolean;
}

// ─── Session Stats ───────────────────────────────────────────────────────────

export interface SessionStats {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  costUsd: number;
  isReady: boolean;
  startTime: string | null;
  lastActivity: string | null;
  contextPercent: number;
}

// ─── Hook Config ─────────────────────────────────────────────────────────────

export interface HookConfig {
  onToolError?: string;
  onContextHigh?: string;
  onStop?: string;
  onTurnComplete?: string;
  onStopFailure?: string;
}

// ─── Active Session ──────────────────────────────────────────────────────────

export interface ActiveSession {
  config: SessionConfig;
  claudeSessionId?: string;
  created: string;
  stats: SessionStats;
  hooks: HookConfig;
  paused: boolean;
  busy: boolean;
  currentEffort?: EffortLevel;
}

// ─── Send Options ────────────────────────────────────────────────────────────

export interface SendOptions {
  effort?: EffortLevel;
  plan?: boolean;
  autoResume?: boolean;
  timeout?: number;
  stream?: boolean;
  onEvent?: (event: StreamEvent) => void;
}

// ─── Stream Events ───────────────────────────────────────────────────────────

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  [key: string]: unknown;
}

// ─── Results ─────────────────────────────────────────────────────────────────

export interface SessionInfo {
  name: string;
  claudeSessionId?: string;
  created: string;
  cwd: string;
  model?: string;
  paused: boolean;
  stats: SessionStats;
}

export interface SendResult {
  output: string;
  sessionId?: string;
  error?: string;
  events: StreamEvent[];
}

export interface GrepMatch {
  time: string;
  type: string;
  content: string;
}

export interface AgentInfo {
  name: string;
  file: string;
  description: string;
}

export interface SkillInfo {
  name: string;
  hasSkillMd: boolean;
  description: string;
}

export interface RuleInfo {
  name: string;
  file: string;
  description: string;
  paths: string;
  condition: string;
}

// ─── Plugin Config ───────────────────────────────────────────────────────────

export interface PluginConfig {
  claudeBin: string;
  defaultModel?: string;
  defaultPermissionMode: PermissionMode;
  defaultEffort: EffortLevel;
  maxConcurrentSessions: number;
  sessionTtlMinutes: number;
  proxy?: ProxyConfig;
}

export interface ProxyConfig {
  enabled: boolean;
  bigModel: string;
  smallModel: string;
}

// ─── Model Pricing ───────────────────────────────────────────────────────────

export interface ModelPricing {
  input: number;   // per 1M tokens
  output: number;
  cached?: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6':   { input: 15, output: 75, cached: 1.5 },
  'claude-sonnet-4-6': { input: 3,  output: 15, cached: 0.3 },
  'claude-haiku-4-5':  { input: 0.8, output: 4, cached: 0.08 },
  'gemini-2.5-pro':    { input: 1.25, output: 10, cached: 0.315 },
  'gemini-2.5-flash':  { input: 0.15, output: 0.6, cached: 0.0375 },
  'gpt-4o':            { input: 2.5, output: 10, cached: 1.25 },
};

// ─── Model Aliases ───────────────────────────────────────────────────────────

export const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-4-6',
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5',
  'gemini-flash': 'gemini-2.5-flash',
  'gemini-pro': 'gemini-2.5-pro',
};
