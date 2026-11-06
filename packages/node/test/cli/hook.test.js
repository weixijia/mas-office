import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reduce } from '../../src/sdk/index.js';
import { mapHook, describeTool } from '../../src/cli/claude-code.js';
import { handleHook } from '../../src/cli/commands/hook.js';
import { tmpDir, runCli, readJson } from './helpers.js';

const SESSION = 'e4f1c2d0-0000-4000-8000-000000000001';
const base = { session_id: SESSION, cwd: '/work/repo', transcript_path: '/tmp/t.jsonl' };
const IDLE = reduce([]);
const RUNNING = reduce([{ v: '0.1', seq: 1, ts: 't', type: 'run.started', runId: SESSION, data: {} }]);
const types = (events) => events.map((e) => `${e.type}@${e.agentId}`);

test('SessionStart / UserPromptSubmit start a run only when this session has none running', () => {
  const start = mapHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' }, IDLE);
  assert.deepEqual(types(start), ['run.started@lead']);
  assert.equal(start[0].runId, SESSION);
  assert.deepEqual(mapHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, RUNNING), []);
  const other = reduce([{ v: '0.1', seq: 1, ts: 't', type: 'run.started', runId: 'another-session', data: {} }]);
  assert.deepEqual(types(mapHook({ ...base, hook_event_name: 'UserPromptSubmit' }, other)), ['run.started@lead']);
});

test('subagents: start registers and works, stop finishes; ids are sanitised', () => {
  const input = { ...base, hook_event_name: 'SubagentStart', agent_id: 'Agent_7F/x', agent_type: 'Explore' };
  const events = mapHook(input, RUNNING);
  assert.deepEqual(types(events), ['agent.registered@agent-7f-x', 'agent.status@agent-7f-x']);
  assert.equal(events[0].agentName, 'Explore');
  assert.equal(events[0].parentId, 'lead');
  assert.equal(events[0].data.name, 'Explore');
  assert.equal(events[1].data.state, 'working');
  assert.deepEqual(types(mapHook({ ...base, hook_event_name: 'SubagentStop', agent_id: 'Agent_7F/x', agent_type: 'Explore' }, RUNNING)),
    ['agent.finished@agent-7f-x']);
  assert.deepEqual(mapHook({ ...base, hook_event_name: 'SubagentStart' }, RUNNING), [], 'no agent_id: nothing to show');
  assert.equal(mapHook({ ...base, hook_event_name: 'SubagentStart', agent_id: 'lead' }, RUNNING)[0].agentId, 'lead-agent');
});

test('tool hooks map to tool events on the agent (or lead); spawn tools are skipped', () => {
  const pre = mapHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a/b/app.js' }, tool_use_id: 'toolu_1' }, RUNNING);
  assert.deepEqual(types(pre), ['tool.started@lead']);
  assert.deepEqual(pre[0].data, { name: 'Read', callId: 'toolu_1', say: 'Reading app.js' });
  const inSub = mapHook({ ...base, hook_event_name: 'PostToolUse', agent_id: 'a1', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 'toolu_2' }, RUNNING);
  assert.deepEqual(types(inSub), ['tool.finished@a1']);
  assert.equal(inSub[0].agentName, 'Explore');
  const failed = mapHook({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_3', error: 'exit 1' }, RUNNING);
  assert.deepEqual(failed[0].data, { name: 'Bash', callId: 'toolu_3', error: 'exit 1' });
  for (const name of ['Agent', 'Task']) {
    assert.deepEqual(mapHook({ ...base, hook_event_name: 'PreToolUse', tool_name: name, tool_input: {} }, RUNNING), []);
    assert.deepEqual(mapHook({ ...base, hook_event_name: 'PostToolUse', tool_name: name }, RUNNING), []);
  }
});

test('Notification flags the lead; the next prompt or tool call clears it; Stop finishes the run', () => {
  const note = mapHook({ ...base, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }, RUNNING);
  assert.deepEqual(types(note), ['flag.raised@lead']);
  assert.deepEqual(note[0].data, { text: 'Claude needs your permission to use Bash', kind: 'needs_input' });
  const flagged = reduce([
    { v: '0.1', seq: 1, ts: 't', type: 'run.started', runId: SESSION, data: {} },
    { v: '0.1', seq: 2, ts: 't', type: 'flag.raised', data: { text: 'x', kind: 'needs_input' } },
  ]);
  assert.deepEqual(types(mapHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }, flagged)),
    ['flag.resolved@lead', 'tool.started@lead']);
  assert.deepEqual(types(mapHook({ ...base, hook_event_name: 'Stop' }, RUNNING)), ['run.finished@lead']);
  assert.deepEqual(mapHook({ ...base, hook_event_name: 'Stop' }, IDLE), []);
  assert.deepEqual(mapHook({ ...base, hook_event_name: 'PreCompact' }, RUNNING), []);
});

