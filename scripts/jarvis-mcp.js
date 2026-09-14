'use strict';

// Minimal dependency-free MCP stdio server. Stdout is reserved for JSON-RPC;
// diagnostics go to stderr so they can never corrupt the protocol stream.
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  LOCAL_TOOL_DEFINITIONS,
  executeTool,
  getToolPolicy,
  summarizeToolCall,
} = require('../lib/jarvis-tools');

const AIOS = (process.env.JARVIS_AIOS_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOOL_TEXT_LIMIT = 16000;
const SCREEN_ROOT = path.resolve(os.homedir(), '.aios', 'jarvis-screens');
let inputBuffer = '';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message: String(message || 'MCP error').slice(0, 1000) } });
}

function toolSchemas() {
  return LOCAL_TOOL_DEFINITIONS.map((definition) => {
    const name = definition.function.name;
    const policy = getToolPolicy(name, {});
    const readOnly = policy.risk === 'read' || policy.risk === 'screen';
    return {
      name,
      description: definition.function.description,
      inputSchema: definition.function.parameters,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: false,
        idempotentHint: readOnly,
        openWorldHint: false,
      },
    };
  });
}

function approvalInput(name, args) {
  if (name === 'edit_project_file') return { project: args.project, path: args.path, create: args.create, expectedSha256: args.expectedSha256, replacementChars: String(args.replacement || '').length };
  if (name === 'set_ui_field') return { handle: args.handle, automationId: args.automationId, name: args.name, intent: args.intent, allowSensitive: args.allowSensitive, textChars: String(args.text || '').length };
  if (name === 'write_local_file') {
    return {
      path: args.path,
      mode: args.mode,
      base: args.base,
      createDirs: args.createDirs,
      contentChars: String(args.content || '').length,
    };
  }
  if (name === 'type_text') {
    return { intent: args.intent, allowSensitive: args.allowSensitive, textChars: String(args.text || '').length };
  }
  if (name === 'write_clipboard') return { textChars: String(args.text || '').length };
  return args;
}

async function resultContent(result, text) {
  const content = [{ type: 'text', text }];
  const paths = [
    result && result.path,
    result && result.screenshotPath,
    result && result.verification && result.verification.path,
    ...((result && result.captures) || []).map((capture) => capture && capture.path),
    ...((result && result.verification && result.verification.captures) || []).map((capture) => capture && capture.path),
  ].filter(Boolean);
  const seen = new Set();
  for (const candidate of paths) {
    const resolved = path.resolve(String(candidate));
    if (seen.has(resolved) || (resolved !== SCREEN_ROOT && !resolved.startsWith(SCREEN_ROOT + path.sep))) continue;
    seen.add(resolved);
    try {
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile() || stat.size > 15 * 1024 * 1024 || path.extname(resolved).toLowerCase() !== '.png') continue;
      content.push({ type: 'image', data: (await fs.promises.readFile(resolved)).toString('base64'), mimeType: 'image/png' });
    } catch { /* image verification is best effort */ }
  }
  return content;
}

async function postJson(route, body, timeoutMs = 150000) {
  const response = await fetch(AIOS + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `AIOS ${route} returned ${response.status}`);
  return data;
}

async function recordToolEvent(event, name, policy, fields = {}) {
  try {
    await postJson('/api/jarvis/tool-event', {
      event,
      tool: name,
      ownerPid: Number(process.env.JARVIS_OWNER_PID) || 0,
      risk: policy.risk,
      ...fields,
    }, 2500);
  } catch { /* telemetry must never break a tool call */ }
}

async function callTool(id, params) {
  const name = String((params && params.name) || '').trim();
  const args = params && params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  const definition = LOCAL_TOOL_DEFINITIONS.find((item) => item.function.name === name);
  if (!definition) return sendError(id, -32602, `unknown Jarvis tool: ${name}`);

  const policy = getToolPolicy(name, args);
  const started = performance.now();
  await recordToolEvent('started', name, policy);

  let decision;
  try {
    decision = await postJson('/api/jarvis/approval-request', {
      tool_name: name,
      input: approvalInput(name, args),
      risk: policy.risk,
      summary: summarizeToolCall(name, args),
      require_approval: policy.requiresApproval,
    });
  } catch (e) {
    decision = { allow: false, reason: 'Jarvis approval service unavailable: ' + String((e && e.message) || e) };
  }

  if (!decision.allow) {
    const denied = { ok: false, denied: true, error: decision.reason || 'Action denied.' };
    await recordToolEvent('denied', name, policy, { ms: Math.round(performance.now() - started), ok: false });
    return send({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: JSON.stringify(denied) }], structuredContent: denied, isError: true },
    });
  }

  const result = await executeTool(name, args);
  const text = JSON.stringify(result).slice(0, TOOL_TEXT_LIMIT);
  const content = await resultContent(result, text);
  await recordToolEvent('completed', name, policy, {
    ms: Math.round(performance.now() - started),
    ok: !!(result && result.ok),
  });
  send({
    jsonrpc: '2.0', id,
    result: {
      content,
      structuredContent: result,
      isError: !(result && result.ok),
    },
  });
}

async function handle(message) {
  const id = message.id;
  const method = message.method;
  const params = message.params || {};

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params.protocolVersion || '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'jarvis', version: '2.1.0' },
        instructions: 'Local AIOS and Windows computer tools for JARVIS. For any broad screen question, call scan_desktop first so every monitor and normal overlay is visible; then capture or inspect the relevant window at higher detail. Prefer UI Automation selectors over coordinates, state an honest intent for every action, and verify the result from the surrounding monitor. Never capture continuously. For relative reminders, get the current time first and include a timezone offset. Never confirm send, post, delete, purchase, payment, account, or other irreversible actions without explicit user approval.',
      },
    });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: toolSchemas() } });
  if (method === 'tools/call') return callTool(id, params);
  if (method === 'resources/list') return send({ jsonrpc: '2.0', id, result: { resources: [] } });
  if (method === 'prompts/list') return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
  if (method === 'logging/setLevel') return send({ jsonrpc: '2.0', id, result: {} });
  if (id !== undefined) return sendError(id, -32601, `method not found: ${method}`);
  // Notifications, including notifications/initialized and cancellation, need no response.
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  let newline;
  while ((newline = inputBuffer.indexOf('\n')) !== -1) {
    const line = inputBuffer.slice(0, newline).trim();
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { continue; }
    handle(message).catch((e) => {
      if (message.id !== undefined) sendError(message.id, -32603, String((e && e.message) || e));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (e) => process.stderr.write('[jarvis-mcp] ' + String((e && e.stack) || e) + '\n'));
process.on('unhandledRejection', (e) => process.stderr.write('[jarvis-mcp] ' + String((e && e.stack) || e) + '\n'));
