'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const tempRoot = path.join(os.tmpdir(), `jarvis-state-smoke-${process.pid}`);
process.env.JARVIS_MEMORY_FILE = path.join(tempRoot, 'memory.json');
process.env.JARVIS_REMINDERS_FILE = path.join(tempRoot, 'reminders.json');
const tools = require('../lib/jarvis-tools');

(async () => {
  try {
    await fsp.mkdir(tempRoot, { recursive: true });
    const remembered = await tools.executeTool('remember_for_later', { text: 'Smoke-test preference', category: 'preference' });
    const recalled = await tools.executeTool('recall_jarvis_memory', { query: 'preference', limit: 5 });
    const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const created = await tools.executeTool('create_local_reminder', { title: 'Smoke-test reminder', dueAt });
    const listed = await tools.executeTool('list_local_reminders', {});
    const completed = await tools.executeTool('complete_local_reminder', { id: created.reminder && created.reminder.id });
    const forgotten = await tools.executeTool('forget_jarvis_memory', { id: remembered.memory && remembered.memory.id });
    const policy = tools.getToolPolicy('forget_jarvis_memory', {});
    const ok = remembered.ok && recalled.ok && recalled.memories.length === 1 && created.ok && listed.reminders.length === 1 && completed.ok && forgotten.ok && policy.requiresApproval;
    console.log(JSON.stringify({ ok, memoryCount: recalled.memories.length, reminderCount: listed.reminders.length, destructiveApproval: policy.requiresApproval }));
    if (!ok) process.exitCode = 1;
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    process.exitCode = 1;
  } finally {
    for (const file of ['memory.json', 'reminders.json']) {
      try { await fsp.unlink(path.join(tempRoot, file)); } catch { }
    }
    try { await fsp.rmdir(tempRoot); } catch { }
    setTimeout(() => process.exit(process.exitCode || 0), 10);
  }
})();