test('describeTool never leaks arguments', () => {
  assert.equal(describeTool('Bash', { command: 'curl -H "Authorization: Bearer secret" https://x' }), 'Running curl');
  assert.equal(describeTool('Bash', { command: '/usr/local/bin/python3 -c "print(1)"' }), 'Running python3');
  assert.equal(describeTool('WebFetch', { url: 'https://docs.example.com/a?token=1' }), 'Reading docs.example.com');
  assert.equal(describeTool('mcp__github__create_issue', {}), 'Using create_issue');
  assert.ok(describeTool('Write', { file_path: `/${'x'.repeat(100)}.md` }).length <= 60);
});

test('handleHook: a whole session lands in the log as valid events', () => {
  const ws = tmpDir();
  try {
    const inputs = [
      { hook_event_name: 'SessionStart' },
      { hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.js' }, tool_use_id: 't1' },
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't1' },
      { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {} },
      { hook_event_name: 'SubagentStart', agent_id: 'sub-1', agent_type: 'Explore' },
      { hook_event_name: 'PreToolUse', agent_id: 'sub-1', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 't2' },
      { hook_event_name: 'SubagentStop', agent_id: 'sub-1', agent_type: 'Explore' },
      { hook_event_name: 'Stop' },
    ];
    for (const input of inputs) handleHook({ ...base, ...input }, { workspace: ws });
    const dir = path.join(ws, 'claude-code');
    const log = fs.readFileSync(path.join(dir, 'mas/events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(types(log), [
      'run.started@lead', 'tool.started@lead', 'tool.finished@lead', 'agent.registered@sub-1', 'agent.status@sub-1',
      'tool.started@sub-1', 'agent.finished@sub-1', 'run.finished@lead',
    ]);
    assert.deepEqual(log.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(readJson(path.join(dir, 'mas/state.json')).phase, 'done');
    assert.equal(readJson(path.join(dir, 'mas/structure.json')).roles[0].name, 'Explore');
    assert.equal(readJson(path.join(ws, 'home/projects.json')).current, 'claude-code');
    assert.ok(!fs.existsSync(path.join(dir, 'mas/.events.lock')), 'lock released');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('hook command: prints nothing and exits 0, even on bad input; errors go to the log', async () => {
  const ws = tmpDir();
  try {
    const ok = await runCli(['hook', 'claude-code', '--workspace', ws], { input: JSON.stringify({ ...base, hook_event_name: 'SessionStart' }) });
    assert.deepEqual([ok.code, ok.stdout, ok.stderr], [0, '', '']);
    assert.ok(fs.existsSync(path.join(ws, 'claude-code/mas/events.jsonl')));

    for (const args of [['hook', 'claude-code', '--workspace', ws], ['hook', 'nope', '--workspace', ws], ['hook', 'claude-code', '--workspace', ws, '--project', 'Bad Name'], ['hook', '--bogus']]) {
      const bad = await runCli(args, { input: '{not json', cwd: ws });
      assert.deepEqual([bad.code, bad.stdout, bad.stderr], [0, '', ''], args.join(' '));
    }
    const errors = fs.readFileSync(path.join(ws, 'home/hook-errors.log'), 'utf8');
    assert.ok(errors.trim().split('\n').filter((l) => /^\d{4}-/.test(l)).length >= 3, errors);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
