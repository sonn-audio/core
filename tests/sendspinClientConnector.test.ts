import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { sendspinCore } from '@sonn-audio/node-sendspin';
import { test } from './testHarness';
import { describeDrop, SendspinClientConnector } from '../src/adapters/outputs/sendspin/sendspinClientConnector';
import { logBuffer } from '../src/shared/logging/logBuffer';
import type { MdnsPort } from '../src/ports/MdnsPort';

/**
 * A Sendspin client on localhost, announced once over a fake mDNS, as `sauna-licht`. The
 * library's session handling is stubbed out: these tests are about who dials, not the protocol.
 */
async function setup(): Promise<{
  connector: SendspinClientConnector;
  /** Resolves with the next socket the connector opens to the client. */
  nextDial(): Promise<WebSocket>;
  dials(): number;
  close(): Promise<void>;
}> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  let count = 0;
  const waiting: Array<(ws: WebSocket) => void> = [];
  server.on('connection', (ws) => {
    count += 1;
    ws.send(JSON.stringify({ type: 'client/hello', payload: { client_id: 'sauna-licht' } }));
    waiting.shift()?.(ws);
  });

  const core = sendspinCore as unknown as Record<string, unknown>;
  const savedHandle = core.handleConnection;
  core.handleConnection = () => {};

  const mdns = {
    browse: (_options: unknown, onService: (service: unknown) => void) => {
      onService({ name: 'sauna-licht', addresses: ['127.0.0.1'], port, txt: {} });
      return { stop: () => {} };
    },
    publish: () => ({ stop: () => {} }),
    shutdown: () => {},
  } as unknown as MdnsPort;
  const connector = new SendspinClientConnector(mdns);

  return {
    connector,
    nextDial: () =>
      new Promise<WebSocket>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the client was not dialled')), 2_000);
        waiting.push((ws) => {
          clearTimeout(timer);
          resolve(ws);
        });
      }),
    dials: () => count,
    close: async () => {
      core.handleConnection = savedHandle;
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Let socket events settle. */
const settle = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('a client whose session dropped without a goodbye is dialled again', async () => {
  const env = await setup();
  try {
    const first = env.nextDial();
    const unwatch = env.connector.watchClient('sauna-licht');
    const socket = await first;
    env.connector.markInboundConnected('sauna-licht');
    await settle();

    // The client restarts: our socket closes first, the session's own cleanup follows.
    const second = env.nextDial();
    socket.terminate();
    await settle();
    env.connector.markInboundDisconnected('sauna-licht', null);
    await second;
    assert.equal(env.dials(), 2);
    unwatch();
  } finally {
    await env.close();
  }
});

test('a client that said a terminal goodbye is not dialled again', async () => {
  const env = await setup();
  try {
    const first = env.nextDial();
    const unwatch = env.connector.watchClient('sauna-licht');
    const socket = await first;
    env.connector.markInboundConnected('sauna-licht');
    await settle();

    socket.terminate();
    await settle();
    env.connector.markInboundDisconnected('sauna-licht', 'another_server');
    await settle(300);
    assert.equal(env.dials(), 1);
    unwatch();
  } finally {
    await env.close();
  }
});

test('a client whose hello the session refuses is redialled with the reason in the log (#423)', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  // A client on a newer spec release: node-sendspin 0.6 refuses the hello it sends.
  server.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'client/hello', payload: { client_id: 'sauna-audio', version: '1.0.0-rc1' } }));
  });
  const lines: string[] = [];
  const unsubscribe = logBuffer.subscribe((entry) => lines.push(entry.line));
  const mdns = {
    browse: (_options: unknown, onService: (service: unknown) => void) => {
      onService({ name: 'sauna-audio', addresses: ['127.0.0.1'], port, txt: {} });
      return { stop: () => {} };
    },
    publish: () => ({ stop: () => {} }),
    shutdown: () => {},
  } as unknown as MdnsPort;
  const connector = new SendspinClientConnector(mdns);
  const unwatch = connector.watchClient('sauna-audio');
  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !lines.some((line) => line.includes('Sendspin connection dropped'))) {
      await settle(25);
    }
    const drop = lines.find((line) => line.includes('Sendspin connection dropped; redialing'));
    assert.ok(drop, `no drop line among:\n${lines.join('\n')}`);
    assert.match(drop, /protocol version/);
    assert.match(drop, /1\.0\.0-rc1/);
  } finally {
    unwatch();
    unsubscribe();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a socket the client never says hello on is described as such', () => {
  const why = describeDrop({ firstType: null, helloVersion: undefined, serverClose: null }, 1006, '');
  assert.match(why, /never sent client\/hello/);
  const refused = describeDrop(
    { firstType: 'client/hello', helloVersion: 1, serverClose: { code: 1008, reason: 'initial state timeout' } },
    1008,
    '',
  );
  assert.equal(refused, 'server closed it: initial state timeout');
});
