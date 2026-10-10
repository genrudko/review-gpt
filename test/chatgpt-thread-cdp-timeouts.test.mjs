import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const modulePath = new URL('../dist/chatgpt-thread-lib.mjs', import.meta.url);

class Socket {
  static instances = [];
  static respond = () => {};
  static autoOpen = true;
  listeners = new Map();
  constructor(url) {
    this.url = url;
    Socket.instances.push(this);
    if (Socket.autoOpen) queueMicrotask(() => this.fire('open'));
  }
  addEventListener(type, listener) {
    const items = this.listeners.get(type) || [];
    items.push(listener);
    this.listeners.set(type, items);
  }
  fire(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback(event);
  }
  send(message) {
    Socket.respond(this, JSON.parse(message));
  }
  close() { this.fire('close'); }
}
function withSocket(t) {
  const original = globalThis.WebSocket;
  Socket.instances.length = 0;
  Socket.respond = () => {};
  Socket.autoOpen = true;
  globalThis.WebSocket = Socket;
  t.after(() => {
    globalThis.WebSocket = original;
    Socket.respond = () => {};
    Socket.autoOpen = true;
    Socket.instances.length = 0;
  });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a never-opening CDP socket has a finite deadline', async t => {
  withSocket(t);
  const { CdpClient } = await import(modulePath);
  Socket.autoOpen = false;
  const client = new CdpClient('ws://example.invalid/socket', { connectMs: 25, commandMs: 25 });
  await assert.rejects(client.send('Runtime.enable'), /Timed out opening CDP WebSocket/);
  client.close();
});

test('late CDP replies do not resurrect timed-out commands', async t => {
  withSocket(t);
  const { CdpClient } = await import(modulePath);
  let lastCommand = null;
  Socket.respond = (_socket, message) => { lastCommand = message; };
  const client = new CdpClient('ws://example.invalid/socket', { commandMs: 25 });
  await assert.rejects(client.send('Page.navigate'), /Timed out waiting for CDP command Page.navigate/);
  const socket = Socket.instances.at(-1);
  socket.fire('message', { data: JSON.stringify({ id: lastCommand.id, result: { ok: true } }) });
  client.close();
});

test('hung export command closes only its own created CDP target', async t => {
  withSocket(t);
  const originalFetch = globalThis.fetch;
  let created = false;
  const closed = [];
  const chatUrl = 'https://chatgpt.com/c/lease-test';
  const endpoint = 'http://127.0.0.1:9222';
  globalThis.fetch = async url => {
    const value = String(url);
    if (value.endsWith('/json/version')) {
      return new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://fake/browser' }), { status: 200 });
    }
    if (value.endsWith('/json/list')) {
      return new Response(JSON.stringify(created ? [{
        id: 'test-owned-target', type: 'page', url: chatUrl,
        webSocketDebuggerUrl: 'ws://fake/page',
      }] : []), { status: 200 });
    }
    throw new Error('Unexpected fetch in fake browser');
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  Socket.respond = (socket, command) => {
    if (command.method === 'Target.createTarget') {
      created = true;
      queueMicrotask(() => socket.fire('message', {
        data: JSON.stringify({ id: command.id, result: { targetId: 'test-owned-target' } }),
      }));
    } else if (command.method === 'Target.closeTarget') {
      closed.push(command.params.targetId);
      queueMicrotask(() => socket.fire('message', {
        data: JSON.stringify({ id: command.id, result: { success: true } }),
      }));
    }
    // Runtime.enable is intentionally never answered to exercise the child timeout.
  };
  const root = mkdtempSync(path.join(tmpdir(), 'review-gpt-timeout-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { exportThreadSnapshot } = await import(modulePath);
  const started = Date.now();
  await assert.rejects(
    exportThreadSnapshot(endpoint, chatUrl, path.join(root, 'thread.json')),
    /Timed out waiting for CDP command Runtime.enable/,
  );
  assert.deepEqual(closed, ['test-owned-target']);
  assert.ok(Date.now() - started < 20000, 'cleanup must finish before the 60s CLI kill');
});
