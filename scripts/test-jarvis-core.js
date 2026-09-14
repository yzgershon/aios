'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syncAuth, brainError } = require('../lib/jarvis-auth');
const { directIntent } = require('../lib/jarvis-intent');
const { TurnQueue } = require('../lib/jarvis-turn-queue');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('old auth hard links follow a new login without changing source credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-auth-test-'));
  const source = path.join(dir, 'source'), target = path.join(dir, 'target');
  fs.mkdirSync(source); fs.mkdirSync(target);
  const sourceFile = path.join(source, 'auth.json'), targetFile = path.join(target, 'auth.json');
  try {
    fs.writeFileSync(sourceFile, '{"fixture":"old"}');
    fs.linkSync(sourceFile, targetFile);
    fs.writeFileSync(path.join(source, 'new.json'), '{"fixture":"new"}');
    fs.renameSync(path.join(source, 'new.json'), sourceFile);
    assert.equal(syncAuth(source, target).changed, true);
    assert.equal(fs.readFileSync(targetFile, 'utf8'), '{"fixture":"new"}');
    fs.writeFileSync(targetFile, '{"fixture":"refreshed-by-jarvis"}');
    assert.equal(syncAuth(source, target).changed, false);
    assert.equal(fs.readFileSync(sourceFile, 'utf8'), '{"fixture":"new"}');
    assert.match(fs.readFileSync(targetFile, 'utf8'), /refreshed-by-jarvis/);
    fs.writeFileSync(sourceFile, '{');
    assert.throws(() => syncAuth(source, target));
    assert.match(fs.readFileSync(targetFile, 'utf8'), /refreshed-by-jarvis/);
  } finally {
    for (const sub of [source, target]) { for (const file of fs.readdirSync(sub)) fs.unlinkSync(path.join(sub, file)); fs.rmdirSync(sub); }
    fs.rmdirSync(dir);
  }
});

test('only unambiguous commands use direct answers', () => {
  for (const prompt of ['What time is it?', 'What day is today?', 'Please list my reminders.', 'AIOS status', 'Show loaded Ollama models']) assert.ok(directIntent(prompt), prompt);
  for (const prompt of [
    'How can I manage my time better?', 'What is on my screen?', 'Explain this model to me',
    'Help me prioritize my tasks', 'Why is the server slow?', 'What are my goals and how should I reach them?',
    'Do not generate my brief', 'Refresh social data after explaining what it does',
    'Read my notes about time management', 'What time is it in Tokyo?',
    'What is the date of the next holiday?', 'How do reminders work?',
  ]) assert.equal(directIntent(prompt), null, prompt);
});

test('authentication and timeout errors are actionable and distinct', () => {
  assert.equal(brainError(new Error('refresh token revoked')).code, 'AUTH_REQUIRED');
  const controller = new AbortController();
  controller.abort(Object.assign(new Error('timeout'), { code: 'TURN_TIMEOUT' }));
  assert.equal(brainError(new Error('aborted'), controller.signal).code, 'TURN_TIMEOUT');
  assert.equal(brainError(new Error('429 usage limit')).code, 'RATE_LIMITED');
});

test('queued work is bounded, abortable, and never executed after cancellation', async () => {
  const queue = new TurnQueue(() => {}, 30);
  let release;
  const first = queue.run(() => new Promise((resolve) => { release = resolve; }));
  const controller = new AbortController();
  let ran = false;
  const second = queue.run(() => { ran = true; }, controller.signal);
  await assert.rejects(queue.run(() => {}), { code: 'BUSY' });
  controller.abort();
  await assert.rejects(second);
  assert.equal(queue.waiter, null);
  await assert.rejects(queue.run(() => { ran = true; }), { code: 'BUSY' });
  release(); await first; await delay(0);
  assert.equal(ran, false);
  assert.equal(await queue.run(() => 42), 42);
  assert.equal(queue.busy, false);
});
