#!/usr/bin/env tsx
/**
 * Integration test — runs all core operations in a single process
 * (simulates Plugin in-process usage)
 */

import { SessionManager } from './src/session-manager.js';

const manager = new SessionManager({ claudeBin: 'claude' });

async function test() {
  console.log('=== Claw Orchestrator Integration Test ===\n');

  // 1. File operations (no session needed)
  console.log('--- Test: agents-list ---');
  const agents = manager.listAgents('/tmp/test-project');
  console.log(`  Found ${agents.length} agent(s):`, agents.map(a => a.name));

  console.log('--- Test: skills-list ---');
  const skills = manager.listSkills('/tmp/test-project');
  console.log(`  Found ${skills.length} skill(s):`, skills.map(s => s.name));

  console.log('--- Test: rules-list ---');
  const rules = manager.listRules('/tmp/test-project');
  console.log(`  Found ${rules.length} rule(s):`, rules.map(r => r.name));

  // 2. Session lifecycle
  console.log('\n--- Test: session-start ---');
  const info = await manager.startSession({
    name: 'integration-test',
    cwd: process.env.HOME!,
  });
  console.log(`  Session started: ${info.name}, Claude ID: ${info.claudeSessionId || 'pending'}`);

  console.log('\n--- Test: session-list ---');
  const sessions = manager.listSessions();
  console.log(`  Active sessions: ${sessions.length}`, sessions.map(s => s.name));

  console.log('\n--- Test: session-send ---');
  const result = await manager.sendMessage('integration-test', 'just reply with one word: hello');
  console.log(`  Response: "${result.output.trim()}"`);

  console.log('\n--- Test: session-status ---');
  const status = manager.getStatus('integration-test');
  console.log(`  Turns: ${status.stats.turns}, Tokens: ${status.stats.tokensIn}in/${status.stats.tokensOut}out, Cost: $${status.stats.costUsd}`);

  console.log('\n--- Test: session-grep ---');
  const matches = await manager.grepSession('integration-test', 'hello');
  console.log(`  Grep matches: ${matches.length}`);

  console.log('\n--- Test: session-stop ---');
  await manager.stopSession('integration-test');
  console.log('  Session stopped.');

  console.log('\n--- Test: session-list (after stop) ---');
  const remaining = manager.listSessions();
  console.log(`  Active sessions: ${remaining.length}`);

  console.log('\n=== All tests passed ===');
  await manager.shutdown();
}

test().catch(err => {
  console.error('TEST FAILED:', err);
  manager.shutdown().then(() => process.exit(1));
});
