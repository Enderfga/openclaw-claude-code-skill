/**
 * OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Bridges OpenAI API format to persistent Claude Code sessions, enabling
 * webchat frontends (ChatGPT-Next-Web, Open WebUI, etc.) to use the plugin
 * as a drop-in backend. Stateful sessions maximize Anthropic prompt caching.
 */

import * as http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { resolveEngineAndModel } from './models.js';
import {
  OPENAI_COMPAT_DEFAULT_MODEL,
  OPENAI_COMPAT_AUTO_COMPACT_THRESHOLD,
  OPENAI_COMPAT_SESSION_PREFIX,
} from './constants.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type?: string; text?: string }> | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface OpenAIChatCompletionRequest {
  model?: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  user?: string;
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>;
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop' | 'length';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ─── Session Key Resolution ──────────────────────────────────────────────────

/**
 * Derive a session key from the request.
 * Priority: X-Session-Id header > user field > sha1(model + systemPrompt) > "default"
 *
 * The system-prompt-hash fallback prevents the bug where every caller without
 * X-Session-Id or `user` collapses onto a single shared "openai-default"
 * plugin session. In multi-caller setups (OpenClaw routing the main agent,
 * cron jobs, and subagents through the same gateway) that previously meant
 * every request serialized against every other and frequently picked up the
 * wrong session's appendSystemPrompt — also a privacy leak across callers.
 *
 * The model is mixed into the hash so that two callers with the same system
 * prompt but different requested models don't collide and silently get
 * responses from the wrong model. Originally diagnosed in PR #40 by
 * @megayounus786.
 */
export function resolveSessionKey(body: OpenAIChatCompletionRequest, headers: http.IncomingHttpHeaders): string {
  const headerKey = headers['x-session-id'];
  if (typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();
  if (body.user && body.user.trim()) return body.user.trim();
  const sys = (body.messages || [])
    .filter((m) => m && m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
  const modelTag = (body.model || '').toString();
  if (sys || modelTag) {
    return (
      'sys-' +
      createHash('sha1')
        .update(modelTag + '\n' + sys)
        .digest('hex')
        .slice(0, 12)
    );
  }
  return 'default';
}

/** Build the full session name from a key */
export function sessionNameFromKey(key: string): string {
  return `${OPENAI_COMPAT_SESSION_PREFIX}${key}`;
}

// ─── Message Extraction ──────────────────────────────────────────────────────

export interface ExtractedMessage {
  systemPrompt: string | undefined;
  userMessage: string;
  isNewConversation: boolean;
}

/**
 * Extract the relevant parts from an OpenAI messages array.
 *
 * Sessions are stateful — we only need the last user message. The tricky
 * question is whether to start a fresh session or append to the existing one.
 *
 * Default mode (no env var): only honor an explicit `X-Session-Reset: 1`
 * header. This is correct for clients that maintain their own conversation
 * transcript and forward only the latest user turn (OpenClaw main agent
 * loop, cron jobs, subagents). The previous heuristic
 * (`nonSystemMessages.length <= 1`) fired on every such request, killing the
 * persistent CLI every turn and preventing Anthropic prompt caching from
 * ever warming. Originally diagnosed in PR #40 by @megayounus786.
 *
 * Legacy mode (`OPENAI_COMPAT_NEW_CONVO_HEURISTIC=1`): restore the old
 * `system + single user ⇒ new conversation` rule, for clients that re-send
 * the full transcript on every turn (ChatGPT-Next-Web, Open WebUI, data
 * labeling tools, etc). They use the transcript shape itself as their only
 * "start a new conversation" signal.
 *
 * The env var is read on every call so ops can flip it via launchctl setenv
 * without restarting the server.
 */
export function extractUserMessage(
  messages: OpenAIChatMessage[],
  headers?: Record<string, string | string[] | undefined>,
): ExtractedMessage {
  if (!messages || messages.length === 0) {
    throw new Error('messages array is empty');
  }

  // Normalize content from any message: OpenAI API allows content as a string
  // OR an array of content parts (e.g. multimodal messages with text + images).
  // We need a string for the CLI, so arrays are joined.
  const textOf = (m: OpenAIChatMessage): string => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return (m.content as Array<{ type?: string; text?: string }>)
        .map((p) => p.text || '')
        .filter(Boolean)
        .join('');
    }
    return m.content != null ? String(m.content) : '';
  };

  // Extract system prompt if present
  const systemMessages = messages.filter((m) => m.role === 'system');
  const systemPrompt = systemMessages.length > 0 ? systemMessages.map(textOf).join('\n') : undefined;

  // Find last user message
  const userMessages = messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) {
    throw new Error('No user message found in messages array');
  }
  const userMessage = textOf(userMessages[userMessages.length - 1]);

  // 1. Explicit reset header — honored in both modes. Normalize trim+lowercase
  //    so callers using `TRUE`, ` 1 `, etc. don't silently fail.
  const rawReset = headers?.['x-session-reset'];
  const resetHeader = typeof rawReset === 'string' ? rawReset.trim().toLowerCase() : '';
  if (resetHeader === 'true' || resetHeader === '1') {
    return { systemPrompt, userMessage, isNewConversation: true };
  }

  // 2. Legacy heuristic — only when explicitly opted in via env var.
  if (process.env.OPENAI_COMPAT_NEW_CONVO_HEURISTIC === '1') {
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    return { systemPrompt, userMessage, isNewConversation: nonSystemMessages.length <= 1 };
  }

  return { systemPrompt, userMessage, isNewConversation: false };
}

