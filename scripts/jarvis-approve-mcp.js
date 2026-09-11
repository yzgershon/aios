'use strict';
/*
 * Jarvis approval bridge — a minimal MCP stdio server with ONE tool.
 * Claude Code (the Jarvis brain) is spawned with
 *   --permission-prompt-tool mcp__approve__approval_prompt
 * so whenever a tool call isn't covered by allow rules, Claude calls
 * approval_prompt here. We forward the request to the AIOS server
 * (POST /api/jarvis/approval-request), which shows an Approve/Deny card in the
 * Jarvis UI and blocks until Yish answers (or times out → deny).
 *
 * Plain JSON-RPC 2.0 over stdio — no dependencies, node 18+ (global fetch).
 */

const AIOS = process.env.JARVIS_AIOS_URL || 'http://127.0.0.1:3000';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (line.trim()) handle(line);
  }
});

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'approve', version: '1.0.0' },
    } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{
      name: 'approval_prompt',
      description: 'Ask Yish to approve or deny a tool action via the Jarvis UI.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string' },
          input: { type: 'object' },
          tool_use_id: { type: 'string' },
        },
        required: ['tool_name', 'input'],
      },
    }] } });
  } else if (method === 'tools/call') {
    const args = (params && params.arguments) || {};
    let decision = { behavior: 'deny', message: 'approval bridge error' };
    try {
      const r = await fetch(AIOS + '/api/jarvis/approval-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool_name: args.tool_name || '', input: args.input || {} }),
        signal: AbortSignal.timeout(150000),
      });
      const j = await r.json();
      decision = j && j.allow
        ? { behavior: 'allow', updatedInput: args.input || {} }
        : { behavior: 'deny', message: (j && j.reason) || 'Yish denied this action.' };
    } catch (e) {
      decision = { behavior: 'deny', message: 'approval unavailable: ' + String((e && e.message) || e) };
    }
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
  } else if (id !== undefined) {
    // any other request → empty success so the client never hangs
    send({ jsonrpc: '2.0', id, result: {} });
  }
  // notifications (no id) are ignored
}
