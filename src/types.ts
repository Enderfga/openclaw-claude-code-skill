/**
 * Shared types for openclaw-claude-code plugin
 */

// ─── Permission & Effort ─────────────────────────────────────────────────────

export type PermissionMode = 'acceptEdits' | 'bypassPermissions' | 'default' | 'delegate' | 'dontAsk' | 'plan' | 'auto';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max' | 'auto';

// ─── Engine ─────────────────────────────────────────────────────────────────

export type EngineType = 'claude' | 'codex' | 'gemini' | 'cursor';

// ─── Session Config ──────────────────────────────────────────────────────────

export interface SessionConfig {
  name: string;
  cwd: string;
  engine?: EngineType;
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
  resumeSessionId?: string;
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
  /**
   * Approximate context window utilization (0-100).
   * Estimated as (tokensIn + tokensOut) / 200,000 * 100.
   * Claude Code does not expose exact context usage via the JSON protocol,
   * so this is a best-effort heuristic that may overcount on long conversations.
   */
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
  onChunk?: (chunk: string) => void;
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

// ─── Session Send Types (used by ISession) ──────────────────────────────────

export interface SessionSendOptions {
  effort?: EffortLevel;
  plan?: boolean;
  waitForComplete?: boolean;
  timeout?: number;
  callbacks?: StreamCallbacks;
}

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onToolUse?: (event: unknown) => void;
  onToolResult?: (event: unknown) => void;
}

export interface TurnResult {
  text: string;
  event: StreamEvent;
}

export interface CostBreakdown {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  pricing: { inputPer1M: number; outputPer1M: number; cachedPer1M: number | undefined };
  breakdown: { inputCost: number; cachedCost: number; outputCost: number };
  totalUsd: number;
}

// ─── ISession Interface ─────────────────────────────────────────────────────
//
// Engine-agnostic session interface. Every coding engine (Claude Code, Codex,
// Aider, …) implements this so SessionManager can orchestrate them uniformly.

export interface ISession {
  // ── Identity ────────────────────────────────────────────────────────────
  sessionId?: string;
  readonly pid?: number;

  // ── State ───────────────────────────────────────────────────────────────
  readonly isReady: boolean;
  readonly isPaused: boolean;
  readonly isBusy: boolean;

  // ── Lifecycle ───────────────────────────────────────────────────────────
  /** Initialise the engine subprocess. Engine-specific; config passed via constructor. */
  start(): Promise<this>;
  stop(): void;
  pause(): void;
  resume(): void;

  // ── Communication ───────────────────────────────────────────────────────
  send(
    message: string | unknown[],
    options?: SessionSendOptions,
  ): Promise<TurnResult | { requestId: number; sent: boolean }>;

  // ── Observability ───────────────────────────────────────────────────────
  getStats(): SessionStats & { sessionId?: string; uptime: number };
  getHistory(limit?: number): Array<{ time: string; type: string; event: unknown }>;
  getCost(): CostBreakdown;

  // ── Context Management ──────────────────────────────────────────────────
  compact(summary?: string): Promise<TurnResult | { requestId: number; sent: boolean }>;
  getEffort(): EffortLevel;
  setEffort(level: EffortLevel): void;

  // ── Model ───────────────────────────────────────────────────────────────
  resolveModel(alias: string): string;

  // ── EventEmitter ────────────────────────────────────────────────────────
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  emit(event: string, ...args: unknown[]): boolean;
  removeListener(event: string, listener: (...args: unknown[]) => void): this;
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
  /** Override or extend model pricing at runtime without a new release. */
  pricingOverrides?: Record<string, Partial<ModelPricing>>;
}

export interface ProxyConfig {
  enabled: boolean;
  bigModel: string;
  smallModel: string;
}

// ─── Model Pricing ───────────────────────────────────────────────────────────

export interface ModelPricing {
  input: number; // per 1M tokens
  output: number;
  cached?: number;
}

const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6': { input: 15, output: 75, cached: 1.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cached: 0.3 },
  'claude-haiku-4-5': { input: 0.8, output: 4, cached: 0.08 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cached: 0.315 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6, cached: 0.0375 },
  'gpt-4o': { input: 2.5, output: 10, cached: 1.25 },
  'o4-mini': { input: 1.1, output: 4.4 },
  o3: { input: 10, output: 40 },
  'codex-mini': { input: 1.5, output: 6 },
};

/** Model pricing table — mutable copy of defaults, can be overridden at runtime. */
export const MODEL_PRICING: Record<string, ModelPricing> = { ...DEFAULT_MODEL_PRICING };

/**
 * Override or extend model pricing at runtime.
 * Useful when prices change without requiring a new package release.
 * Partial overrides are merged with existing values.
 */