// ─── Response Formatting ─────────────────────────────────────────────────────

export function formatCompletionResponse(
  id: string,
  model: string,
  text: string,
  tokensIn: number,
  tokensOut: number,
): OpenAIChatCompletionResponse {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: tokensIn,
      completion_tokens: tokensOut,
      total_tokens: tokensIn + tokensOut,
    },
  };
}

export function formatCompletionChunk(
  id: string,
  model: string,
  delta: { role?: string; content?: string },
  finishReason: string | null,
): OpenAIChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

// ─── Main Handler ────────────────────────────────────────────────────────────

/** SessionManager-like interface to avoid circular imports */
interface SessionManagerLike {
  startSession(config: Record<string, unknown>): Promise<{ name: string }>;
  sendMessage(
    name: string,
    message: string,
    options?: Record<string, unknown>,
  ): Promise<{ output: string; sessionId?: string; events: unknown[] }>;
  stopSession(name: string): Promise<void>;
  listSessions(): Array<{ name: string }>;
  getStatus(name: string): { stats: { tokensIn: number; tokensOut: number; contextPercent: number } };
  compactSession(name: string): Promise<unknown>;
}

export async function handleChatCompletion(
  manager: SessionManagerLike,
  body: Record<string, unknown>,
  headers: http.IncomingHttpHeaders,
  res: http.ServerResponse,
): Promise<void> {
  // Validate before casting
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error' },
      }),
    );
    return;
  }

  // Safe cast: messages validated above, other fields are optional
  const request: OpenAIChatCompletionRequest = {
    messages: body.messages as OpenAIChatMessage[],
    model: body.model as string | undefined,
    stream: body.stream as boolean | undefined,
    temperature: body.temperature as number | undefined,
    max_tokens: body.max_tokens as number | undefined,
    user: body.user as string | undefined,
  };

  // Validate max_tokens if provided
  if (request.max_tokens !== undefined && (typeof request.max_tokens !== 'number' || request.max_tokens <= 0)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'max_tokens must be a positive number', type: 'invalid_request_error' },
      }),
    );
    return;
  }

  const modelStr = request.model || OPENAI_COMPAT_DEFAULT_MODEL;
  const { engine, model: resolvedModel } = resolveEngineAndModel(modelStr);
  const sessionKey = resolveSessionKey(request, headers);
  const sessionName = sessionNameFromKey(sessionKey);
  const isStreaming = request.stream === true;

  let extracted: ExtractedMessage;
  try {
    extracted = extractUserMessage(request.messages, headers as Record<string, string | string[] | undefined>);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'invalid_request_error' } }));
    return;
  }

  // Check if session exists
  const existingSessions = manager.listSessions().map((s) => s.name);
  const sessionExists = existingSessions.includes(sessionName);

  // If new conversation detected and session exists, stop old one first
  if (extracted.isNewConversation && sessionExists) {
    try {
      await manager.stopSession(sessionName);
    } catch {
      /* session may have already been cleaned up */
    }
  }

  // Create session if needed
  const needsCreate = !sessionExists || extracted.isNewConversation;
  if (needsCreate) {
    const sessionConfig: Record<string, unknown> = {
      name: sessionName,
      cwd: process.cwd(),
      engine,
      model: resolvedModel,
      permissionMode: 'bypassPermissions',
      // OpenAI-compat sessions must NOT persist to disk or auto-resume from
      // disk. Reasons:
      // 1. A poisoned session (e.g. from a previous ENOENT/crash) would be
      //    auto-resumed on every server restart, producing zero output forever.
      // 2. The system prompt may change between server restarts (different
      //    caller context), and auto-resume would ignore the new prompt.
      // 3. API endpoints should be stateless across server restarts — the
      //    in-memory session is sufficient while the server is running.
      //
      // noSessionPersistence: tells the CLI not to write session state to
      //   disk (`--no-session-persistence`), so the next server restart
      //   creates a genuinely fresh session instead of resuming stale state.
      // skipPersistence: tells SessionManager not to write this session to
      //   the disk registry, so `_doStartSession` won't find a stale
      //   claudeSessionId to `--resume` from.
      noSessionPersistence: true,
      skipPersistence: true,
    };
    if (extracted.systemPrompt) {
      sessionConfig.appendSystemPrompt = extracted.systemPrompt;
    }
    try {
      await manager.startSession(sessionConfig);
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: `Failed to start session: ${(err as Error).message}`, type: 'server_error' },
        }),
      );
      return;
    }
  }

  // Auto-compact if context is getting full
  if (sessionExists && !needsCreate) {
    try {
      const status = manager.getStatus(sessionName);
      if (status.stats.contextPercent > OPENAI_COMPAT_AUTO_COMPACT_THRESHOLD) {
        await manager.compactSession(sessionName);
      }
    } catch {
      /* best effort — session may not support compact */
    }
  }

  const completionId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 29)}`;

  // Force non-streaming for the first turn of a new session. Claude CLI needs
  // 3-15 seconds to boot and process the system prompt, and many upstream
  // clients (including the OpenClaw gateway's agent loop, which uses the OpenAI
  // SDK with default timeouts) will close the streaming connection before the
  // first content chunk arrives. Non-streaming mode makes the HTTP response
  // wait until the full response is ready, which is handled correctly by the
  // SDK's non-streaming path (longer timeout, no SSE parsing).
  //
  // Subsequent turns on the same session reuse the already-running CLI process,
  // so first-token latency drops to <1s and streaming is safe.
  const forceNonStream = needsCreate;
  const useStreaming = isStreaming && !forceNonStream;

  if (useStreaming) {
    await handleStreaming(manager, sessionName, resolvedModel, extracted.userMessage, completionId, res);
  } else {
    await handleNonStreaming(manager, sessionName, resolvedModel, extracted.userMessage, completionId, res);
  }
}

// ─── Non-Streaming ───────────────────────────────────────────────────────────

async function handleNonStreaming(
  manager: SessionManagerLike,
  sessionName: string,
  model: string,
  userMessage: string,
  completionId: string,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const result = await manager.sendMessage(sessionName, userMessage);
    let tokensIn = 0;
    let tokensOut = 0;
    try {
      const status = manager.getStatus(sessionName);
      tokensIn = status.stats.tokensIn;
      tokensOut = status.stats.tokensOut;
    } catch {
      /* stats unavailable */
    }
    const response = formatCompletionResponse(completionId, model, result.output, tokensIn, tokensOut);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'server_error' } }));
  }
}

// ─── Streaming ───────────────────────────────────────────────────────────────

async function handleStreaming(
  manager: SessionManagerLike,
  sessionName: string,
  model: string,
  userMessage: string,
  completionId: string,
  res: http.ServerResponse,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let clientDisconnected = false;
  res.on('close', () => {
    clientDisconnected = true;
  });

  const writeSSE = (data: string) => {
    if (!clientDisconnected) {
      try {
        res.write(`data: ${data}\n\n`);
      } catch {
        clientDisconnected = true;
      }
    }
  };

  // Initial chunk with role
  writeSSE(JSON.stringify(formatCompletionChunk(completionId, model, { role: 'assistant' }, null)));

  // SSE keepalive heartbeat to prevent proxy/client timeouts.
  // IMPORTANT: must write a proper SSE comment (line starting with ':'),
  // NOT a 'data:' field. The OpenAI SDK JSON.parse()s every data field —
  // sending 'data: :keepalive' causes a SyntaxError that aborts the stream.
  const heartbeatTimer = setInterval(() => {
    if (!clientDisconnected) {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clientDisconnected = true;
      }
    }
  }, 30_000);

  try {
    await manager.sendMessage(sessionName, userMessage, {
      onChunk: (chunk: string) => {
        writeSSE(JSON.stringify(formatCompletionChunk(completionId, model, { content: chunk }, null)));
      },
    });

    // Get token usage for final chunk
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    try {
      const status = manager.getStatus(sessionName);
      usage = {
        prompt_tokens: status.stats.tokensIn,
        completion_tokens: status.stats.tokensOut,
        total_tokens: status.stats.tokensIn + status.stats.tokensOut,
      };
    } catch {
      /* best effort */
    }

    // Final chunk with finish_reason + usage
    const finalChunk = formatCompletionChunk(completionId, model, {}, 'stop');
    if (usage) finalChunk.usage = usage;
    writeSSE(JSON.stringify(finalChunk));
    writeSSE('[DONE]');
  } catch (err) {
    // Send error as SSE event then close
    writeSSE(JSON.stringify({ error: { message: (err as Error).message, type: 'server_error' } }));
    writeSSE('[DONE]');
  } finally {
    clearInterval(heartbeatTimer);
  }

  if (!clientDisconnected) {
    res.end();
  }
}
