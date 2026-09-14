'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function client(chat) {
  const calls = [], audio = [], nodes = new Map();
  const node = () => ({ textContent: '', className: '', children: [], classList: { add() {}, remove() {}, toggle() {} }, appendChild(n) { this.children.push(n); }, querySelector() { return null; }, remove() {} });
  for (const id of ['jvLog', 'jvStatus', 'jvSend', 'jvVoice']) nodes.set(id, node());
  const bus = [];
  const context = {
    performance, AbortController, TextDecoder, Blob,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    window: {}, localStorage: { getItem: () => '0' },
    document: { getElementById: (id) => nodes.get(id), createElement: node },
    AIOS: { util: { esc: (x) => x }, bus: { emit: (...e) => bus.push(e) }, registerPage() {}, api: { post() { throw new Error('Blocking replay is forbidden'); } } },
    Audio: class {
      play() { audio.push(this); queueMicrotask(() => { this.ended = true; this.onended?.(); }); return Promise.resolve(); }
      pause() {}
    },
    fetch: async (url, opts = {}) => {
      calls.push({ url, body: opts.body });
      if (url === '/api/jarvis/chat-stream') return chat(opts);
      if (url === '/api/jarvis/tts') return { ok: true, headers: { get: () => 'local' }, blob: async () => new Blob(['wav']) };
      return { ok: true };
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/js/pages/jarvis.js'), 'utf8');
  vm.runInNewContext(source, context);
  return { app: context.AIOS.jarvis, calls, audio, bus, nodes };
}
function stream(events) {
  const bytes = new TextEncoder().encode(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
  // Deliver single bytes to exercise arbitrary UTF-8 and SSE boundaries.
  let pos = 0;
  return { ok: true, body: { getReader: () => ({ read: async () => pos < bytes.length ? { value: bytes.slice(pos, ++pos), done: false } : { done: true } }) } };
}

test('terminal auth failure sends one request and returns the orb to idle', async () => {
  const c = client(() => stream([{ type: 'error', error: 'JARVIS needs a fresh Codex sign-in.' }]));
  await c.app.ask('Hello');
  assert.equal(c.calls.filter((x) => x.url.includes('/chat')).length, 1);
  assert.equal(c.app.state(), 'idle');
  assert.match(c.nodes.get('jvLog').children.at(-1).textContent, /sign-in/);
});

test('done-only responses are spoken exactly once and Unicode is preserved', async () => {
  const c = client(() => stream([{ type: 'done', reply: 'It’s ready.' }]));
  await c.app.ask('Hello'); await delay(10);
  assert.equal(c.calls.filter((x) => x.url === '/api/jarvis/tts').length, 1);
  assert.equal(c.audio.length, 1);
  assert.equal(c.app.state(), 'idle');
  assert.equal(c.nodes.get('jvLog').children.at(-1).textContent, 'It’s ready.');
});

test('research links stay in the displayed reply without reading URLs aloud', async () => {
  const reply = 'Read the [official source](https://example.org/version/1.2).';
  const c = client(() => stream([{ type: 'delta', text: reply.slice(0, 55) }, { type: 'delta', text: reply.slice(55) }, { type: 'done', reply }]));
  await c.app.ask('Research this'); await delay(10);
  const speech = c.calls.filter((call) => call.url === '/api/jarvis/tts').map((call) => JSON.parse(call.body).text).join(' ');
  assert.equal(speech, 'Read the official source.');
  assert.equal(c.nodes.get('jvLog').children.at(-1).textContent, reply);
});

test('a stream cut off after partial text is never presented as success', async () => {
  const c = client(() => stream([{ type: 'delta', text: 'Working on it' }]));
  await c.app.ask('Help');
  assert.equal(c.bus.filter((x) => x[0] === 'jarvis:reply').length, 0);
  assert.equal(c.nodes.get('jvLog').children.at(-1).className, 'jv-msg err');
  assert.equal(c.app.state(), 'idle');
});

test('stop aborts the real fetch and a new request can complete', async () => {
  let request = 0, aborted = false;
  const c = client((opts) => ++request === 1 ? new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => { aborted = true; reject(opts.signal.reason); });
  }) : stream([{ type: 'done', reply: 'Second answer.' }]));
  const first = c.app.ask('First');
  await delay(); c.app.stop();
  await c.app.ask('Second'); await first; await delay(10);
  assert.equal(aborted, true);
  assert.equal(c.nodes.get('jvLog').children.at(-1).textContent, 'Second answer.');
  assert.equal(c.nodes.get('jvSend').disabled, false);
  assert.equal(c.app.state(), 'idle');
});
