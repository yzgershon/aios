'use strict';

const path = require('path');
const { spawn } = require('child_process');

const script = path.join(__dirname, 'jarvis-mcp.js');
const child = spawn(process.execPath, [script], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, JARVIS_AIOS_URL: process.env.JARVIS_AIOS_URL || 'http://127.0.0.1:3000' },
});

let buffer = '';
let stderr = '';
const pending = new Map();
let nextId = 1;

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP ${method} timed out`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }
});
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

(async () => {
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jarvis-smoke', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    const listed = await request('tools/list');
    const called = await request('tools/call', { name: 'get_current_time', arguments: {} });
    const toolResult = called && called.structuredContent;
    if (!initialized || initialized.serverInfo.name !== 'jarvis') throw new Error('wrong MCP server identity');
    if (!listed || !Array.isArray(listed.tools) || listed.tools.length < 20) throw new Error('tool list is incomplete');
    if (!toolResult || !toolResult.ok || !toolResult.time) throw new Error('time tool failed');
    console.log(JSON.stringify({ ok: true, server: initialized.serverInfo, tools: listed.tools.length, time: toolResult.time }));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String((e && e.message) || e), stderr: stderr.slice(0, 1000) }));
    process.exitCode = 1;
  } finally {
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    try { child.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 100).unref();
  }
})();
