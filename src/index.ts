#!/usr/bin/env node
/**
 * Claude Code Skill
 * Provides CLI access to Claude Code via MCP protocol
 */

import { Command } from 'commander';

// Backend API URL - configure via environment variable
const API_URL = process.env.CLAUDE_CODE_API_URL || 'http://127.0.0.1:18795';
const PREFIX = '/claude-code';

interface ApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function apiCall(endpoint: string, method: string = 'GET', body?: object): Promise<ApiResponse> {
  const url = `${API_URL}${PREFIX}${endpoint}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);
    return await response.json() as ApiResponse;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

const program = new Command();

program
  .name('claude-code-skill')
  .description('Control Claude Code via MCP protocol')
  .version('1.0.0');

// Connect command
program
  .command('connect')
  .description('Connect to Claude Code MCP server')
  .action(async () => {
    console.log('Connecting to Claude Code...');
    const result = await apiCall('/connect', 'POST');
    if (result.ok) {
      console.log(`Connected! Status: ${result.status}`);
      console.log(`Server: ${JSON.stringify(result.server)}`);
      console.log(`Available tools: ${result.tools}`);
    } else {
      console.error(`Failed: ${result.error}`);
      process.exit(1);
    }
  });

// Disconnect command
program
  .command('disconnect')
  .description('Disconnect from Claude Code MCP server')
  .action(async () => {
    const result = await apiCall('/disconnect', 'POST');
    if (result.ok) {
      console.log('Disconnected from Claude Code');
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// List tools command
program
  .command('tools')
  .description('List available Claude Code tools')
  .action(async () => {
    const result = await apiCall('/tools');
    if (result.ok && Array.isArray(result.tools)) {
      console.log('Available tools:');
      for (const tool of result.tools) {
        const t = tool as { name: string; description: string };
        console.log(`  - ${t.name}: ${t.description}`);
      }
    } else {
      console.error(`Failed: ${result.error || 'Not connected'}`);
      console.log('Tip: Run "claude-code-skill connect" first');
    }
  });

// Bash command
program
  .command('bash <command>')
  .description('Execute a bash command via Claude Code')
  .option('-d, --description <desc>', 'Description of what the command does')
  .action(async (command: string, options: { description?: string }) => {
    const result = await apiCall('/bash', 'POST', {
      command,
      description: options.description || ''
    });
    if (result.ok) {
      const r = result.result as { stdout?: string; stderr?: string };
      if (r.stdout) console.log(r.stdout);
      if (r.stderr) console.error(r.stderr);
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Read file command
program
  .command('read <file>')
  .description('Read a file via Claude Code')
  .action(async (filePath: string) => {
    const result = await apiCall('/read', 'POST', { file_path: filePath });
    if (result.ok) {
      const r = result.result as { type?: string; file?: { content?: string } };
      if (r.file?.content) {
        console.log(r.file.content);
      } else {
        console.log(JSON.stringify(result.result, null, 2));
      }
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Call any tool
program
  .command('call <tool>')
  .description('Call any Claude Code tool with JSON args')
  .option('-a, --args <json>', 'JSON arguments for the tool', '{}')
  .action(async (tool: string, options: { args: string }) => {
    let args: object;
    try {
      args = JSON.parse(options.args);
    } catch {
      console.error('Invalid JSON args');
      process.exit(1);
    }

    const result = await apiCall('/call', 'POST', { tool, args });
    if (result.ok) {
      console.log(JSON.stringify(result.result, null, 2));
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Glob search
program
  .command('glob <pattern>')
  .description('Search for files by pattern')
  .option('-p, --path <dir>', 'Directory to search in')
  .action(async (pattern: string, options: { path?: string }) => {
    const args: { pattern: string; path?: string } = { pattern };
    if (options.path) args.path = options.path;

    const result = await apiCall('/call', 'POST', { tool: 'Glob', args });
    if (result.ok) {
      const r = result.result as { filenames?: string[] };
      if (r.filenames) {
        for (const f of r.filenames) console.log(f);
      } else {
        console.log(JSON.stringify(result.result, null, 2));
      }
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Grep search
program
  .command('grep <pattern>')
  .description('Search file contents')
  .option('-p, --path <dir>', 'Directory to search in')
  .option('-g, --glob <pattern>', 'File pattern to filter')
  .option('-c, --content', 'Show matching content')
  .action(async (pattern: string, options: { path?: string; glob?: string; content?: boolean }) => {
    const args: Record<string, unknown> = { pattern };
    if (options.path) args.path = options.path;
    if (options.glob) args.glob = options.glob;
    if (options.content) args.output_mode = 'content';

    const result = await apiCall('/call', 'POST', { tool: 'Grep', args });
    if (result.ok) {
      const r = result.result as { filenames?: string[]; content?: string };
      if (r.content) {
        console.log(r.content);
      } else if (r.filenames) {
        for (const f of r.filenames) console.log(f);
      } else {
        console.log(JSON.stringify(result.result, null, 2));
      }
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Status command
program
  .command('status')
  .description('Check connection status')
  .action(async () => {
    // Try to get tools - if it works, we're connected
    const result = await apiCall('/tools');
    if (result.ok) {
      console.log('Status: Connected');
      console.log(`Tools available: ${(result.tools as unknown[]).length}`);
    } else {
      console.log('Status: Not connected');
      console.log('Run "claude-code-skill connect" to connect');
    }
  });

// List sessions command
program
  .command('sessions')
  .description('List all Claude Code sessions')
  .option('-n, --limit <n>', 'Limit number of sessions', '10')
  .action(async (options: { limit: string }) => {
    const result = await apiCall('/sessions');
    if (result.ok && Array.isArray(result.sessions)) {
      const sessions = result.sessions.slice(0, parseInt(options.limit));
      console.log('Recent Claude Code sessions:\n');
      for (const s of sessions) {
        const sess = s as {
          sessionId: string;
          summary?: string;
          projectPath?: string;
          modified?: string;
          messageCount?: number;
        };
        console.log(`  ${sess.sessionId}`);
        console.log(`    Summary: ${sess.summary || 'N/A'}`);
        console.log(`    Project: ${sess.projectPath || 'N/A'}`);
        console.log(`    Modified: ${sess.modified || 'N/A'}`);
        console.log(`    Messages: ${sess.messageCount || 0}`);
        console.log('');
      }
    } else {
      console.error(`Failed: ${result.error || 'Unknown error'}`);
    }
  });

// Resume session command
program
  .command('resume <sessionId> <prompt>')
  .description('Resume a Claude Code session with a prompt')
  .option('-d, --cwd <dir>', 'Working directory')
  .action(async (sessionId: string, prompt: string, options: { cwd?: string }) => {
    console.log(`Resuming session ${sessionId}...`);
    const result = await apiCall('/resume', 'POST', {
      sessionId,
      prompt,
      cwd: options.cwd
    });
    if (result.ok) {
      console.log(result.output as string);
      if (result.stderr) console.error(result.stderr as string);
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Continue command
program
  .command('continue <prompt>')
  .description('Continue the most recent session in a directory')
  .option('-d, --cwd <dir>', 'Working directory', process.cwd())
  .action(async (prompt: string, options: { cwd: string }) => {
    console.log(`Continuing session in ${options.cwd}...`);
    const result = await apiCall('/continue', 'POST', {
      prompt,
      cwd: options.cwd
    });
    if (result.ok) {
      console.log(result.output as string);
      if (result.stderr) console.error(result.stderr as string);
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// === Persistent Session Commands ===

// Start a persistent session
program
  .command('session-start [name]')
  .description('Start a persistent Claude Code session')
  .option('-d, --cwd <dir>', 'Working directory')
  .option('-r, --resume <sessionId>', 'Resume an existing Claude session')
  .option('-m, --model <model>', 'Model to use')
  .option('--permission-mode <mode>', 'Permission mode: acceptEdits, bypassPermissions, default, delegate, dontAsk, plan', 'acceptEdits')
  .option('--fork-session', 'Create a new session ID instead of reusing (use with --resume)')
  .option('--allowed-tools <tools>', 'Comma-separated list of tools to auto-approve (e.g. Bash,Read,Edit)')
  .option('--disallowed-tools <tools>', 'Comma-separated list of tools to deny')
  .option('--tools <tools>', 'Limit available tools (use "" to disable all, "default" for all)')
  .option('--max-turns <n>', 'Maximum agent loop turns')
  .option('--max-budget <usd>', 'Maximum API spend in USD')
  .option('--system-prompt <prompt>', 'Replace system prompt completely')
  .option('--append-system-prompt <prompt>', 'Append to system prompt')
  .option('--skip-permissions', 'Skip all permission checks (dangerous!)')
  .option('--agents <json>', 'Custom sub-agents JSON (e.g. \'{"reviewer": {"prompt": "You review code"}}\')')
  .option('--agent <name>', 'Default agent to use')
  .option('--session-id <uuid>', 'Use a specific session ID (must be valid UUID)')
  .option('--add-dir <dirs>', 'Additional directories to allow tool access (comma-separated)')
  .action(async (name: string | undefined, options: {
    cwd?: string;
    resume?: string;
    model?: string;
    permissionMode?: string;
    forkSession?: boolean;
    allowedTools?: string;
    disallowedTools?: string;
    tools?: string;
    maxTurns?: string;
    maxBudget?: string;
    systemPrompt?: string;
    appendSystemPrompt?: string;
    skipPermissions?: boolean;
    agents?: string;
    agent?: string;
    sessionId?: string;
    addDir?: string;
  }) => {
    const sessionName = name || `session-${Date.now()}`;
    console.log(`Starting persistent session: ${sessionName}...`);

    const body: Record<string, unknown> = {
      name: sessionName,
      cwd: options.cwd,
      sessionId: options.resume,
      model: options.model,
      permissionMode: options.permissionMode || 'acceptEdits',
      forkSession: options.forkSession
    };

    // New flags
    if (options.allowedTools) {
      body.allowedTools = options.allowedTools.split(',').map(t => t.trim());
    }
    if (options.disallowedTools) {
      body.disallowedTools = options.disallowedTools.split(',').map(t => t.trim());
    }
    if (options.tools) {
      body.tools = options.tools === '""' ? [] : options.tools.split(',').map(t => t.trim());
    }
    if (options.maxTurns) {
      body.maxTurns = parseInt(options.maxTurns);
    }
    if (options.maxBudget) {
      body.maxBudgetUsd = parseFloat(options.maxBudget);
    }
    if (options.systemPrompt) {
      body.systemPrompt = options.systemPrompt;
    }
    if (options.appendSystemPrompt) {
      body.appendSystemPrompt = options.appendSystemPrompt;
    }
    if (options.skipPermissions) {
      body.dangerouslySkipPermissions = true;
    }
    if (options.agents) {
      try {
        body.agents = JSON.parse(options.agents);
      } catch {
        console.error('Invalid --agents JSON');
        process.exit(1);
      }
    }
    if (options.agent) {
      body.agent = options.agent;
    }
    if (options.sessionId) {
      body.customSessionId = options.sessionId;
    }
    if (options.addDir) {
      body.addDir = options.addDir.split(',').map(d => d.trim());
    }

    const result = await apiCall('/session/start', 'POST', body);

    if (result.ok) {
      console.log(`Session '${sessionName}' started!`);
      if (result.claudeSessionId) {
        console.log(`Claude Session ID: ${result.claudeSessionId}`);
      }
      // Show active options
      console.log(`Permission mode: ${options.permissionMode || 'acceptEdits'}`);
      if (options.allowedTools) console.log(`Allowed tools: ${options.allowedTools}`);
      if (options.disallowedTools) console.log(`Disallowed tools: ${options.disallowedTools}`);
      if (options.tools) console.log(`Available tools: ${options.tools}`);
      if (options.maxTurns) console.log(`Max turns: ${options.maxTurns}`);
      if (options.maxBudget) console.log(`Max budget: $${options.maxBudget}`);
      if (options.forkSession) console.log(`Fork mode: enabled`);
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Send message to a persistent session
program
  .command('session-send <name> <message>')
  .description('Send a message to a persistent session')
  .option('-t, --timeout <ms>', 'Timeout in milliseconds', '120000')
  .option('-s, --stream', 'Stream output in real-time')
  .action(async (name: string, message: string, options: { timeout: string; stream?: boolean }) => {
    console.log(`Sending to session '${name}'...`);

    if (options.stream) {
      // Use SSE streaming endpoint
      const url = `${API_URL}${PREFIX}/session/send-stream`;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, message, timeout: parseInt(options.timeout) })
        });

        if (!response.ok || !response.body) {
          console.error('Failed to connect to stream');
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6)) as { type: string; text?: string; tool?: string; error?: string };
                if (data.type === 'text') {
                  process.stdout.write(data.text || '');
                } else if (data.type === 'tool_use') {
                  console.log(`\n🔧 [Tool: ${data.tool}]`);
                } else if (data.type === 'tool_result') {
                  console.log('✓ Tool completed');
                } else if (data.type === 'done') {
                  console.log('\n--- Done ---');
                } else if (data.type === 'error') {
                  console.error(`\nError: ${data.error}`);
                }
              } catch {
                // Ignore parse errors
              }
            }
          }
        }
      } catch (error) {
        console.error(`Stream error: ${(error as Error).message}`);
      }
    } else {
      // Non-streaming mode
      const result = await apiCall('/session/send', 'POST', {
        name,
        message,
        timeout: parseInt(options.timeout)
      });

      if (result.ok) {
        console.log(result.response as string);
      } else {
        console.error(`Failed: ${result.error}`);
      }
    }
  });

// List active sessions
program
  .command('session-list')
  .description('List active persistent sessions')
  .action(async () => {
    const result = await apiCall('/session/list');
    if (result.ok && Array.isArray(result.sessions)) {
      if (result.sessions.length === 0) {
        console.log('No active persistent sessions.');
      } else {
        console.log('Active persistent sessions:\n');
        for (const s of result.sessions) {
          const sess = s as {
            name: string;
            cwd?: string;
            created?: string;
            isReady?: boolean;
          };
          console.log(`  ${sess.name}`);
          console.log(`    CWD: ${sess.cwd || 'N/A'}`);
          console.log(`    Created: ${sess.created || 'N/A'}`);
          console.log(`    Ready: ${sess.isReady ? 'Yes' : 'No'}`);
          console.log('');
        }
      }
    } else {
      console.error(`Failed: ${result.error || 'Unknown error'}`);
    }
  });

// Stop a persistent session
program
  .command('session-stop <name>')
  .description('Stop a persistent session')
  .action(async (name: string) => {
    const result = await apiCall('/session/stop', 'POST', { name });
    if (result.ok) {
      console.log(`Session '${name}' stopped.`);
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Get session status
program
  .command('session-status <name>')
  .description('Get detailed status of a persistent session')
  .action(async (name: string) => {
    const result = await apiCall('/session/status', 'POST', { name });
    if (result.ok) {
      console.log(`Session: ${name}`);
      console.log(`  Claude ID: ${result.claudeSessionId || 'N/A'}`);
      console.log(`  CWD: ${result.cwd}`);
      console.log(`  Created: ${result.created}`);
      
      const stats = result.stats as {
        turns?: number;
        toolCalls?: number;
        tokensIn?: number;
        tokensOut?: number;
        uptime?: number;
        lastActivity?: string;
        isReady?: boolean;
      };
      
      console.log('\nStatistics:');
      console.log(`  Ready: ${stats.isReady ? 'Yes' : 'No'}`);
      console.log(`  Turns: ${stats.turns || 0}`);
      console.log(`  Tool Calls: ${stats.toolCalls || 0}`);
      console.log(`  Tokens In: ${stats.tokensIn || 0}`);
      console.log(`  Tokens Out: ${stats.tokensOut || 0}`);
      console.log(`  Uptime: ${stats.uptime || 0}s`);
      console.log(`  Last Activity: ${stats.lastActivity || 'N/A'}`);
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Get session history
program
  .command('session-history <name>')
  .description('Get conversation history of a persistent session')
  .option('-n, --limit <n>', 'Number of events to show', '20')
  .action(async (name: string, options: { limit: string }) => {
    const result = await apiCall('/session/history', 'POST', { 
      name, 
      limit: parseInt(options.limit) 
    });
    if (result.ok) {
      console.log(`Session '${name}' history (${result.count} events):\n`);
      
      const history = result.history as Array<{
        time: string;
        type: string;
        event: { message?: { content?: Array<{ type: string; text?: string; name?: string }> } };
      }>;
      
      for (const entry of history) {
        const time = new Date(entry.time).toLocaleTimeString();
        const type = entry.type.padEnd(12);
        
        let content = '';
        if (entry.event.message?.content) {
          for (const c of entry.event.message.content) {
            if (c.type === 'text' && c.text) {
              content = c.text.substring(0, 60).replace(/\n/g, ' ');
              if (c.text.length > 60) content += '...';
            } else if (c.type === 'tool_use' && c.name) {
              content = `[Tool: ${c.name}]`;
            }
          }
        }
        
        console.log(`[${time}] ${type} ${content}`);
      }
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Pause a persistent session
program
  .command('session-pause <name>')
  .description('Pause a persistent session (saves state)')
  .action(async (name: string) => {
    const result = await apiCall('/session/pause', 'POST', { name });
    if (result.ok) {
      console.log(`Session '${name}' paused.`);
      console.log(`Resume with: claude-code-skill session-resume ${name}`);
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Resume a paused session
program
  .command('session-resume-paused <name>')
  .description('Resume a paused persistent session')
  .action(async (name: string) => {
    const result = await apiCall('/session/resume', 'POST', { name });
    if (result.ok) {
      console.log(`Session '${name}' resumed.`);
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Fork a session
program
  .command('session-fork <name> <newName>')
  .description('Fork an existing session to create a branch')
  .action(async (name: string, newName: string) => {
    const result = await apiCall('/session/fork', 'POST', { name, newName });
    if (result.ok) {
      console.log(`Session '${name}' forked to '${newName}'`);
      if (result.claudeSessionId) {
        console.log(`New Claude Session ID: ${result.claudeSessionId}`);
      }
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Search sessions
program
  .command('session-search [query]')
  .description('Search sessions by project path, summary, or time')
  .option('-p, --project <path>', 'Filter by project path')
  .option('-s, --since <time>', 'Show sessions since (e.g., "1h", "2d", "2024-01-01")')
  .option('-n, --limit <n>', 'Limit results', '20')
  .action(async (query: string | undefined, options: { project?: string; since?: string; limit: string }) => {
    const result = await apiCall('/session/search', 'POST', {
      query,
      project: options.project,
      since: options.since,
      limit: parseInt(options.limit)
    });

    if (result.ok && Array.isArray(result.sessions)) {
      if (result.sessions.length === 0) {
        console.log('No sessions found.');
      } else {
        console.log(`Found ${result.sessions.length} session(s):\n`);
        for (const s of result.sessions) {
          const sess = s as { name: string; cwd?: string; created?: string; summary?: string };
          console.log(`  ${sess.name}`);
          console.log(`    CWD: ${sess.cwd || 'N/A'}`);
          console.log(`    Created: ${sess.created || 'N/A'}`);
          if (sess.summary) console.log(`    Summary: ${sess.summary}`);
          console.log('');
        }
      }
    } else {
      console.error(`Failed: ${result.error || 'Unknown error'}`);
    }
  });

// Batch read files
program
  .command('batch-read <patterns...>')
  .description('Read multiple files at once by glob patterns')
  .option('-p, --path <dir>', 'Base directory')
  .action(async (patterns: string[], options: { path?: string }) => {
    const result = await apiCall('/batch-read', 'POST', {
      patterns,
      basePath: options.path
    });

    if (result.ok && result.files) {
      const files = result.files as Array<{ path: string; content: string; error?: string }>;
      console.log(`Read ${files.length} file(s):\n`);
      for (const file of files) {
        console.log(`=== ${file.path} ===`);
        if (file.error) {
          console.error(`Error: ${file.error}`);
        } else {
          console.log(file.content);
        }
        console.log('');
      }
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

// Restart a failed session
program
  .command('session-restart <name>')
  .description('Restart a failed or stopped session')
  .action(async (name: string) => {
    const result = await apiCall('/session/restart', 'POST', { name });
    if (result.ok) {
      console.log(`Session '${name}' restarted.`);
    } else {
      console.error(`Failed: ${result.error}`);
    }
  });

program.parse();
