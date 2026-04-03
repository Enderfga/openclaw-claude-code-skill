/**
 * Proxy HTTP Handler — registerHttpRoute handler for OpenClaw Plugin SDK
 *
 * Receives Anthropic-format requests from Claude Code CLI,
 * translates to OpenAI format, forwards to the target provider,
 * and translates the response back to Anthropic format.
 *
 * Supports:
 * - Direct Anthropic API passthrough (zero conversion)
 * - OpenAI/GPT models via format conversion
 * - Gemini models via format conversion + schema cleaning
 * - Gateway passthrough (OpenClaw gateway handles routing)
 * - Streaming and non-streaming modes
 */

import {
  convertAnthropicToOpenAI,
  convertOpenAIToAnthropic,
  convertStreamOpenAIToAnthropic,
  type AnthropicRequest,
  type OpenAIResponse,
} from './anthropic-adapter.js';
import { injectThoughtSigs } from './thought-cache.js';
import type { ProxyConfig } from '../types.js';

const FETCH_TIMEOUT_MS = 120_000; // 2 minutes

/** Create an AbortSignal that fires after the given timeout */
function fetchSignal(ms = FETCH_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProxyEnv {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  gatewayUrl?: string;
  gatewayKey?: string;
}

interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  // read body as JSON
  json(): Promise<unknown>;
}

interface HttpResponse {
  status(code: number): HttpResponse;
  json(data: unknown): void;
  setHeader(key: string, value: string): void;
  write(data: string): void;
  end(): void;
  flushHeaders?(): void;
}

// ─── Model Routing ───────────────────────────────────────────────────────────

function resolveProviderModel(model: string): { provider: string; apiModel: string } {
  const lower = model.toLowerCase();

  // Strip prefixes
  let clean = model;
  for (const prefix of ['anthropic/', 'openai/', 'gemini/', 'google/']) {
    if (clean.startsWith(prefix)) {
      clean = clean.slice(prefix.length);
      break;
    }
  }

  if (lower.includes('claude') || lower.includes('opus') || lower.includes('sonnet') || lower.includes('haiku')) {
    return { provider: 'anthropic', apiModel: clean };
  }
  if (lower.includes('gemini')) {
    return { provider: 'gemini', apiModel: clean };
  }
  if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3')) {
    return { provider: 'openai', apiModel: clean };
  }

  // Default: treat as OpenAI-compatible
  return { provider: 'openai', apiModel: clean };
}

// ─── Extract Real Model from URL ─────────────────────────────────────────────

/**
 * Claude Code CLI passes the real model via URL path:
 *   /v1/claude-code-proxy/real/<model>/messages
 *
 * Extract the model name from the URL.
 */
function extractRealModel(url: string): string | null {
  const match = url.match(/\/real\/(.+?)\/messages/);
  return match ? decodeURIComponent(match[1]) : null;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export function createProxyHandler(config: ProxyConfig | undefined, env: ProxyEnv) {
  /**
   * Main proxy handler — receives Anthropic-format request, returns Anthropic-format response.
   */
  return async function handleProxy(req: HttpRequest, res: HttpResponse): Promise<boolean> {
    try {
      const body = (await req.json()) as AnthropicRequest;

      // Determine real model from URL path or request body
      const urlModel = extractRealModel(req.url);
      const requestModel = urlModel || body.model;
      body.model = requestModel;

      const { provider, apiModel } = resolveProviderModel(requestModel);
      const isStream = body.stream ?? false;

      // ─── Direct Anthropic passthrough ─────────────────────────────

      if (provider === 'anthropic') {
        return await forwardToAnthropic(body, env, res, isStream);
      }

      // ─── Gateway passthrough ──────────────────────────────────────

      if (env.gatewayUrl && env.gatewayKey) {
        return await forwardToGateway(body, apiModel, env, res, isStream, requestModel);
      }

      // ─── Direct provider via format conversion ────────────────────

      const openaiReq = convertAnthropicToOpenAI(body);
      openaiReq.model = apiModel;

      // Inject thought signatures for Gemini round-trip
      if (provider === 'gemini') {
        injectThoughtSigs(openaiReq.messages as unknown as Array<Record<string, unknown>>);
      }

      // Determine API endpoint and key
      let apiUrl: string;
      let apiKey: string;
      if (provider === 'gemini') {
        apiUrl = 'https://generativelanguage.googleapis.com/v1beta/chat/completions';
        apiKey = env.geminiApiKey || '';
      } else {
        apiUrl = 'https://api.openai.com/v1/chat/completions';
        apiKey = env.openaiApiKey || '';
      }

      if (!apiKey) {
        res.status(401).json({ error: `No API key configured for provider: ${provider}` });
        return true;
      }

      if (isStream) {
        return await handleStreamingResponse(apiUrl, apiKey, openaiReq, res, requestModel);
      } else {
        return await handleNonStreamingResponse(apiUrl, apiKey, openaiReq, res, requestModel);
      }
    } catch (err) {
      console.error('[proxy] Error:', (err as Error).message);
      const message = (err as Error).name === 'TimeoutError' ? 'Upstream request timed out' : 'Internal proxy error';
      res.status(500).json({
        type: 'error',
        error: { type: 'server_error', message },
      });
      return true;
    }
  };
}

// ─── Anthropic Passthrough ───────────────────────────────────────────────────

async function forwardToAnthropic(
  body: AnthropicRequest,
  env: ProxyEnv,
  res: HttpResponse,
  isStream: boolean,
): Promise<boolean> {
  const apiKey = env.anthropicApiKey;
  if (!apiKey) {
    res.status(401).json({ error: 'No ANTHROPIC_API_KEY configured' });
    return true;
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: fetchSignal(),
  });

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    const reader = resp.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    }
    res.end();
  } else {
    const data = await resp.json();
    res.status(resp.status).json(data);
  }
  return true;
}

