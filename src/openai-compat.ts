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
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAIChatCompletionRequest {
  model?: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  user?: string;
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
 * The system-prompt-hash fallback is important: without it, every caller that
 * does not set X-Session-Id or `user` collapses onto a single shared
 * "openai-default" session. In multi-caller setups (e.g. OpenClaw routing
 * the main agent, cron jobs, and subagents through the same gateway) that
 * means every request serializes against every other and frequently picks
 * up the wrong session's appendSystemPrompt.
 *
 * The model is mixed into the hash so that two callers with the same system
 * prompt but different requested models don't collide onto one session and
 * silently get responses from the wrong model.
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
    return 'sys-' + createHash('sha1').update(modelTag + '\n' + sys).digest('hex').slice(0, 12);
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
 * Since sessions are stateful, we only need the last user message.
 * A "new conversation" is detected when the array is short (system + user only),
 * or when the x-session-reset header is set.
 */
export function extractUserMessage(
  messages: OpenAIChatMessage[],
  headers?: Record<string, string | string[] | undefined>,
): ExtractedMessage {
  if (!messages || messages.length === 0) {
    throw new Error('messages array is empty');
  }

  // Extract system prompt if present
  const systemMessages = messages.filter((m) => m.role === 'system');
  const systemPrompt = systemMessages.length > 0 ? systemMessages.map((m) => m.content).join('\n') : undefined;

  // Find last user message
  const userMessages = messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) {
    throw new Error('No user message found in messages array');
  }
  const userMessage = userMessages[userMessages.length - 1].content;

  // Detect new conversation: only honor an explicit reset header.
  //
  // The previous heuristic — `nonSystemMessages.length <= 1` — assumed the
  // upstream client forwards the full transcript on every turn (the way
  // ChatGPT-Next-Web / Open WebUI do). But many clients (notably OpenClaw's
  // main agent loop) maintain their own conversation state and only forward
  // the latest user turn. For those clients the heuristic fired on every
  // request, causing stopSession + startSession every turn, destroying the
  // persistent CLI and forcing a cold start each time — the exact opposite
  // of what this bridge exists for. Anthropic prompt caching never warmed.
  //
  // Clients that genuinely want to start a new conversation can set
  // `X-Session-Reset: 1` (or use a different X-Session-Id / user value).
  const resetHeader = headers?.['x-session-reset'];
  const isNewConversation = resetHeader === 'true' || resetHeader === '1';

  return { systemPrompt, userMessage, isNewConversation };
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

  if (isStreaming) {
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

  // SSE keepalive heartbeat to prevent proxy/client timeouts
  const heartbeatTimer = setInterval(() => {
    writeSSE(':keepalive');
  }, 15_000);

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
