'use strict';

const { codexChatStream, getCodexStatus, resetCodexThread } = require('../lib/codex-brain');

(async () => {
  try {
    if (process.argv.includes('--reset')) await resetCodexThread();
    const prompt = process.argv.filter((arg) => arg !== '--reset').slice(2).join(' ') || 'Use the Jarvis current-time tool. Reply with one short sentence containing the current time.';
    let streamed = '';
    const result = await codexChatStream(prompt, [], (delta) => { streamed += delta; });
    const status = getCodexStatus();
    console.log(JSON.stringify({
      ok: true,
      reply: result.reply,
      streamedMatches: streamed.trim() === result.reply.trim(),
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      ttftMs: result.ttftMs,
      tool: status.lastTool,
      usage: result.usage,
      isolatedHome: status.isolatedHome,
    }));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String((e && e.message) || e), status: getCodexStatus() }));
    process.exitCode = 1;
  }
})();
