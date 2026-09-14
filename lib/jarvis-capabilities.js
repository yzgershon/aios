'use strict';

const path = require('path');
const { AIOS_DATA_DIR, VAULT_DIR } = require('./config');
const { createWorkspace } = require('./jarvis-workspace');
const { createPersonal } = require('./jarvis-personal');

const personal = createPersonal({
  remindersFile: path.resolve(process.env.JARVIS_REMINDERS_FILE || path.join(AIOS_DATA_DIR, 'jarvis-reminders.json')),
  routinesFile: path.resolve(process.env.JARVIS_ROUTINES_FILE || path.join(AIOS_DATA_DIR, 'jarvis-routines.json')),
  notesRoot: path.resolve(process.env.JARVIS_NOTES_ROOT || path.join(VAULT_DIR, 'daily', 'jarvis')),
});
const workspace = createWorkspace({ root: process.env.JARVIS_PROJECTS_ROOT || 'C:/Dev', backupRoot: process.env.JARVIS_EDIT_BACKUPS || path.join(AIOS_DATA_DIR, 'jarvis-edit-backups') });
const string = { type: 'string' };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
const target = { title: { type: 'string', description: 'Exact or partial observed window title.' }, handle: { type: 'string', description: 'Observed numeric window handle, preferred.' }, allowSensitive: boolean };
function tool(name, description, properties = {}, required = []) { return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } }; }
const definitions = [
  tool('list_projects_local', 'Find actual development projects on this computer. Use before guessing a project path.'),
  tool('get_project_context', 'Read a project overview, Git working state, file inventory, and root instructions. Preserves uncommitted changes.', { project: string }, ['project']),
  tool('search_project_files', 'Search literal text or file names in a selected project. Returns file paths and line numbers. Skips dependencies, binary and likely secret files.', { project: string, query: string, pathFilter: string, limit: number }, ['project', 'query']),
  tool('read_project_file', 'Read numbered source lines plus a file hash. Read relevant AGENTS.md instructions before editing.', { project: string, path: string, startLine: number, lineCount: number }, ['project', 'path']),
  tool('edit_project_file', 'Make one exact, unique source replacement after reading the file. Requires the read hash, saves a backup, rejects stale reads. For a new file use create:true and replacement as content. Never commit or publish.', { project: string, path: string, expectedSha256: string, find: string, replacement: string, create: boolean }, ['project', 'path', 'replacement']),
  tool('get_day_briefing', 'Read local tasks, upcoming reminders, goals and source freshness together. Reports unavailable sources explicitly. Calendar and email are not connected.'),
  tool('snooze_local_reminder', 'Snooze one pending reminder for a number of minutes. Retains its repeat schedule.', { id: string, minutes: number }, ['id', 'minutes']),
  tool('list_jarvis_routines', 'List built-in and user-taught routines with their steps.'),
  tool('get_jarvis_routine', 'Read a named routine. When asked to run it, carry out its steps with current tools and normal approval rules.', { name: string }, ['name']),
  tool('save_jarvis_routine', 'Teach Jarvis a reusable named routine. Saving does not execute or schedule it. Only save user-requested instructions.', { name: string, steps: { type: 'array', items: string, minItems: 1, maxItems: 12 }, replace: boolean }, ['name', 'steps']),
  tool('create_personal_note', 'Save a dictated note, research report, draft, or checklist as a new markdown note in the SecondBrain vault. Include source URLs for research.', { title: string, content: string }, ['title', 'content']),
  tool('read_window_text', 'Read accessible document text from an observed desktop window. Useful for summarizing a page or document beyond tiny screenshots. Password controls are excluded.', { ...target, maxChars: number }, []),
  tool('set_ui_field', 'Set the value of one uniquely identified editable UI field, without pressing Enter or submitting. Requires a window handle and exact observed selector. Reads the value back to verify it.', { handle: string, automationId: string, name: string, text: string, intent: string, allowSensitive: boolean }, ['handle', 'text', 'intent']),
  tool('open_web_page', 'Open an HTTP or HTTPS page in the default browser. This confirms only that Windows accepted the launch; inspect the browser to verify loading.', { url: string }, ['url']),
];
const reads = ['list_projects_local', 'get_project_context', 'search_project_files', 'read_project_file', 'get_day_briefing', 'list_jarvis_routines', 'get_jarvis_routine'];
const writes = ['edit_project_file', 'snooze_local_reminder', 'save_jarvis_routine', 'create_personal_note'];
const screens = ['read_window_text'];
const controls = ['set_ui_field'];
const handled = new Set([...definitions.map((item) => item.function.name), 'list_local_reminders', 'create_local_reminder', 'complete_local_reminder', 'cancel_local_reminder']);