export function overrideModelPricing(overrides: Record<string, Partial<ModelPricing>>): void {
  for (const [model, pricing] of Object.entries(overrides)) {
    const existing = MODEL_PRICING[model];
    const input = pricing.input ?? existing?.input;
    const output = pricing.output ?? existing?.output;
    if (input === undefined || output === undefined) {
      console.warn(`[ModelPricing] Missing input/output pricing for new model '${model}', defaulting to 0`);
    }
    MODEL_PRICING[model] = {
      input: input ?? 0,
      output: output ?? 0,
      cached: pricing.cached ?? existing?.cached,
    };
  }
}

/**
 * Look up pricing for a model key. Strips common vendor prefixes before lookup.
 * Falls back to the provided defaultModel key, or 'claude-sonnet-4-6' if not found.
 */
export function getModelPricing(model?: string, defaultModel = 'claude-sonnet-4-6'): ModelPricing {
  if (!model) return MODEL_PRICING[defaultModel] ?? { input: 0, output: 0 };
  const key = model.replace(/^anthropic\/|^google\/|^openai\/|^openai-codex\/|^gemini\/|^cursor\//g, '');
  return MODEL_PRICING[key] ?? MODEL_PRICING[defaultModel] ?? { input: 0, output: 0 };
}

// ─── Model Aliases ───────────────────────────────────────────────────────────

export const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
  'gemini-flash': 'gemini-2.5-flash',
  'gemini-pro': 'gemini-2.5-pro',
};

// ─── Inbox Types ────────────────────────────────────────────────────────────

export interface InboxMessage {
  from: string;
  text: string;
  timestamp: string;
  read: boolean;
  summary?: string;
}

export interface UltraplanResult {
  id: string;
  status: 'running' | 'completed' | 'error' | 'timeout';
  plan?: string;
  sessionName: string;
  startTime: string;
  endTime?: string;
  error?: string;
}

export interface UltrareviewResult {
  id: string;
  status: 'running' | 'completed' | 'error';
  councilId: string;
  findings?: string;
  agentCount: number;
  startTime: string;
  endTime?: string;
  error?: string;
}

// ─── Council Types ──────────────────────────────────────────────────────────

export type CouncilEventType =
  | 'session-start'
  | 'round-start'
  | 'agent-start'
  | 'agent-chunk'
  | 'agent-tool'
  | 'agent-complete'
  | 'round-end'
  | 'complete'
  | 'error';

export interface CouncilEvent {
  type: CouncilEventType;
  sessionId: string;
  timestamp: string;
  round?: number;
  agent?: string;
  content?: string;
  consensus?: boolean;
  status?: string;
  task?: string;
  error?: string;
  tool?: string;
  toolInput?: string;
  toolStatus?: 'start' | 'end';
}

export interface AgentPersona {
  name: string;
  emoji: string;
  persona: string;
  engine?: EngineType;
  role?: string;
  model?: string;
  baseUrl?: string;
  permissionMode?: PermissionMode;
}

export interface CouncilConfig {
  name?: string;
  agents: AgentPersona[];
  maxRounds: number;
  projectDir: string;
  agentTimeoutMs?: number;
  maxTurnsPerAgent?: number;
  maxBudgetUsd?: number;
  defaultPermissionMode?: PermissionMode;
}

export interface AgentResponse {
  agent: string;
  round: number;
  content: string;
  consensus: boolean;
  sessionKey: string;
  timestamp: string;
}

export interface CouncilSession {
  id: string;
  task: string;
  config: CouncilConfig;
  responses: AgentResponse[];
  status: 'running' | 'consensus' | 'awaiting_user' | 'max_rounds' | 'error' | 'accepted' | 'rejected';
  startTime: string;
  endTime?: string;
  finalSummary?: string;
  compactContext?: string;
}

// ─── Council Post-Processing Types ─────────────────────────────────────────

export type CouncilFileStatus = 'clean' | 'needs_rework' | 'redundant' | 'missing';

export interface CouncilChangedFile {
  file: string;
  status: CouncilFileStatus;
  insertions: number;
  deletions: number;
  note?: string;
}

export interface CouncilReviewResult {
  councilId: string;
  projectDir: string;
  status: 'consensus' | 'max_rounds' | 'error';
  rounds: number;
  planExists: boolean;
  planContent?: string;
  changedFiles: CouncilChangedFile[];
  branches: string[];
  worktrees: string[];
  reviews: string[];
  agentSummaries: Array<{ agent: string; consensus: boolean; preview: string }>;
  /** Reviewer guidance loaded from configs/council-reviewer-prompt.md */
  reviewerGuidance: string;
}

export interface CouncilAcceptResult {
  councilId: string;
  branchesDeleted: string[];
  worktreesRemoved: string[];
  planDeleted: boolean;
  reviewsDeleted: boolean;
}

export interface CouncilRejectResult {
  councilId: string;
  planRewritten: boolean;
  feedback: string;
}
