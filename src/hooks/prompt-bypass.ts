/**
 * Prompt bypass hook — replaces patch-openclaw.sh monkey-patches
 *
 * When a workspace has a `.openclaw-passthrough` marker file, this hook:
 * 1. Clears the system prompt (skips AGENTS.md / built-in agent prompt)
 * 2. Clears bootstrap files (skips context loading)
 *
 * This enables Claude Code CLI to run through OpenClaw gateway in
 * "passthrough" mode without the gateway's own agent system interfering.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const PASSTHROUGH_MARKER = '.openclaw-passthrough';

interface PromptBuildEvent {
  workspaceDir?: string;
  systemPrompt?: string;
  bootstrapFiles?: string[];
  [key: string]: unknown;
}

/**
 * Register the before_prompt_build hook on a Plugin API instance.
 *
 * Usage:
 *   import { registerPromptBypass } from './hooks/prompt-bypass.js';
 *   registerPromptBypass(api);
 */
export function registerPromptBypass(
  api: { registerHook(event: string, handler: (event: Record<string, unknown>) => Promise<Record<string, unknown>>): void }
): void {
  api.registerHook(
    'before_prompt_build',
    async (event: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const ev = event as PromptBuildEvent;
      const workspaceDir = ev.workspaceDir;

      if (!workspaceDir) return {};

      const markerPath = path.join(workspaceDir, PASSTHROUGH_MARKER);
      if (!fs.existsSync(markerPath)) return {};

      console.log(`[openclaw-claude-code] Passthrough mode: ${workspaceDir}`);

      return {
        systemPrompt: '',
        bootstrapFiles: [],
      };
    }
  );
}