const catalogue = [
  { name: 'Computer copilot', description: 'Read a window, understand a page, fill a field, and verify the result.', examples: ['Summarize the document in my active window.', 'Help me complete the form on my screen.'] },
  { name: 'Personal assistant', description: 'Daily priorities, notes, recurring reminders, and routines you can teach me.', examples: ['Give me my daily briefing.', 'Show me the routines you can run.', 'Remind me every weekday at 9 AM to plan my day.'] },
  { name: 'Project builder', description: 'Inspect projects, find relevant code, and make small edits with backups.', examples: ['List my development projects.', 'Run a project checkup for JARVIS.'] },
  { name: 'Web research', description: 'Look up current information and save findings with source links.', examples: ['Research what changed in Node.js recently and save a note.'] },
];

async function execute(name, args, helpers) {
  switch (name) {
    case 'list_projects_local': return workspace.list();
    case 'get_project_context': return workspace.context(args);
    case 'search_project_files': return workspace.search(args);
    case 'read_project_file': return workspace.read(args);
    case 'edit_project_file': return workspace.edit(args);
    case 'list_local_reminders': return personal.reminders(args);
    case 'create_local_reminder': return personal.changeReminder('create', args);
    case 'complete_local_reminder': return personal.changeReminder('complete', args);
    case 'cancel_local_reminder': return personal.changeReminder('cancel', args);
    case 'snooze_local_reminder': return personal.changeReminder('snooze', args);
    case 'list_jarvis_routines': return personal.routines();
    case 'get_jarvis_routine': return personal.getRoutine(args);
    case 'save_jarvis_routine': return personal.saveRoutine(args);
    case 'create_personal_note': return personal.note(args);
    case 'get_day_briefing': {
      const sources = {};
      const calls = [['tasks', 'get_todos_snapshot'], ['goals', 'get_goals_snapshot'], ['freshness', 'get_freshness_and_brief_status'], ['reminders', 'list_local_reminders']];
      await Promise.all(calls.map(async ([key, toolName]) => { sources[key] = await helpers.executeTool(toolName, {}); }));
      return { ok: true, generatedAt: new Date().toISOString(), localTime: new Date().toString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, sources, unavailable: ['Calendar is not connected.', 'Email is not connected.'], instruction: 'Fresh read of local snapshots, not proof those snapshots are current. Preserve source timestamps and missing data.' };
    }
    case 'read_window_text': {
      await helpers.assertScreenAllowed('active_window', args.allowSensitive === true, args.title);
      const commandArgs = ['--max-chars', String(Math.max(500, Math.min(16000, Number(args.maxChars) || 10000)))];
      if (args.handle) commandArgs.push('--handle', String(args.handle));
      if (args.title) commandArgs.push('--title', String(args.title).slice(0, 240));
      if (args.allowSensitive === true) commandArgs.push('--allow-sensitive', 'true');
      return helpers.runComputer('read-text', commandArgs, 20000);
    }
    case 'set_ui_field': {
      if (!/^\d+$/.test(String(args.handle)) || (!args.automationId && !args.name)) throw new Error('A window handle and an exact observed selector are required.');
      const text = String(args.text ?? '');
      if (text.length > 10000) throw new Error('Field text is too long.');
      await helpers.assertScreenAllowed('active_window', args.allowSensitive === true);
      const commandArgs = ['--handle', String(args.handle), '--text-base64', Buffer.from(text, 'utf8').toString('base64')];
      if (args.automationId) commandArgs.push('--automation-id', String(args.automationId));
      if (args.name) commandArgs.push('--name', String(args.name));
      if (args.allowSensitive === true) commandArgs.push('--allow-sensitive', 'true');
      return helpers.runComputer('set-value', commandArgs);
    }
    case 'open_web_page': {
      const url = new URL(String(args.url));
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 4000) throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
      return helpers.runComputer('open-url', ['--url', url.href], 8000);
    }
    default: throw new Error('Unknown capability.');
  }
}
module.exports = { definitions, reads, writes, screens, controls, handled, execute, personal, catalogue };
