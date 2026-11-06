import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseLog } from '../../src/sdk/index.js';
import { toAgUi } from '../../src/cli/agui.js';
import { runCli, tmpDir, REPO } from './helpers.js';

const ev = (seq, type, extra = {}) => ({ v: '0.1', seq, ts: `2026-11-06T10:00:0${seq}Z`, runId: 'r1', type, ...extra });

test('maps every event type with timestamp and rawEvent', () => {
  const events = [
    ev(1, 'run.started', { data: { title: 'T' } }),
    ev(2, 'stage.started', { data: { group: 'A' } }),
    ev(3, 'agent.registered', { agentId: 'w', agentName: 'Worker', data: {} }),
    ev(4, 'agent.status', { agentId: 'w', data: { state: 'working', say: 'Go' } }),
    ev(5, 'message', { agentId: 'w', data: { text: 'Hello' } }),
    ev(6, 'tool.started', { agentId: 'w', data: { name: 'search' } }),
    ev(7, 'tool.failed', { agentId: 'w', data: { name: 'search', error: 'timeout' } }),
    ev(8, 'handoff', { agentId: 'w', data: { to: 'lead' } }),
    ev(9, 'custom.weather', { data: { sky: 'grey' } }),
  ];
  const out = toAgUi(events, { threadId: 'proj' });
  assert.deepEqual(out.map((e) => e.type), [
    'RUN_STARTED', 'STEP_STARTED', 'SUBAGENT_STARTED', 'ACTIVITY_SNAPSHOT',
    'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'TOOL_CALL_START', 'TOOL_CALL_RESULT', 'CUSTOM', 'CUSTOM',
  ]);
  assert.deepEqual(out[0], { type: 'RUN_STARTED', threadId: 'proj', runId: 'r1', timestamp: Date.parse(events[0].ts), rawEvent: events[0] });
  assert.equal(out[1].stepName, 'A');
  assert.equal(out[2].name, 'Worker');
  assert.deepEqual(out[3].content, { agentId: 'w', state: 'working', say: 'Go' });
  assert.equal(out[5].delta, 'Hello');
  assert.equal(out[4].messageId, out[6].messageId);
  assert.equal(out[7].toolCallId, out[8].toolCallId, 'results pair with their call');
  assert.equal(out[8].content, 'timeout');
  assert.deepEqual([out[9].name, out[9].value], ['handoff', { to: 'lead' }]);
  assert.deepEqual([out[10].name, out[10].value], ['weather', { sky: 'grey' }]);
  assert.ok(out.every((e) => typeof e.timestamp === 'number' && e.rawEvent));
});

test('types named like Object.prototype members are unknown types (CUSTOM)', () => {
  const out = toAgUi([ev(1, 'constructor'), ev(2, 'toString'), ev(3, '__proto__')]);
  assert.deepEqual(out.map((e) => e.type), ['CUSTOM', 'CUSTOM', 'CUSTOM']);
});

test('result is attached to RUN_FINISHED; failures become RUN_ERROR', () => {
  const out = toAgUi([
    ev(1, 'run.started'), ev(2, 'result', { data: { markdown: 'done' } }), ev(3, 'run.finished'),
    ev(4, 'run.started'), ev(5, 'agent.failed', { agentId: 'w', data: { reason: 'x' } }), ev(6, 'run.failed', { data: { reason: 'boom' } }),
  ]);
  assert.deepEqual(out.map((e) => e.type), ['RUN_STARTED', 'CUSTOM', 'RUN_FINISHED', 'RUN_STARTED', 'SUBAGENT_ERROR', 'RUN_ERROR']);
  assert.deepEqual(out[2].result, { markdown: 'done' });
  assert.equal(out[5].message, 'boom');
});

test('export --ag-ui prints NDJSON for a project folder', async () => {
  const ws = tmpDir();
  try {
    const dir = path.join(ws, 'staged');
    fs.mkdirSync(path.join(dir, 'mas'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'spec/conformance/01-staged-team/events.jsonl'), path.join(dir, 'mas/events.jsonl'));
    const res = await runCli(['export', '--ag-ui', dir]);
    assert.equal(res.code, 0, res.stderr);
    const lines = res.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const events = parseLog(fs.readFileSync(path.join(dir, 'mas/events.jsonl'), 'utf8').split('\n'));
    assert.deepEqual([...new Set(lines.map((l) => l.rawEvent.seq))], events.map((e) => e.seq), 'every event is exported, in order');
    assert.equal(lines[0].threadId, 'staged');
    assert.equal(lines.at(-1).type, 'RUN_FINISHED');
    assert.equal(lines.at(-1).result.markdown, '## Shortlist\n- Currys £279');
    assert.equal((await runCli(['export', dir])).code, 2, 'the format is required');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
