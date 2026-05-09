import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import express from 'express';

import commandsRouter from './commands.js';

const servers = [];

async function startTestServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/commands', commandsRouter);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('/api/commands/list includes /turnkey builtin command', async () => {
  const baseUrl = await startTestServer();
  const response = await fetch(`${baseUrl}/api/commands/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });

  assert.equal(response.ok, true);
  const payload = await response.json();
  const turnkey = payload.builtIn.find((cmd) => cmd.name === '/turnkey');
  assert.ok(turnkey);
  assert.match(turnkey.description, /\/turnkey start/);
});

test('/api/commands/execute forwards /turnkey start to /turnkey:start', async () => {
  const baseUrl = await startTestServer();
  const response = await fetch(`${baseUrl}/api/commands/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandName: '/turnkey',
      args: ['start', 'fix', 'bug'],
      context: {},
    }),
  });

  assert.equal(response.ok, true);
  const payload = await response.json();
  assert.equal(payload.type, 'custom');
  assert.equal(payload.command, '/turnkey');
  assert.equal(payload.content, '/turnkey:start fix bug');
  assert.equal(payload.hasBashCommands, false);
  assert.equal(payload.hasFileIncludes, false);
});

test('/api/commands/execute returns usage when /turnkey has no subcommand', async () => {
  const baseUrl = await startTestServer();
  const response = await fetch(`${baseUrl}/api/commands/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandName: '/turnkey',
      args: [],
      context: {},
    }),
  });

  assert.equal(response.ok, true);
  const payload = await response.json();
  assert.equal(payload.type, 'builtin');
  assert.equal(payload.action, 'help');
  assert.match(payload.data.content, /Usage:/);
  assert.match(payload.data.content, /\/turnkey start/);
});

test('/api/commands/execute returns usage when /turnkey subcommand is unknown', async () => {
  const baseUrl = await startTestServer();
  const response = await fetch(`${baseUrl}/api/commands/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandName: '/turnkey',
      args: ['unknown'],
      context: {},
    }),
  });

  assert.equal(response.ok, true);
  const payload = await response.json();
  assert.equal(payload.type, 'builtin');
  assert.equal(payload.action, 'help');
  assert.match(payload.data.content, /Unknown \/turnkey action/);
  assert.match(payload.data.content, /\/turnkey start/);
});
