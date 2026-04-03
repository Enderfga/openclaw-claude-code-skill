/**
 * Council — Multi-agent collaboration engine
 *
 * Ported from three-minds and adapted to use SessionManager + ISession
 * directly (no HTTP/SSE to external services).
 *
 * Key patterns:
 * - Git worktree isolation per agent
 * - Two-phase protocol: planning round → execution rounds
 * - Consensus voting: all agents vote YES to complete
 * - Parallel execution via Promise.allSettled
 * - Engine-agnostic: agents can use Claude, Codex, or any ISession engine
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type CouncilConfig,
  type CouncilSession,
  type AgentResponse,
  type AgentPersona,
  type CouncilEvent,
  type CouncilReviewResult,
  type CouncilAcceptResult,
  type CouncilRejectResult,
  type CouncilChangedFile,
  type EngineType,
  type SessionConfig,
  type SessionInfo,
  type SendOptions,
  type SendResult,
} from './types.js';
import { parseConsensus, stripConsensusTags, hasConsensusMarker } from './consensus.js';

// Forward-declare SessionManager to avoid circular imports at the type level.
// The actual instance is injected via constructor.
interface SessionManagerLike {
  startSession(config: Partial<SessionConfig> & { name?: string }): Promise<SessionInfo>;
  sendMessage(name: string, message: string, options?: Partial<SendOptions>): Promise<SendResult>;
  stopSession(name: string): Promise<void>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000; // 30 min / agent
const MIN_TASK_LENGTH = 5;
const INTER_ROUND_DELAY_MS = 3000;
const EMPTY_RESPONSE_MAX_RETRIES = 2;
const EMPTY_RESPONSE_RETRY_DELAY_MS = 5000;
const MIN_COMPLETE_RESPONSE_LENGTH = 100;
const FOLLOWUP_MAX_RETRIES = 2;
const HISTORY_PREVIEW_CHARS = 1500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Git Utilities ──────────────────────────────────────────────────────────

function spawnAsync(
  cmd: string,
  args: string[],
  opts: { timeout?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = opts.timeout
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('spawn timeout'));
        }, opts.timeout)
      : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`));
      else resolve({ stdout, stderr });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

const VALID_AGENT_NAME = /^[a-zA-Z0-9_-]+$/;

/** Set up git worktrees — one isolated directory per agent */
async function setupWorktrees(projectDir: string, agents: AgentPersona[]): Promise<Map<string, string>> {
  const worktreeMap = new Map<string, string>();

  // Validate agent names before using them in git branch names
  for (const agent of agents) {
    if (!VALID_AGENT_NAME.test(agent.name)) {
      throw new Error(`Invalid agent name '${agent.name}': must match /^[a-zA-Z0-9_-]+$/`);
    }
  }

  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  // Ensure git repo
  const isGit = await spawnAsync('git', ['-C', projectDir, 'rev-parse', '--git-dir'], { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!isGit) {
    await spawnAsync('git', ['-C', projectDir, 'init'], { timeout: 5000 });
  }

  // Git user config
  await spawnAsync('git', ['-C', projectDir, 'config', '--local', 'user.email', 'council@openclaw'], {
    timeout: 5000,
  }).catch((err) => {
    console.error('[Council] Failed to set git user.email:', err.message);
  });
  await spawnAsync('git', ['-C', projectDir, 'config', '--local', 'user.name', 'Council'], { timeout: 5000 }).catch(
    (err) => {
      console.error('[Council] Failed to set git user.name:', err.message);
    },
  );

  // Ensure at least one commit
  const hasCommit = await spawnAsync('git', ['-C', projectDir, 'rev-parse', 'HEAD'], { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!hasCommit) {
    await spawnAsync('git', ['-C', projectDir, 'add', '-A'], { timeout: 5000 }).catch((err) => {
      console.error('[Council] Failed to git add:', err.message);
    });
    await spawnAsync('git', ['-C', projectDir, 'commit', '--allow-empty', '-m', 'council: initial'], { timeout: 5000 });
  }

  // Create worktree per agent
  for (const agent of agents) {
    const wtDir = path.join(projectDir, '.worktrees', agent.name);
    const branch = `council/${agent.name}`;

    if (fs.existsSync(wtDir)) {
      const isValid = await spawnAsync('git', ['-C', wtDir, 'rev-parse', '--git-dir'], { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (isValid) {
        // Warn: hard reset discards uncommitted changes from any previous run
        const dirty = await spawnAsync('git', ['-C', wtDir, 'status', '--porcelain'], { timeout: 5000 })
          .then((r) => r.stdout.trim().length > 0)
          .catch(() => false);
        if (dirty) {
          console.log(`[Council] WARNING: worktree ${wtDir} has uncommitted changes — discarding via hard reset`);
        }
        try {
          await spawnAsync('git', ['-C', wtDir, 'checkout', branch], { timeout: 5000 });
          await spawnAsync('git', ['-C', wtDir, 'reset', '--hard', 'HEAD'], { timeout: 5000 });
          worktreeMap.set(agent.name, wtDir);
          continue;
        } catch (err) {
          console.error(`[Council] Failed to reuse worktree ${wtDir} for branch ${branch}:`, (err as Error).message);
          // Fall through to re-create the worktree below
        }
      }
      await spawnAsync('git', ['-C', projectDir, 'worktree', 'remove', '--force', wtDir], { timeout: 5000 }).catch(
        (err) => {
          console.error(`[Council] Failed to remove worktree ${wtDir}:`, err.message);
        },
      );
    }

    await spawnAsync('git', ['-C', projectDir, 'branch', '-D', branch], { timeout: 5000 }).catch((err) => {
      console.error(`[Council] Failed to delete branch ${branch}:`, err.message);
    });
    try {
      await spawnAsync('git', ['-C', projectDir, 'worktree', 'add', wtDir, '-b', branch], { timeout: 10000 });
    } catch (err) {
      throw new Error(`Failed to create worktree for ${agent.name} at ${wtDir}: ${(err as Error).message}`);
    }

    if (!fs.existsSync(wtDir)) {
      throw new Error(`Worktree directory not created: ${wtDir}`);
    }
    worktreeMap.set(agent.name, wtDir);
  }

  // Write CLAUDE.md constraints in each worktree
  for (const agent of agents) {
    const wtDir = worktreeMap.get(agent.name);
    if (wtDir) writeWorktreeClaudeMd(wtDir, agent.name, agent.emoji, projectDir);
  }

  return worktreeMap;
}

function writeWorktreeClaudeMd(wtDir: string, agentName: string, emoji: string, projectDir: string) {
  const claudeDir = path.join(wtDir, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
  const content = `# ${emoji} ${agentName}

> This file is auto-generated by the system and takes priority over all conversation context.

## Identity

You are **${emoji} ${agentName}**.
Your working branch: \`council/${agentName}\`
Your working directory: \`${wtDir}\`

Only tasks marked \`[Claimed: council/${agentName}]\` in plan.md belong to you.

## Workspace Boundary

Only operate within \`${wtDir}\` and \`${projectDir}\`.
Never access: \`~/\`, \`/Users/\`, \`~/.openclaw/\`, or any path outside your workspace.

## Efficiency Rules

- Complete Round 1 within 2-3 minutes — planning only
- Empty projects: write the plan directly, no exploration needed
- One \`ls\` is enough — never scan repeatedly
`;
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), content);
}

// ─── Prompt Building ────────────────────────────────────────────────────────

function buildAgentPrompt(
  agent: AgentPersona,
  task: string,
  round: number,
  previousResponses: AgentResponse[],
  allAgents: AgentPersona[],
): string {
  const otherAgents = allAgents.filter((a) => a.name !== agent.name);

  // Build history with tail-first truncation (preserve reports and votes)
  let history = '';
  if (previousResponses.length > 0) {
    history = '\n\n## Previous Collaboration History\n\n';
    let currentRound = 0;
    for (const resp of previousResponses) {
      if (resp.round !== currentRound) {
        currentRound = resp.round;
        history += `### Round ${currentRound}\n\n`;
      }
      const clean = stripConsensusTags(resp.content);
      const preview = clean.length > HISTORY_PREVIEW_CHARS ? '...' + clean.slice(-HISTORY_PREVIEW_CHARS) : clean;
      history += `**${resp.agent}** (${resp.consensus ? 'YES — agree to finish' : 'NO — continue'}):\n${preview}\n\n`;
    }
  }

  if (round === 1) {
    return `# Round 1 — Planning Round

## Task
${task}

## Your Partners
${otherAgents.map((a) => `- ${a.emoji} ${a.name}`).join('\n')}
${history}
## Rules: Planning Only — No Code

This is Round 1, a **pure planning round**. All members work independently in parallel to create plan.md.

**What you must do (in order, complete quickly):**
1. \`git log --oneline -5\` to check current state
2. If the project is empty (only initial commit), **no research needed** — write the plan directly from the task description
3. If the project has existing code, quickly check the file structure in your workspace (one \`ls\` only), then write the plan
4. Create \`plan.md\` (with task checklist, phase breakdown, claim status) and merge into main
5. If another member's plan.md already exists on main, merge your improvements into it

**What you must never do:**
- Do not write any business code
- Do not repeatedly ls / glob / find to explore directories
- Do not read any files outside your workspace
- Do not spend more than 2-3 minutes on this round

## Consensus Vote

At the **end** of your response, you must vote:
- \`[CONSENSUS: NO]\` — normal for Round 1 (execution still needed after planning)
- \`[CONSENSUS: YES]\` — only if the task is extremely simple

Start writing plan.md now!`;
  }

  return `# Round ${round} — Execution Round

## Task
${task}

## Your Partners
${otherAgents.map((a) => `- ${a.emoji} ${a.name}`).join('\n')}
${history}
## Your Work

plan.md was created by all members in Round 1. Now execute according to plan:

1. **Check current state** — pull main, read plan.md, understand latest progress
2. **Claim and execute tasks** — pick unclaimed tasks from plan.md, write code, modify files, run tests
3. **Review others' work** — if other members have output, review and suggest improvements or fix directly
4. **Report results** — briefly describe what you did

## Consensus Vote

At the **end** of your response, you must vote (pick one):

- \`[CONSENSUS: YES]\` — task complete, quality meets standards, ready to finish
- \`[CONSENSUS: NO]\` — still work to do or issues to resolve

Collaboration ends **only when all members vote YES**.

Start working!`;
}

/** Resolve the path to configs/ relative to this module (works from both src/ and dist/) */
function resolveConfigPath(filename: string): string {
  // Try relative to source first, then relative to dist
  const candidates = [
    path.join(path.dirname(import.meta.url.replace('file://', '')), '..', 'configs', filename),
    path.join(path.dirname(import.meta.url.replace('file://', '')), '..', '..', 'configs', filename),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]; // fallback — will error on read
}

function buildSystemPrompt(agent: AgentPersona, allAgents: AgentPersona[], worktreePath: string): string {
  const otherAgents = allAgents.filter((a) => a.name !== agent.name);
  const otherBranches = otherAgents.map((a) => `\`council/${a.name}\``).join(', ');

  const templatePath = resolveConfigPath('council-system-prompt.md');
  const template = fs.readFileSync(templatePath, 'utf-8');

  return template
    .replace(/\{\{emoji\}\}/g, agent.emoji)
    .replace(/\{\{name\}\}/g, agent.name)
    .replace(/\{\{persona\}\}/g, agent.persona)
    .replace(/\{\{workDir\}\}/g, worktreePath)
    .replace(/\{\{otherBranches\}\}/g, otherBranches);
}

// ─── Council Engine ─────────────────────────────────────────────────────────

export class Council extends EventEmitter {
  private config: CouncilConfig;
  private manager: SessionManagerLike;
  private agentTimeoutMs: number;
  private _aborted = false;
  private _activeSessions = new Set<string>();
  private _session: CouncilSession | null = null;
  private _pendingInjection: string | null = null;

  constructor(config: CouncilConfig, manager: SessionManagerLike) {
    super();
    this.config = config;
    this.manager = manager;
    this.agentTimeoutMs = config.agentTimeoutMs || DEFAULT_AGENT_TIMEOUT_MS;
  }

  getSession(): CouncilSession | undefined {
    return this._session ?? undefined;
  }

  injectMessage(message: string): void {
    this._pendingInjection = message;
  }

  abort(): void {
    this._aborted = true;
    for (const name of this._activeSessions) {
      this.manager.stopSession(name).catch(() => {});
    }
    this._activeSessions.clear();
  }

  private emitEvent(event: Omit<CouncilEvent, 'timestamp'>) {
    const full: CouncilEvent = { ...event, timestamp: new Date().toISOString() };
    this.emit('council-event', full);
  }

  // ─── Single Agent Execution ───────────────────────────────────────────

  private async runSingleAgent(
    agent: AgentPersona,
    prompt: string,
    systemPrompt: string,
    workDir: string,
    round: number,
    sessionId: string,
  ): Promise<AgentResponse> {
    this.emitEvent({ type: 'agent-start', sessionId, round, agent: agent.name });

    const sessionName = `council-${sessionId.slice(0, 8)}-${agent.name}-r${round}`;
    this._activeSessions.add(sessionName);

    let content = '';
    try {
      for (let attempt = 0; attempt <= EMPTY_RESPONSE_MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          this.emitEvent({
            type: 'agent-chunk',
            sessionId,
            round,
            agent: agent.name,
            content: `\n[Empty response, retry ${attempt}/${EMPTY_RESPONSE_MAX_RETRIES}]\n`,
          });
          await sleep(EMPTY_RESPONSE_RETRY_DELAY_MS);
        }

        // Start a session for this agent
        const engine: EngineType = agent.engine || 'claude';
        await this.manager.startSession({
          name: sessionName,
          cwd: workDir,
          engine,
          model: agent.model,
          baseUrl: agent.baseUrl,
          permissionMode: agent.permissionMode ?? 'bypassPermissions',
          appendSystemPrompt: systemPrompt,
          maxTurns: this.config.maxTurnsPerAgent || 30,
          maxBudgetUsd: this.config.maxBudgetUsd,
        });

        // Send the prompt and wait for completion
        const result = await this.manager.sendMessage(sessionName, prompt, {
          timeout: this.agentTimeoutMs,
          onChunk: (chunk: string) => {
            this.emitEvent({ type: 'agent-chunk', sessionId, round, agent: agent.name, content: chunk });
          },
        });

        content = result.output;

        // Check if response is substantive
        const stripped = content.replace(/^\[Agent completed[^\]]*\]\s*/i, '').trim();
        if (stripped.length > 0 || hasConsensusMarker(content)) break;

        if (attempt === EMPTY_RESPONSE_MAX_RETRIES) {
          console.log(`[Council] ${agent.name}: empty after ${EMPTY_RESPONSE_MAX_RETRIES} retries`);
        }
      }

      // Follow-up if response is too short and has no consensus marker
      const strippedContent = content.replace(/^\[Agent completed[^\]]*\]\s*/i, '').trim();
      if (strippedContent.length < MIN_COMPLETE_RESPONSE_LENGTH && !hasConsensusMarker(content)) {
        for (let i = 0; i < FOLLOWUP_MAX_RETRIES; i++) {
          try {
            const followup = await this.manager.sendMessage(
              sessionName,
              'Stop all tool calls. Output your complete report now, including your consensus vote [CONSENSUS: YES] or [CONSENSUS: NO].',
              { timeout: 60_000 },
            );
            if (followup.output.trim().length > 0) {
              content = followup.output;
              if (hasConsensusMarker(content) || content.length >= MIN_COMPLETE_RESPONSE_LENGTH) break;
            }
          } catch {
            break;
          }
          await sleep(EMPTY_RESPONSE_RETRY_DELAY_MS);
        }
      }
    } finally {
      // Stop session — fire-and-forget
      this.manager.stopSession(sessionName).catch(() => {});
      this._activeSessions.delete(sessionName);
    }

    const consensus = parseConsensus(content);
    const response: AgentResponse = {
      agent: agent.name,
      round,
      content,
      consensus,
      sessionKey: sessionName,
      timestamp: new Date().toISOString(),
    };

    this.emitEvent({ type: 'agent-complete', sessionId, round, agent: agent.name, content, consensus });
    return response;
  }

  // ─── Initialisation (synchronous — returns handle immediately) ──────

  init(task: string): CouncilSession {
    if (!task || task.trim().length < MIN_TASK_LENGTH) {
      throw new Error(`Task description too short (min ${MIN_TASK_LENGTH} chars)`);
    }

    const session: CouncilSession = {
      id: randomUUID(),
      task: task.trim(),
      config: this.config,
      responses: [],
      status: 'running',
      startTime: new Date().toISOString(),
    };
    this._session = session;
    return session;
  }

  // ─── Main Orchestration Loop ──────────────────────────────────────────

  async run(): Promise<CouncilSession> {
    const session = this._session;
    if (!session) throw new Error('Council not initialised — call init() first');
    const trimmedTask = session.task;

    // Safety check: prevent council from running inside the program's own directory
    const moduleRoot = path.resolve(path.dirname(import.meta.url.replace('file://', '')), '..');
    const resolvedProjectDir = path.resolve(this.config.projectDir);
    if (resolvedProjectDir === moduleRoot || resolvedProjectDir.startsWith(moduleRoot + '/')) {
      throw new Error(
        `SAFETY: projectDir (${resolvedProjectDir}) is inside program root (${moduleRoot}). Refusing to start council.`,
      );
    }

    if (this.config.agents.length === 0) {
      throw new Error('Council requires at least one agent');
    }
    console.log(`[Council] Starting: ${this.config.agents.length} agents, max ${this.config.maxRounds} rounds`);
    console.log(`[Council] Task: ${trimmedTask}`);
    console.log(`[Council] Dir: ${this.config.projectDir}`);
    console.log(`[Council] WARNING: agents run with permissionMode=bypassPermissions for autonomous execution`);
    this.emitEvent({ type: 'session-start', sessionId: session.id, task: trimmedTask });

    // Set up git worktrees
    let worktreeMap: Map<string, string>;
    try {
      worktreeMap = await setupWorktrees(this.config.projectDir, this.config.agents);
    } catch (err) {
      session.status = 'error';
      session.endTime = new Date().toISOString();
      throw err;
    }

    console.log('[Council] Worktrees:');
    for (const [name, wtPath] of worktreeMap) {
      console.log(`  ${name}: ${wtPath}`);
    }

    try {
      for (let round = 1; round <= this.config.maxRounds; round++) {
        if (this._aborted) break;

        console.log(`\n[Council] Round ${round} (${this.config.agents.length} agents parallel)`);
        this.emitEvent({ type: 'round-start', sessionId: session.id, round });

        // Check for user injection
        const injection = this._pendingInjection;
        this._pendingInjection = null;

        // Build prompts for all agents
        const agentTasks = this.config.agents.map((agent) => {
          const workDir = worktreeMap.get(agent.name) || this.config.projectDir;
          let prompt = buildAgentPrompt(agent, trimmedTask, round, session.responses, this.config.agents);
          if (injection) {
            prompt += `\n\n## User Injection\n\n${injection}`;
          }
          const systemPrompt = buildSystemPrompt(agent, this.config.agents, workDir);
          return { agent, prompt, systemPrompt, workDir };
        });

        // Execute all agents in parallel
        const results = await Promise.allSettled(
          agentTasks.map(({ agent, prompt, systemPrompt, workDir }) =>
            this.runSingleAgent(agent, prompt, systemPrompt, workDir, round, session.id),
          ),
        );

        // Collect results
        const roundVotes: boolean[] = [];
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const agent = this.config.agents[i];
          if (result.status === 'fulfilled') {
            roundVotes.push(result.value.consensus);
            session.responses.push(result.value);
          } else {
            const errMsg = (result.reason as Error)?.message || 'Unknown error';
            console.log(`[Council] ${agent.name} failed: ${errMsg}`);
            this.emitEvent({ type: 'error', sessionId: session.id, round, agent: agent.name, error: errMsg });
            roundVotes.push(false);
            session.responses.push({
              agent: agent.name,
              round,
              content: `Error: ${errMsg}`,
              consensus: false,
              sessionKey: '',
              timestamp: new Date().toISOString(),
            });
          }
        }

        const allYes = roundVotes.length === this.config.agents.length && roundVotes.every((v) => v);
        this.emitEvent({ type: 'round-end', sessionId: session.id, round, status: allYes ? 'consensus' : 'continue' });

        if (allYes) {
          console.log(`[Council] Consensus reached at round ${round}`);
          session.status = 'awaiting_user';
          break;
        } else {
          const yesCount = roundVotes.filter((v) => v).length;
          console.log(`[Council] Votes: ${yesCount}/${this.config.agents.length} YES`);
        }

        if (round < this.config.maxRounds) {
          await sleep(INTER_ROUND_DELAY_MS);
        }
      }

      if (this._aborted) {
        session.status = 'error';
      } else if (session.status === 'running') {
        session.status = 'max_rounds';
        console.log(`[Council] Max rounds (${this.config.maxRounds}) reached`);
      }

      session.endTime = new Date().toISOString();
      session.compactContext = this.generateCompactContext(session);
      session.finalSummary = this.generateSummary(session);
      this.saveTranscript(session);

      this.emitEvent({ type: 'complete', sessionId: session.id, status: session.status });
      return session;
    } catch (err) {
      session.status = 'error';
      session.endTime = new Date().toISOString();
      this.emitEvent({ type: 'error', sessionId: session.id, error: (err as Error).message });
      throw err;
    }
  }

  // ─── Summary & Transcript ─────────────────────────────────────────────

  private generateSummary(session: CouncilSession): string {
    const maxRound = session.responses.length > 0 ? Math.max(...session.responses.map((r) => r.round)) : 0;
    const statusText =
      session.status === 'awaiting_user' || session.status === 'consensus' ? 'Consensus reached' : 'Max rounds reached';
    const lines = [
      `# Council Summary\n`,
      `- **Task**: ${session.task}`,
      `- **Status**: ${statusText}`,
      `- **Rounds**: ${maxRound}`,
      `- **Directory**: ${session.config.projectDir}\n`,
      `## Final Agent Status\n`,
    ];
    const lastResponses = session.responses.filter((r) => r.round === maxRound);
    for (const resp of lastResponses) {
      const agent = session.config.agents.find((a) => a.name === resp.agent);
      const emoji = agent?.emoji || '';
      const clean = stripConsensusTags(resp.content);
      const preview = clean.slice(0, 400) + (clean.length > 400 ? '...' : '');
      lines.push(`### ${emoji} ${resp.agent}`);
      lines.push(`- Vote: ${resp.consensus ? 'YES' : 'NO'}`);
      lines.push(`- Summary:\n${preview}\n`);
    }
    return lines.join('\n');
  }

  private generateCompactContext(session: CouncilSession): string {
    const maxRound = session.responses.length > 0 ? Math.max(...session.responses.map((r) => r.round)) : 0;
    const recent = session.responses.filter((r) => r.round >= maxRound - 1);
    const summaries = recent.map((resp) => {
      const clean = stripConsensusTags(resp.content).replace(/\s+/g, ' ').slice(0, 300);
      return `- [R${resp.round}] ${resp.agent}: ${clean}${clean.length >= 300 ? '...' : ''}`;
    });
    return [
      `Task: ${session.task}`,
      `Progress: round ${maxRound} / max ${session.config.maxRounds}`,
      `Status: ${session.status}`,
      'Latest:',
      ...summaries,
    ].join('\n');
  }

  private saveTranscript(session: CouncilSession): void {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logDir = path.join(process.env.HOME || '/tmp', '.openclaw', 'council-logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const filepath = path.join(logDir, `council-${ts}.md`);

    let content = `# Council Transcript\n\n`;
    content += `- **Time**: ${session.startTime}\n`;
    content += `- **Task**: ${session.task}\n`;
    content += `- **Status**: ${session.status}\n\n---\n\n`;

    let currentRound = 0;
    for (const resp of session.responses) {
      if (resp.round !== currentRound) {
        currentRound = resp.round;
        content += `## Round ${currentRound}\n\n`;
      }
      const agent = session.config.agents.find((a) => a.name === resp.agent);
      content += `### ${agent?.emoji || ''} ${resp.agent}\n\n${resp.content}\n\n`;
    }

    content += `---\n\n${session.finalSummary || ''}`;
    fs.writeFileSync(filepath, content);
    console.log(`[Council] Transcript saved: ${filepath}`);
  }

  // ─── Post-Processing: Review / Accept / Reject ──────────────────────────

  /**
   * Produce a structured review of the council's output.
   * Lists all changed files, branches, worktrees, plan.md status, and agent summaries.
   * Does NOT modify any state — purely informational.
   */
  async review(): Promise<CouncilReviewResult> {
    const session = this._session;
    if (!session) throw new Error('Council not initialised');
    const dir = session.config.projectDir;

    // Gather branches
    const branches = await spawnAsync('git', ['-C', dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'], {
      timeout: 5000,
    })
      .then((r) =>
        r.stdout
          .trim()
          .split('\n')
          .filter((b) => b.startsWith('council/')),
      )
      .catch(() => [] as string[]);

    // Gather worktrees
    const worktrees = await spawnAsync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { timeout: 5000 })
      .then((r) => {
        const lines = r.stdout.split('\n');
        return lines.filter((l) => l.startsWith('worktree ')).map((l) => l.replace('worktree ', '').trim());
      })
      .catch(() => [] as string[]);
    // Filter to only council worktrees (not the main worktree)
    const councilWorktrees = worktrees.filter((w) => w.includes('council') || w.includes('.worktrees'));

    // Check plan.md
    const planPath = path.join(dir, 'plan.md');
    const planExists = fs.existsSync(planPath);
    const planContent = planExists ? fs.readFileSync(planPath, 'utf-8') : undefined;

    // Check reviews/
    const reviewsDir = path.join(dir, 'reviews');
    const reviews = fs.existsSync(reviewsDir) ? fs.readdirSync(reviewsDir).filter((f) => f.endsWith('.md')) : [];

    // Diff stat: find changed files compared to initial state
    const changedFiles: CouncilChangedFile[] = [];
    try {
      // Ensure git history is available before diffing
      await spawnAsync('git', ['-C', dir, 'log', '--oneline', '--all', '-50'], { timeout: 5000 });
      // Get diff stat from recent history (rough heuristic)
      const diffResult = await spawnAsync('git', ['-C', dir, 'diff', '--stat', '--numstat', 'HEAD~20', 'HEAD', '--'], {
        timeout: 10000,
      }).catch(() => ({ stdout: '', stderr: '' }));

      if (diffResult.stdout.trim()) {
        for (const line of diffResult.stdout.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            const insertions = parseInt(parts[0], 10) || 0;
            const deletions = parseInt(parts[1], 10) || 0;
            const file = parts[2];
            if (file && !file.startsWith('-')) {
              changedFiles.push({ file, status: 'clean', insertions, deletions });
            }
          }
        }
      }

      // If no numstat, try a simpler approach
      if (changedFiles.length === 0) {
        const nameOnly = await spawnAsync('git', ['-C', dir, 'diff', '--name-only', 'HEAD~10', 'HEAD', '--'], {
          timeout: 5000,
        }).catch(() => ({ stdout: '', stderr: '' }));
        for (const file of nameOnly.stdout.trim().split('\n').filter(Boolean)) {
          changedFiles.push({ file, status: 'clean', insertions: 0, deletions: 0 });
        }
      }
    } catch {
      // Git diff failed — possibly shallow history; skip file listing
    }

    // Agent summaries from final round
    const maxRound = session.responses.length > 0 ? Math.max(...session.responses.map((r) => r.round)) : 0;
    const lastResponses = session.responses.filter((r) => r.round === maxRound);
    const agentSummaries = lastResponses.map((resp) => {
      const clean = stripConsensusTags(resp.content);
      return {
        agent: resp.agent,
        consensus: resp.consensus,
        preview: clean.slice(0, 500) + (clean.length > 500 ? '...' : ''),
      };
    });

    // Load reviewer guidance from config
    let reviewerGuidance = '';
    try {
      const guidancePath = resolveConfigPath('council-reviewer-prompt.md');
      reviewerGuidance = fs.readFileSync(guidancePath, 'utf-8');
    } catch {
      reviewerGuidance = 'Reviewer guidance not found. Evaluate the council output independently.';
    }

    return {
      councilId: session.id,
      projectDir: dir,
      status: session.status as 'consensus' | 'max_rounds' | 'error',
      rounds: maxRound,
      planExists,
      planContent,
      changedFiles,
      branches,
      worktrees: councilWorktrees,
      reviews,
      agentSummaries,
      reviewerGuidance,
    };
  }

  /**
   * Accept the council's work: clean up worktrees, branches, plan.md, and reviews/.
   * Should only be called after reviewing via `review()`.
   */
  async accept(): Promise<CouncilAcceptResult> {
    const session = this._session;
    if (!session) throw new Error('Council not initialised');
    const dir = session.config.projectDir;

    // Ensure we're on main
    await spawnAsync('git', ['-C', dir, 'checkout', 'main'], { timeout: 5000 }).catch(() =>
      spawnAsync('git', ['-C', dir, 'checkout', 'master'], { timeout: 5000 }).catch(() => {}),
    );

    // Remove council worktrees
    const worktreesRemoved: string[] = [];
    const wtListResult = await spawnAsync('git', ['-C', dir, 'worktree', 'list'], { timeout: 5000 }).catch(() => ({
      stdout: '',
      stderr: '',
    }));
    for (const line of wtListResult.stdout.split('\n')) {
      const wtPath = line.split(/\s+/)[0];
      if (wtPath && wtPath.includes('council')) {
        // Safety: never remove the project dir itself
        if (path.resolve(wtPath) === path.resolve(dir)) continue;
        await spawnAsync('git', ['-C', dir, 'worktree', 'remove', '--force', wtPath], { timeout: 10000 }).catch((err) =>
          console.error(`[Council] Failed to remove worktree ${wtPath}:`, err.message),
        );
        worktreesRemoved.push(wtPath);
      }
    }
    // Also remove .worktrees directory if it exists
    const dotWorktrees = path.join(dir, '.worktrees');
    if (fs.existsSync(dotWorktrees)) {
      // Remove any remaining worktree dirs via git first
      for (const entry of fs.readdirSync(dotWorktrees)) {
        const wtPath = path.join(dotWorktrees, entry);
        if (fs.statSync(wtPath).isDirectory()) {
          await spawnAsync('git', ['-C', dir, 'worktree', 'remove', '--force', wtPath], { timeout: 10000 }).catch(
            () => {},
          );
          if (!worktreesRemoved.includes(wtPath)) worktreesRemoved.push(wtPath);
        }
      }
      // Clean up the directory itself if empty
      try {
        fs.rmSync(dotWorktrees, { recursive: true, force: true });
      } catch {
        // May fail if not empty; that's ok
      }
    }
    await spawnAsync('git', ['-C', dir, 'worktree', 'prune'], { timeout: 5000 }).catch(() => {});

    // Delete council branches
    const branchesDeleted: string[] = [];
    const branchResult = await spawnAsync(
      'git',
      ['-C', dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
      { timeout: 5000 },
    ).catch(() => ({ stdout: '', stderr: '' }));
    for (const branch of branchResult.stdout.trim().split('\n')) {
      if (branch.startsWith('council/')) {
        await spawnAsync('git', ['-C', dir, 'branch', '-D', branch], { timeout: 5000 }).catch((err) =>
          console.error(`[Council] Failed to delete branch ${branch}:`, err.message),
        );
        branchesDeleted.push(branch);
      }
    }

    // Remove plan.md
    const planPath = path.join(dir, 'plan.md');
    const planDeleted = fs.existsSync(planPath);
    if (planDeleted) fs.unlinkSync(planPath);

    // Remove reviews/
    const reviewsDir = path.join(dir, 'reviews');
    const reviewsDeleted = fs.existsSync(reviewsDir);
    if (reviewsDeleted) fs.rmSync(reviewsDir, { recursive: true, force: true });

    // Update session status
    session.status = 'accepted';

    console.log(
      `[Council] Accepted: ${branchesDeleted.length} branches, ${worktreesRemoved.length} worktrees cleaned up`,
    );

    return { councilId: session.id, branchesDeleted, worktreesRemoved, planDeleted, reviewsDeleted };
  }

  /**
   * Reject the council's work: rewrite plan.md with feedback.
   * Does NOT delete any worktrees or branches — the council can retry.
   */
  async reject(feedback: string): Promise<CouncilRejectResult> {
    const session = this._session;
    if (!session) throw new Error('Council not initialised');
    const dir = session.config.projectDir;

    const planPath = path.join(dir, 'plan.md');

    // Build rejection plan
    const rejectionPlan = `# Project Plan (REJECTED & RESTARTED)

## Reviewer Feedback
${feedback}

## Previous Status
- **Council ID**: ${session.id}
- **Rounds completed**: ${session.responses.length > 0 ? Math.max(...session.responses.map((r) => r.round)) : 0}
- **Final status**: ${session.status}

## Tasks for Council
_Replace the tasks below with specific actionable items based on the feedback above._

- [ ] Address reviewer feedback
- [ ] Verify all changes compile and pass tests
- [ ] Update plan.md with accurate completion status
`;

    fs.writeFileSync(planPath, rejectionPlan);

    // Commit the rejection plan
    await spawnAsync('git', ['-C', dir, 'add', 'plan.md'], { timeout: 5000 }).catch(() => {});
    await spawnAsync('git', ['-C', dir, 'commit', '-m', 'council(reject): rewrite plan.md with reviewer feedback'], {
      timeout: 5000,
    }).catch(() => {});

    // Update session status
    session.status = 'rejected';

    console.log(`[Council] Rejected: plan.md rewritten with feedback`);

    return { councilId: session.id, planRewritten: true, feedback };
  }
}

// ─── Default Config ─────────────────────────────────────────────────────────

export function getDefaultCouncilConfig(projectDir: string): CouncilConfig {
  return {
    name: 'Code Council',
    agents: [
      {
        name: 'Architect',
        emoji: '🏗️',
        persona:
          'You are a system architect. You focus on code structure, design patterns, scalability, and long-term maintainability.',
      },
      {
        name: 'Engineer',
        emoji: '⚙️',
        persona:
          'You are an implementation engineer. You focus on code quality, error handling, edge cases, and performance.',
      },
      {
        name: 'Reviewer',
        emoji: '🔍',
        persona:
          'You are a code reviewer. You focus on code standards, potential bugs, security issues, and documentation.',
      },
    ],
    maxRounds: 15,
    projectDir,
  };
}