// ─── Gateway Passthrough ─────────────────────────────────────────────────────

async function forwardToGateway(
  body: AnthropicRequest,
  apiModel: string,
  env: ProxyEnv,
  res: HttpResponse,
  isStream: boolean,
  originalModel: string,
): Promise<boolean> {
  const openaiReq = convertAnthropicToOpenAI(body);
  openaiReq.model = apiModel;

  // Inject thought signatures for Gemini
  injectThoughtSigs(openaiReq.messages as unknown as Array<Record<string, unknown>>);

  const resp = await fetch(`${env.gatewayUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.gatewayKey}`,
      'x-openclaw-agent-id': 'claude-code-raw',
    },
    body: JSON.stringify(openaiReq),
    signal: fetchSignal(),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('[proxy] Gateway error:', resp.status, err);
    res
      .status(resp.status)
      .json({ type: 'error', error: { type: 'gateway_error', message: 'Upstream gateway error' } });
    return true;
  }

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();

    const reader = resp.body?.getReader();
    if (!reader) {
      res.end();
      return true;
    }

    try {
      const lineStream = readSSELines(reader);
      for await (const sseChunk of convertStreamOpenAIToAnthropic(lineStream, originalModel)) {
        res.write(sseChunk);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    res.end();
  } else {
    const data = (await resp.json()) as OpenAIResponse;
    const anthropicResp = convertOpenAIToAnthropic(data, originalModel);
    res.status(200).json(anthropicResp);
  }
  return true;
}

// ─── Direct Provider ─────────────────────────────────────────────────────────

async function handleNonStreamingResponse(
  apiUrl: string,
  apiKey: string,
  openaiReq: unknown,
  res: HttpResponse,
  originalModel: string,
): Promise<boolean> {
  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(Object.assign({}, openaiReq as object, { stream: false })),
    signal: fetchSignal(),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('[proxy] API error:', resp.status, err);
    res.status(resp.status).json({ type: 'error', error: { type: 'api_error', message: 'Upstream API error' } });
    return true;
  }

  const data = (await resp.json()) as OpenAIResponse;
  const anthropicResp = convertOpenAIToAnthropic(data, originalModel);
  res.status(200).json(anthropicResp);
  return true;
}

async function handleStreamingResponse(
  apiUrl: string,
  apiKey: string,
  openaiReq: unknown,
  res: HttpResponse,
  originalModel: string,
): Promise<boolean> {
  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(Object.assign({}, openaiReq as object, { stream: true })),
    signal: fetchSignal(),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('[proxy] Streaming API error:', resp.status, err);
    res.status(resp.status).json({ type: 'error', error: { type: 'api_error', message: 'Upstream API error' } });
    return true;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();

  const reader = resp.body?.getReader();
  if (!reader) {
    res.end();
    return true;
  }

  try {
    const lineStream = readSSELines(reader);
    for await (const sseChunk of convertStreamOpenAIToAnthropic(lineStream, originalModel)) {
      res.write(sseChunk);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  res.end();
  return true;
}

// ─── SSE Line Reader ─────────────────────────────────────────────────────────

async function* readSSELines(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) yield trimmed;
    }
  }

  if (buffer.trim()) yield buffer.trim();
}
