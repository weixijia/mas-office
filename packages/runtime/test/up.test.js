import './keepalive.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from 'mas-office/server';
import { up } from '../src/index.js';
import { workspaceWith, fakeBackends } from './helpers.js';

test('up() prints the panel link with its token only when asked to', async () => {
  for (const printUrl of [true, false]) {
    const { ws } = workspaceWith();
    const lines = [];
    const app = await up({
      workspace: ws, port: 0, startServer, backends: fakeBackends(async () => 'ok').backends, out: (l) => lines.push(l), printUrl,
    });
    try {
      const withToken = lines.filter((l) => l.includes(app.server.token));
      assert.equal(withToken.length, printUrl ? 1 : 0, `printUrl: ${printUrl}`);
      assert.ok(lines.some((l) => l.includes(app.server.url)), 'the address is always shown');
      assert.equal(app.runtime.info().maxParallel, 3);
    } finally {
      await app.close();
    }
  }
});
