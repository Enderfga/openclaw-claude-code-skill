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
        await spawnAsync('git', ['-C', wtDir, 'checkout', branch], { timeout: 5000 }).catch((err) => {
          console.error(`[Council] Failed to checkout branch ${branch} in ${wtDir}:`, err.message);
        });
        await spawnAsync('git', ['-C', wtDir, 'reset', '--hard', 'HEAD'], { timeout: 5000 }).catch((err) => {
          console.error(`[Council] Failed to hard reset in ${wtDir}:`, err.message);
        });
        worktreeMap.set(agent.name, wtDir);
        continue;
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
    await spawnAsync('git', ['-C', projectDir, 'worktree', 'add', wtDir, '-b', branch], { timeout: 5000 });

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

> 本文件由系统自动生成，优先级高于所有对话上下文。

## 身份

你是 **${emoji} ${agentName}**。
你的工作分支：\`council/${agentName}\`
你的工作目录：\`${wtDir}\`

plan.md 中标注 \`[Claimed: council/${agentName}]\` 的任务才属于你。

## 工作区边界

只在 \`${wtDir}\` 和 \`${projectDir}\` 内操作。
禁止访问：\`~/\`、\`/Users/\`、\`~/.openclaw/\` 等工作区外路径。

## 效率规范

- 第一轮在 2-3 分钟内完成，只做规划
- 空项目直接写 plan，不需要探索
- \`ls\` 一次即可，禁止反复扫描
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
    history = '\n\n## 之前的协作记录\n\n';
    let currentRound = 0;
    for (const resp of previousResponses) {
      if (resp.round !== currentRound) {
        currentRound = resp.round;
        history += `### 第 ${currentRound} 轮\n\n`;
      }
      const clean = stripConsensusTags(resp.content);
      const preview = clean.length > HISTORY_PREVIEW_CHARS ? '...' + clean.slice(-HISTORY_PREVIEW_CHARS) : clean;
      history += `**${resp.agent}** (${resp.consensus ? '✅同意结束' : '❌继续'}):\n${preview}\n\n`;
    }
  }

  if (round === 1) {
    return `# 第 1 轮 — 规划轮（Plan Round）

## 任务
${task}

## 你的伙伴
${otherAgents.map((a) => `- ${a.emoji} ${a.name}`).join('\n')}
${history}
## ⚠️ 本轮规则：只做规划，不写代码

这是第一轮，**纯规划轮**。所有成员同时独立工作，制定各自的 plan.md。

**你必须做的（按顺序，快速完成）：**
1. \`git log --oneline -5\` 看当前状态
2. 如果项目是空的（只有 initial commit），**不需要调研**，直接根据任务描述写 plan
3. 如果项目已有代码，快速看一下工作区内的文件结构（仅 \`ls\` 一次），然后写 plan
4. 创建 \`plan.md\`（含任务清单、阶段划分、认领状态）并合入 main
5. 如果 main 上已有其他成员的 plan.md，合并你的改进

**你绝对不能做的：**
- ❌ 不要写任何业务代码
- ❌ 不要反复 ls / glob / find 探索目录
- ❌ 不要读工作区外的任何文件
- ❌ 不要花超过 2-3 分钟在这一轮

## 共识投票

在回复**末尾**，必须投票：
- \`[CONSENSUS: NO]\` - 正常第一轮投 NO（规划完成后还需执行）
- \`[CONSENSUS: YES]\` - 仅当任务极其简单时

直接开始写 plan.md！`;
  }

  return `# 第 ${round} 轮协作（执行轮）

## 任务
${task}

## 你的伙伴
${otherAgents.map((a) => `- ${a.emoji} ${a.name}`).join('\n')}
${history}
## 你的工作

plan.md 已在第一轮由所有成员共同制定完毕。现在按计划执行：

1. **查看当前状态** - 拉取 main，读取 plan.md，了解最新进度
2. **认领并执行任务** - 从 plan.md 中选取未被认领的任务，编写代码、修改文件、运行测试
3. **审核他人工作** - 如果其他成员已有产出，审核并提出建议或直接改进
4. **汇报成果** - 简要说明你做了什么

## 共识投票

在回复**末尾**，必须投票（二选一）：

- \`[CONSENSUS: YES]\` - 任务完成，质量达标，可以结束
- \`[CONSENSUS: NO]\` - 还有工作要做或问题要解决

只有**所有人都投 YES** 时协作才会结束。

开始工作吧！`;
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
