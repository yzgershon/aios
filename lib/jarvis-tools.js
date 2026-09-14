'use strict';

// Typed local tool pack shared by the Codex MCP bridge and deterministic fast
// paths. Actions stay narrow: no deletes, sends/posts, or spending, and
// file/process actions are constrained to user/project-safe locations.
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const fsp = fs.promises;
const { spawn } = require('child_process');
const { directIntent } = require('./jarvis-intent');
const capabilities = require('./jarvis-capabilities');

const {
  PROJECT_DIR,
  PORT,
  AIOS_DATA_DIR,
  METRICS_FILE,
  PORTFOLIO_FILE,
  PIPELINE_FILE,
  GOALS_FILE,
  TODOS_FILE,
  VAULT_DIR,
  CLAUDE_CWD,
} = require('./config');
const { writeJsonAtomic, toNumber, freshness } = require('./util');
const {
  getMetrics,
  normalizeMetrics,
  getPortfolio,
  computePortfolio,
  getNetWorth,
  getPipeline,
  defaultPipeline,
  normalizePipelineCard,
  PIPELINE_COLUMNS,
  PIPELINE_COLUMN_SET,
  PIPELINE_MAX_CARDS,
  getGoals,
  normalizeGoals,
  parseVault,
  getTodos,
} = require('./store');
const { getCrm } = require('./crm');
const { getLocalDemand, pollNextdoorLeads, readNextdoorStore, isNextdoorPolling } = require('./leads');
const { readBrief, generateBrief, isBriefGenerating } = require('./brief');
const { refreshSocial, readSocialCache } = require('./content');
const { quoteCache } = require('./market');

const TOOL_RESULT_LIMIT = 12000;
const FILE_WRITE_LIMIT = 120 * 1024;
const POWERSHELL = (() => {
  const ps = process.env.ComSpec ? path.join(path.dirname(process.env.ComSpec), 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
  return fs.existsSync(ps) ? ps : 'powershell.exe';
})();
const PWSH = (() => {
  const p = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return fs.existsSync(p) ? p : POWERSHELL;
})();
const CRM_WRITE = path.join(VAULT_DIR, 'scripts', 'crm-write.ps1');
const COMPUTER_EXE = path.resolve(process.env.JARVIS_COMPUTER_EXE || 'C:\\Dev\\JarvisComputer\\publish\\JarvisComputer.exe');
const SCREEN_DIR = path.join(AIOS_DATA_DIR, 'jarvis-screens');
const SCREEN_KEEP_FILES = Math.max(6, Math.min(100, Number(process.env.JARVIS_SCREEN_KEEP_FILES) || 30));
const SENSITIVE_WINDOW_RE = /(1password|bitwarden|keepass|lastpass|password|passkey|banking|bank account|wallet|credit card|payment|private key|seed phrase|authenticator)/i;
const JARVIS_MEMORY_FILE = path.resolve(process.env.JARVIS_MEMORY_FILE || path.join(AIOS_DATA_DIR, 'jarvis-memory.json'));
const JARVIS_REMINDERS_FILE = path.resolve(process.env.JARVIS_REMINDERS_FILE || path.join(AIOS_DATA_DIR, 'jarvis-reminders.json'));

const LOCAL_TOOL_SYSTEM_PROMPT = [
  'You have local AIOS tools. Use them when Yish asks to check, update, log, refresh, open, run, write, edit, or search local AIOS data.',
  'Final replies are spoken aloud: 1-2 short sentences, plain English, no markdown.',
  'Never use local tools to send emails, post publicly, spend money, delete files, or remove records. Say DEEP for those.',
  'For updates, make the smallest change that matches Yish exactly. If required details are missing, ask one short question instead of guessing.',
].join(' ');

const LOCAL_TOOL_RE = /(time|date|health|voice|ollama|model|goals?|todos?|to[- ]?do|tasks?|portfolio|quotes?|net\s*worth|pipeline|lead\s*board|crm|booking|customer|client|revenue|profit|expense|local\s*demand|nextdoor|vault|note|search|freshness|brief\s*(status|data)?|generate\s+brief|refresh|metrics|open|folder|file|powershell|script|run|launch|log|mark|write|edit|create|screen|window|desktop|click|type|hotkey|scroll|clipboard|remember|memory|forget|remind|reminder)/i;
const DEEP_ONLY_RE = /(calendar|gmail|email|inbox|send|sent|post\s+(to|on)|publish|tweet|buy|purchase|checkout|delete|remove|trash|weather|news|homework|assignment|essay|apush)/i;

function isLocalToolMessage(message) {
  const s = String(message || '');
  return LOCAL_TOOL_RE.test(s) && !DEEP_ONLY_RE.test(s);
}

function tool(name, description, properties = {}, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const LOCAL_TOOL_DEFINITIONS = [
  ...capabilities.definitions,
  tool('get_current_time', 'Get the current local date, time, timezone, and ISO timestamp.'),
  tool('get_aios_health', 'Check whether the AIOS local dashboard/server is healthy.'),
  tool('get_jarvis_voice_status', 'Check the JarvisVoice local wake-word/STT service status.'),
  tool('list_ollama_models', 'List locally installed Ollama models and basic metadata.'),
  tool('get_ollama_loaded_models', 'List currently loaded/running Ollama models from /api/ps.'),

  tool('get_goals_snapshot', 'Read AIOS savings goals.', {}, []),
  tool('update_goals', 'Replace AIOS savings goals with the provided goals array.', {
    goals: { type: 'array', items: { type: 'object' }, description: 'Goals with name, target, saved, optional deadline/icon/id.' },
  }, ['goals']),
  tool('get_todos_snapshot', 'Read AIOS to-do seed items.', {}, []),
  tool('update_todos', 'Replace AIOS to-do seed items with the provided items array.', {
    items: { type: 'array', items: { type: 'object' }, description: 'Todo items with title, optional tag/sub/id/due/done.' },
  }, ['items']),

  tool('get_portfolio_snapshot', 'Read portfolio, quotes already cached/live-refreshed by AIOS, and net worth.', {}, []),
  tool('update_portfolio', 'Replace AIOS portfolio holdings.', {
    currency: { type: 'string', description: 'Currency, usually USD.' },
    holdings: { type: 'array', items: { type: 'object' }, description: 'Holdings with ticker, shares, avgCost, price, optional name/prevClose/since.' },
  }, ['holdings']),
  tool('get_metrics_snapshot', 'Read manual AIOS metrics such as cash, savings, motorcycle value, and Instagram note.', {}, []),
  tool('update_metrics', 'Update manual AIOS metrics.', {
    assets: { type: 'object', description: 'Assets object with motorcycle, cash, savings, currency.' },
    instagram: { type: 'object', description: 'Instagram object with followers and note.' },
  }, []),

  tool('get_pipeline_snapshot', 'Read the AIOS pipeline/lead board.', {}, []),
  tool('update_pipeline', 'Replace the AIOS lead pipeline cards.', {
    cards: { type: 'array', items: { type: 'object' }, description: 'Cards with id, name, source, stage, note, area, link, optional value.' },
  }, ['cards']),
  tool('get_crm_summary', 'Read a compact YDdetailers CRM summary, including recent bookings and IDs.', {
    force: { type: 'boolean', description: 'Force a fresh CRM read instead of using cache.' },
  }, []),
  tool('crm_log_booking', 'Add a YDdetailers booking/job to the CRM. Does not delete or send anything.', {
    name: { type: 'string' },
    service: { type: 'string' },
    price: { type: 'number' },
    vehicle: { type: 'string' },
    date: { type: 'string', description: 'YYYY-MM-DD; default today.' },
    notes: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'pending', 'cancelled'] },
  }, ['service', 'price']),
  tool('crm_log_expense', 'Add a YDdetailers expense to the CRM.', {
    amount: { type: 'number' },
    category: { type: 'string', enum: ['equipment', 'supplies', 'marketing', 'other'] },
    desc: { type: 'string' },
    date: { type: 'string', description: 'YYYY-MM-DD; default today.' },
  }, ['amount']),
  tool('crm_set_booking_status', 'Set one booking status in the YDdetailers CRM. Requires a booking id.', {
    bookingId: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'pending', 'cancelled'] },
  }, ['bookingId', 'status']),

  tool('get_local_demand_snapshot', 'Read Nextdoor/manual local demand lead snapshot.', {}, []),
  tool('refresh_nextdoor_leads', 'Refresh Nextdoor leads from the configured inbox.', {}, []),
  tool('refresh_social_data', 'Start a social-data refresh for Instagram/TikTok/YouTube cache if configured.', {}, []),
  tool('get_freshness_and_brief_status', 'Read source freshness timestamps and current AIOS brief status.', {}, []),
  tool('generate_brief', 'Start AIOS brief generation in the background.', {}, []),

  tool('search_vault_notes', 'Search markdown notes in the SecondBrain vault.', {
    query: { type: 'string' },
    limit: { type: 'number', description: 'Max results, 1-12.' },
  }, ['query']),
  tool('read_vault_note', 'Read one markdown note from the SecondBrain vault by path or title.', {
    path: { type: 'string', description: 'Vault-relative path or note title.' },
    maxChars: { type: 'number', description: 'Maximum characters to return, default 6000.' },
  }, ['path']),
  tool('write_local_file', 'Create, overwrite, or append to a safe local text file or note. No deletes.', {
    path: { type: 'string', description: 'File path. Relative paths resolve under base.' },
    content: { type: 'string' },
    mode: { type: 'string', enum: ['create', 'overwrite', 'append'] },
    base: { type: 'string', enum: ['vault', 'dev', 'aios_data', 'desktop', 'documents', 'downloads'] },
    createDirs: { type: 'boolean' },
  }, ['path', 'content']),
  tool('open_local_path_or_app', 'Open a safe local file/folder or a common app.', {
    target: { type: 'string', description: 'Path or app name such as chrome, edge, notepad, calculator, explorer.' },
    base: { type: 'string', enum: ['vault', 'dev', 'aios_data', 'desktop', 'documents', 'downloads'] },
  }, ['target']),
  tool('run_powershell', 'Run a non-destructive PowerShell command or local script. Output is capped.', {
    command: { type: 'string' },
    cwd: { type: 'string', description: 'Optional working directory.' },
    timeoutMs: { type: 'number', description: 'Optional timeout, max 30000.' },
  }, ['command']),

  tool('get_computer_status', 'Read display geometry and the currently active Windows desktop window.', {}, []),
  tool('get_active_window', 'Read the currently active window title, process, handle, and screen bounds.', {}, []),
  tool('list_open_windows', 'List visible, non-minimized desktop windows.', {
    limit: { type: 'number', description: 'Maximum windows, 1-120.' },
  }, []),
  tool('scan_desktop', 'Survey the entire PC desktop. Returns the visible window inventory plus one readable image for every monitor, including normal layered overlays. Use this first for questions like "what is on my screen" or tasks that may span windows/monitors.', {
    maxWidth: { type: 'number', description: 'Maximum width per monitor image, default 2560.' },
    maxHeight: { type: 'number', description: 'Maximum height per monitor image, default 1800.' },
    allowSensitive: { type: 'boolean', description: 'Request explicit approval if a protected password or financial window is visible.' },
  }, []),
  tool('capture_screen', 'Capture one focused visual region: the active window, one monitor, or a compressed whole-desktop image. For a complete readable view of every monitor, use scan_desktop instead.', {
    scope: { type: 'string', enum: ['desktop', 'active_window', 'monitor'] },
    monitor: { type: 'number', description: 'Monitor index when scope is monitor.' },
    maxWidth: { type: 'number', description: 'Maximum image width, default 2048.' },
    maxHeight: { type: 'number', description: 'Maximum image height, default 1536.' },
    allowSensitive: { type: 'boolean', description: 'Request explicit approval to capture a protected password or financial window.' },
  }, []),
  tool('inspect_screen_ui', 'Inspect the active window through Windows UI Automation. Prefer this structured view before coordinate clicking.', {
    title: { type: 'string', description: 'Optional partial window title.' },
    handle: { type: 'string', description: 'Optional numeric window handle.' },
    maxItems: { type: 'number', description: 'Maximum returned elements, default 180.' },
    depth: { type: 'number', description: 'Maximum UI tree depth, default 8.' },
    allowSensitive: { type: 'boolean', description: 'Request explicit approval to inspect a protected password or financial window.' },
  }, []),
  tool('focus_window', 'Bring a visible window to the foreground.', {
    title: { type: 'string', description: 'Partial window title.' },
    handle: { type: 'string', description: 'Numeric window handle.' },
    intent: { type: 'string', description: 'Short reason for focusing this window.' },
    allowSensitive: { type: 'boolean', description: 'Request explicit approval to control a protected password or financial window.' },
  }, ['intent']),
  tool('click_screen', 'Click a physical screen point or a point from a prior capture. Never use this to confirm an irreversible action without explicit approval.', {
    x: { type: 'number' },
    y: { type: 'number' },
    captureId: { type: 'string', description: 'Optional capture id; x/y are image coordinates when provided.' },
    button: { type: 'string', enum: ['left', 'right', 'middle'] },
    count: { type: 'number', description: 'Click count, 1-3.' },
    intent: { type: 'string', description: 'What this click is intended to do.' },
    allowSensitive: { type: 'boolean', description: 'Request explicit approval to control a protected password or financial window.' },
    verify: { type: 'boolean', description: 'Capture the active window after the click; defaults true.' },
  }, ['x', 'y', 'intent']),
  tool('click_ui_element', 'Invoke or click a Windows UI Automation element by automation id or visible name. Prefer this over coordinates.', {
    automationId: { type: 'string' },
    name: { type: 'string' },
    controlType: { type: 'string', description: 'Optional type such as Button, TabItem, or MenuItem.' },
    contains: { type: 'boolean', description: 'Allow a partial name match; defaults true.' },
    title: { type: 'string', description: 'Optional partial window title.' },
    handle: { type: 'string', description: 'Optional numeric window handle.' },
    intent: { type: 'string', description: 'What invoking this element is intended to do.' },
    allowSensitive: { type: 'boolean', description: 'Request explicit approval to control a protected password or financial window.' },
    verify: { type: 'boolean', description: 'Capture the active window afterward; defaults true.' },
  }, ['intent']),
  tool('type_text', 'Type text into the currently focused desktop control using native Unicode input. This does not press Enter or submit.', {
    text: { type: 'string' },
    intervalMs: { type: 'number', description: 'Delay per character, 0-50 ms.' },
    intent: { type: 'string', description: 'Where and why the text is being typed.' },
    allowSensitive: { type: 'boolean', description: 'Request explicit approval to type in a protected password or financial window.' },
    verify: { type: 'boolean', description: 'Capture the active window afterward; defaults true.' },
  }, ['text', 'intent']),
  tool('send_hotkey', 'Send a Windows keyboard shortcut such as ctrl+l, alt+tab, or win+d.', {
    keys: { type: 'string', description: 'Plus-separated keys.' },
    intent: { type: 'string', description: 'What the shortcut is intended to do.' },
    allowSensitive: { type: 'boolean', description: 'Request explicit approval to control a protected password or financial window.' },
    verify: { type: 'boolean', description: 'Capture the active window afterward; defaults true.' },
  }, ['keys', 'intent']),
  tool('scroll_screen', 'Scroll at the current pointer or an optional physical screen point.', {
    steps: { type: 'number', description: 'Positive scrolls up, negative scrolls down; -20 to 20.' },
    x: { type: 'number' },
    y: { type: 'number' },
    intent: { type: 'string' },
    allowSensitive: { type: 'boolean', description: 'Request explicit approval to control a protected password or financial window.' },
    verify: { type: 'boolean', description: 'Capture the active window afterward; defaults true.' },
  }, ['steps', 'intent']),
  tool('read_clipboard', 'Read up to 20,000 characters of Windows clipboard text.', {}, []),
  tool('write_clipboard', 'Replace Windows clipboard text without typing or submitting it.', {
    text: { type: 'string' },
  }, ['text']),

  tool('recall_jarvis_memory', 'Recall durable facts and preferences Jarvis has been asked to remember.', {
    query: { type: 'string', description: 'Optional relevance query.' },
    limit: { type: 'number', description: 'Maximum results, 1-20.' },
  }, []),
  tool('remember_for_later', 'Store one durable fact, preference, person, project detail, or instruction for future Jarvis conversations.', {
    text: { type: 'string' },
    category: { type: 'string', enum: ['preference', 'person', 'project', 'business', 'school', 'routine', 'fact', 'other'] },
  }, ['text']),
  tool('forget_jarvis_memory', 'Permanently remove one durable Jarvis memory by id. This requires explicit approval.', {
    id: { type: 'string' },
  }, ['id']),
  tool('list_local_reminders', 'List pending or recent local Jarvis reminders.', {
    includeDone: { type: 'boolean' },
    limit: { type: 'number', description: 'Maximum reminders, 1-50.' },
  }, []),
  tool('create_local_reminder', 'Create a local reminder that Jarvis will surface and speak when due.', {
    title: { type: 'string' },
    dueAt: { type: 'string', description: 'ISO-8601 date/time with timezone offset.' },
    note: { type: 'string' },
    repeat: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly'], description: 'Repeat at the same local device time, including daylight-saving changes. Default none.' },
  }, ['title', 'dueAt']),
  tool('complete_local_reminder', 'Mark a local reminder complete by id.', {
    id: { type: 'string' },
  }, ['id']),
  tool('cancel_local_reminder', 'Cancel a local reminder by id. This requires explicit approval.', {
    id: { type: 'string' },
  }, ['id']),
];

const READ_TOOLS = new Set([
  ...capabilities.reads,
  'get_current_time', 'get_aios_health', 'get_jarvis_voice_status',
  'list_ollama_models', 'get_ollama_loaded_models', 'get_goals_snapshot',
  'get_todos_snapshot', 'get_portfolio_snapshot', 'get_metrics_snapshot',
  'get_pipeline_snapshot', 'get_crm_summary', 'get_local_demand_snapshot',
  'get_freshness_and_brief_status', 'search_vault_notes', 'read_vault_note',
  'recall_jarvis_memory', 'list_local_reminders',
]);
const WRITE_TOOLS = new Set([
  ...capabilities.writes,
  'update_goals', 'update_todos', 'update_portfolio', 'update_metrics',
  'update_pipeline', 'crm_log_booking', 'crm_log_expense',
  'crm_set_booking_status', 'refresh_nextdoor_leads', 'refresh_social_data',
  'generate_brief', 'write_local_file', 'write_clipboard',
  'remember_for_later', 'create_local_reminder', 'complete_local_reminder',
]);
const SCREEN_READ_TOOLS = new Set([
  ...capabilities.screens,
  'get_computer_status', 'get_active_window', 'list_open_windows',
  'scan_desktop', 'capture_screen', 'inspect_screen_ui', 'read_clipboard',
]);
const CONTROL_TOOLS = new Set([
  ...capabilities.controls,
  'focus_window', 'click_screen', 'click_ui_element', 'type_text',
  'send_hotkey', 'scroll_screen',
]);
const DESTRUCTIVE_TOOLS = new Set(['forget_jarvis_memory', 'cancel_local_reminder']);

function getToolPolicy(name, args = {}) {
  const toolName = String(name || '');
  if (DESTRUCTIVE_TOOLS.has(toolName)) return { risk: 'destructive', requiresApproval: true, reversible: false };
  if (READ_TOOLS.has(toolName)) return { risk: 'read', requiresApproval: false, reversible: true };
  if (SCREEN_READ_TOOLS.has(toolName)) return { risk: 'screen', requiresApproval: asBool(args.allowSensitive), reversible: true };
  if (WRITE_TOOLS.has(toolName)) return { risk: 'write', requiresApproval: false, reversible: true };
  if (CONTROL_TOOLS.has(toolName)) return { risk: 'control', requiresApproval: asBool(args.allowSensitive), reversible: true };
  if (toolName === 'open_local_path_or_app' || toolName === 'open_web_page') return { risk: 'open', requiresApproval: false, reversible: true };
  if (toolName === 'run_powershell') return { risk: 'execute', requiresApproval: false, reversible: true };
  return { risk: 'unknown', requiresApproval: true, reversible: false };
}

function summarizeToolCall(name, args = {}) {
  const toolName = String(name || 'unknown');
  if (toolName === 'run_powershell') return `Run PowerShell: ${cleanText(args.command, 180)}`;
  if (toolName === 'open_local_path_or_app') return `Open ${cleanText(args.target, 180)}`;
  if (toolName === 'write_local_file') return `${cleanText(args.mode || 'create', 20)} ${cleanText(args.path, 180)}`;
  if (toolName === 'capture_screen') return `Capture ${cleanText(args.scope || 'desktop', 40)}`;
  if (toolName === 'scan_desktop') return 'Survey every desktop monitor';
  if (toolName === 'inspect_screen_ui') return `Inspect ${cleanText(args.title || 'the active window', 180)}`;
  if (CONTROL_TOOLS.has(toolName)) return cleanText(args.intent || toolName.replace(/_/g, ' '), 220);
  if (toolName === 'write_clipboard') return `Replace clipboard with ${String(args.text || '').length} characters`;
  if (toolName === 'remember_for_later') return `Remember ${String(args.text || '').length} characters for later`;
  if (toolName === 'forget_jarvis_memory') return `Forget memory ${cleanText(args.id, 100)}`;
  if (toolName === 'create_local_reminder') return `Create reminder: ${cleanText(args.title, 180)}`;
  if (toolName === 'cancel_local_reminder') return `Cancel reminder ${cleanText(args.id, 100)}`;
  if (toolName.startsWith('crm_')) return toolName.replace(/_/g, ' ');
  return toolName.replace(/_/g, ' ');
}

function localToolsForMessage(message) {
  const s = String(message || '').toLowerCase();
  const names = new Set();
  const add = (...xs) => xs.forEach((x) => names.add(x));

  if (/\b(time|date|day)\b/.test(s)) add('get_current_time');
  if (/aios|server|dashboard|health|status/.test(s)) add('get_aios_health', 'get_freshness_and_brief_status');
  if (/voice|stt|wake|whisper|jarvisvoice/.test(s)) add('get_jarvis_voice_status');
  if (/ollama|models?|gemma|llama|loaded|running/.test(s)) add('list_ollama_models', 'get_ollama_loaded_models');
  if (/goals?/.test(s)) add('get_goals_snapshot', 'update_goals');
  if (/todos?|to[- ]?do|tasks?/.test(s)) add('get_todos_snapshot', 'update_todos');
  if (/portfolio|quotes?|stocks?|net\s*worth|money/.test(s)) add('get_portfolio_snapshot', 'update_portfolio', 'get_metrics_snapshot', 'update_metrics');
  if (/metrics|cash|savings|motorcycle|instagram/.test(s)) add('get_metrics_snapshot', 'update_metrics');
  if (/pipeline|lead\s*board/.test(s)) add('get_pipeline_snapshot', 'update_pipeline');
  if (/crm|booking|customer|client|revenue|profit|expense|log|mark/.test(s)) add('get_crm_summary', 'crm_log_booking', 'crm_log_expense', 'crm_set_booking_status');
  if (/nextdoor|local\s*demand|leads?/.test(s)) add('get_local_demand_snapshot', 'refresh_nextdoor_leads');
  if (/refresh/.test(s)) add('refresh_nextdoor_leads', 'refresh_social_data', 'generate_brief', 'get_freshness_and_brief_status');
  if (/social|instagram|tiktok|youtube/.test(s)) add('refresh_social_data');
  if (/brief|freshness|fresh/.test(s)) add('get_freshness_and_brief_status', 'generate_brief');
  if (/vault|note|search|read/.test(s)) add('search_vault_notes', 'read_vault_note');
  if (/write|edit|create|append|file|note/.test(s)) add('write_local_file', 'search_vault_notes', 'read_vault_note');
  if (/open|launch|folder/.test(s)) add('open_local_path_or_app');
  if (/powershell|script|command|terminal|run/.test(s)) add('run_powershell', 'open_local_path_or_app');
  if (/screen|desktop|display|see|look at|screenshot|monitor|overlay/.test(s)) add('get_computer_status', 'scan_desktop', 'capture_screen', 'inspect_screen_ui');
  if (/window|app|focus|foreground/.test(s)) add('get_active_window', 'list_open_windows', 'focus_window');
  if (/click|press|select|choose/.test(s)) add('inspect_screen_ui', 'click_ui_element', 'click_screen');
  if (/type|enter text|fill/.test(s)) add('type_text');
  if (/hotkey|shortcut|key|keyboard/.test(s)) add('send_hotkey');
  if (/scroll/.test(s)) add('scroll_screen');
  if (/clipboard|copy|paste/.test(s)) add('read_clipboard', 'write_clipboard');
  if (/remember|memory|forget/.test(s)) add('recall_jarvis_memory', 'remember_for_later', 'forget_jarvis_memory');
  if (/remind|reminder/.test(s)) add('list_local_reminders', 'create_local_reminder', 'complete_local_reminder', 'cancel_local_reminder', 'get_current_time');

  if (!names.size) return LOCAL_TOOL_DEFINITIONS.slice(0, 8);
  return LOCAL_TOOL_DEFINITIONS.filter((t) => names.has(t.function.name));
}
function cap(s, n) { return String(s == null ? '' : s).slice(0, n); }
function cleanText(s, n) { return cap(s, n).replace(/\0/g, ''); }
function today() { return new Date().toISOString().slice(0, 10); }
function asBool(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
function toJsonResult(value) {
  const text = JSON.stringify(value, null, 2);
  return text.length > TOOL_RESULT_LIMIT ? text.slice(0, TOOL_RESULT_LIMIT) + '\n...truncated' : text;
}
function ok(data = {}) { return { ok: true, ...data }; }
function err(e) { return { ok: false, error: String((e && e.message) || e).slice(0, 1000) }; }

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error((label || 'operation') + ' timed out')), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function runProcess(file, args, opts = {}) {
  const timeout = Math.max(1000, Math.min(Number(opts.timeoutMs) || 20000, 30000));
  const stdoutLimit = Math.max(1000, Math.min(Number(opts.stdoutLimit) || 10000, 200000));
  const stderrLimit = Math.max(1000, Math.min(Number(opts.stderrLimit) || 6000, 50000));
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(file, args, { cwd: opts.cwd || PROJECT_DIR, windowsHide: true, env: { ...process.env, ...(opts.env || {}) } });
    } catch (e) { return resolve(err(e)); }
    let out = '', er = '', killed = false;
    const timer = setTimeout(() => { killed = true; try { proc.kill(); } catch { /* ignore */ } }, timeout);
    proc.stdout.on('data', (d) => { if (out.length < stdoutLimit) out += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { if (er.length < stderrLimit) er += d.toString('utf8'); });
    proc.on('error', (e) => { clearTimeout(timer); resolve(err(e)); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !killed, code, timedOut: killed, stdout: out.trim().slice(0, stdoutLimit), stderr: er.trim().slice(0, stderrLimit) });
    });
  });
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function runComputer(command, args = [], timeoutMs = 20000) {
  if (!fs.existsSync(COMPUTER_EXE)) throw new Error('JarvisComputer helper is not installed');
  const processResult = await runProcess(COMPUTER_EXE, [command, ...args.map(String)], {
    timeoutMs,
    stdoutLimit: 180000,
    stderrLimit: 12000,
  });
  let parsed = null;
  try { parsed = JSON.parse(processResult.stdout || ''); } catch { /* handled below */ }
  if (!processResult.ok || !parsed || parsed.ok === false) {
    throw new Error((parsed && parsed.error) || processResult.stderr || `JarvisComputer ${command} failed`);
  }
  return parsed;
}

function protectedTitle(title) { return SENSITIVE_WINDOW_RE.test(String(title || '')); }

async function assertScreenAllowed(scope, allowSensitive, requestedTitle = '') {
  if (allowSensitive) return;
  if (protectedTitle(requestedTitle)) throw new Error('protected window requires allowSensitive and explicit approval');
  if (scope === 'desktop') {
    const snapshot = await runComputer('windows', ['--limit', '120']);
    const sensitive = (snapshot.windows || []).find((window) => protectedTitle(window && window.title));
    if (sensitive) throw new Error('a protected password or financial window is visible; capture requires explicit approval');
    return;
  }
  const status = await runComputer('status');
  if (protectedTitle(status.activeWindow && status.activeWindow.title)) {
    throw new Error('the active window is protected; screen access requires explicit approval');
  }
}

async function pruneScreens() {
  let entries;
  try { entries = await fsp.readdir(SCREEN_DIR, { withFileTypes: true }); }
  catch { return; }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^screen-[A-Za-z0-9-]+\.(?:png|json)$/.test(entry.name)) continue;
    const file = path.join(SCREEN_DIR, entry.name);
    try { rows.push({ file, mtime: (await fsp.stat(file)).mtimeMs }); } catch { }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  for (const row of rows.slice(SCREEN_KEEP_FILES)) {
    try { await fsp.unlink(row.file); } catch { }
  }
}

async function captureComputerScreen(args = {}) {
  const scope = ['desktop', 'active_window', 'monitor'].includes(String(args.scope || 'desktop'))
    ? String(args.scope || 'desktop') : 'desktop';
  const allowSensitive = asBool(args.allowSensitive);
  await assertScreenAllowed(scope, allowSensitive, args.title);
  await fsp.mkdir(SCREEN_DIR, { recursive: true });
  const captureId = `screen-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const output = path.join(SCREEN_DIR, captureId + '.png');
  const commandArgs = [
    '--scope', scope,
    '--output', output,
    '--max-width', String(Math.max(640, Math.min(toNumber(args.maxWidth, 2048), 4096))),
    '--max-height', String(Math.max(480, Math.min(toNumber(args.maxHeight, 1536), 4096))),
  ];
  if (scope === 'monitor') commandArgs.push('--monitor', String(Math.max(0, toNumber(args.monitor, 0))));
  if (args.handle) commandArgs.push('--handle', cleanText(args.handle, 40));
  if (args.title) commandArgs.push('--title', cleanText(args.title, 240));
  const captured = await runComputer('capture', commandArgs, 30000);
  const result = { ...captured, captureId, capturedAt: new Date().toISOString() };
  await fsp.writeFile(path.join(SCREEN_DIR, captureId + '.json'), JSON.stringify(result), 'utf8');
  await pruneScreens();
  return result;
}

async function scanDesktop(args = {}) {
  const allowSensitive = asBool(args.allowSensitive);
  await assertScreenAllowed('desktop', allowSensitive);
  const status = await runComputer('status');
  const windows = await runComputer('windows', ['--limit', '120']);
  const captures = [];
  const maxWidth = Math.max(1280, Math.min(toNumber(args.maxWidth, 2560), 4096));
  const maxHeight = Math.max(720, Math.min(toNumber(args.maxHeight, 1800), 4096));
  for (let monitor = 0; monitor < (status.screens || []).length; monitor++) {
    const capture = await captureComputerScreen({
      scope: 'monitor', monitor, maxWidth, maxHeight, allowSensitive: true,
    });
    captures.push({ ...capture, monitor, screen: status.screens[monitor] });
  }
  return ok({
    activeWindow: status.activeWindow || null,
    virtualScreen: status.virtualScreen,
    windows: windows.windows || [],
    captures,
  });
}

async function readCapture(captureId) {
  const id = cleanText(captureId, 100);
  if (!/^screen-[A-Za-z0-9-]+$/.test(id)) throw new Error('invalid captureId');
  const metadata = JSON.parse(await fsp.readFile(path.join(SCREEN_DIR, id + '.json'), 'utf8'));
  if (!metadata.bounds || !metadata.image) throw new Error('capture metadata is incomplete');
  return metadata;
}

async function clickPoint(args) {
  let x = toNumber(args.x, NaN);
  let y = toNumber(args.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y are required');
  if (args.captureId) {
    const capture = await readCapture(args.captureId);
    if (x < 0 || y < 0 || x > capture.image.width || y > capture.image.height) throw new Error('point is outside the captured image');
    x = Math.round(capture.bounds.x + x * capture.scaleX);
    y = Math.round(capture.bounds.y + y * capture.scaleY);
  }
  return { x: Math.round(x), y: Math.round(y) };
}

async function verifyComputerAction(result, args) {
  if (args.verify === false || args.verify === 'false') return result;
  await wait(300);
  try {
    const status = await runComputer('status');
    const active = status.activeWindow && status.activeWindow.bounds;
    const centerX = active ? active.x + active.width / 2 : 0;
    const centerY = active ? active.y + active.height / 2 : 0;
    const monitor = Math.max(0, (status.screens || []).findIndex((screen) => {
      const b = screen.bounds || {};
      return centerX >= b.x && centerX < b.x + b.width && centerY >= b.y && centerY < b.y + b.height;
    }));
    const verification = await captureComputerScreen({
      scope: 'monitor', monitor,
      maxWidth: 2560,
      maxHeight: 1800,
      allowSensitive: args.allowSensitive,
    });
    return { ...result, verification, screenshotPath: verification.path };
  } catch (e) {
    return { ...result, verification: { ok: false, error: String((e && e.message) || e).slice(0, 500) } };
  }
}

function addOption(list, key, value) {
  if (value === undefined || value === null || value === '') return;
  list.push('--' + key, String(value));
}

async function readJsonStore(file, fallback) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

async function memoryStore() {
  const store = await readJsonStore(JARVIS_MEMORY_FILE, { entries: [] });
  store.entries = Array.isArray(store.entries) ? store.entries.filter((entry) => entry && entry.id && entry.text).slice(-200) : [];
  return store;
}

async function reminderStore() {
  const store = await readJsonStore(JARVIS_REMINDERS_FILE, { reminders: [] });
  store.reminders = Array.isArray(store.reminders) ? store.reminders.filter((item) => item && item.id && item.title).slice(-500) : [];
  return store;
}

function newLocalId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function rankMemories(entries, query) {
  const q = cleanText(query, 240).toLowerCase().trim();
  const terms = q.split(/\s+/).filter((term) => term.length > 1);
  return entries.map((entry) => {
    const haystack = `${entry.category || ''} ${entry.text || ''}`.toLowerCase();
    let score = terms.length ? terms.reduce((sum, term) => sum + (haystack.includes(term) ? 10 : 0), 0) : 1;
    if (q && haystack.includes(q)) score += 30;
    if (entry.category === 'preference' || entry.category === 'person') score += 2;
    return { entry, score };
  }).filter((row) => !terms.length || row.score > 0)
    .sort((a, b) => b.score - a.score || String(b.entry.createdAt || '').localeCompare(String(a.entry.createdAt || '')))
    .map((row) => row.entry);
}

async function fetchJson(url, timeoutMs = 4000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(url + ' returned ' + r.status);
  return j;
}

function crmBookingSummary(bookings) {
  const rows = (Array.isArray(bookings) ? bookings : []).slice();
  rows.sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
  const completed = rows.filter((b) => String(b.status || '').toLowerCase() === 'completed');
  const totalRevenue = completed.reduce((sum, b) => sum + toNumber(b.price != null ? b.price : b.basePrice, 0), 0);
  const pending = rows.filter((b) => !b.status || String(b.status).toLowerCase() === 'pending');
  return {
    counts: { bookings: rows.length, completed: completed.length, pending: pending.length },
    totalRevenue,
    recentBookings: rows.slice(0, 18).map((b) => ({
      id: b.id,
      name: cap(b.name || b.customer || '', 80),
      service: cap(b.service || '', 80),
      price: toNumber(b.price != null ? b.price : b.basePrice, 0),
      status: cap(b.status || '', 20),
      date: cap(b.date || b.displayDate || b.createdAt || '', 40),
      vehicle: cap(b.vehicle || '', 80),
      notes: cap(b.notes || '', 120),
    })),
  };
}

async function getOllamaBase() {
  return (process.env.JARVIS_FAST_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
}

function normalizeTodoItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, 100).map((it, i) => {
    it = it || {};
    const title = cleanText(it.title || it.name || '', 140).trim();
    if (!title) return null;
    const out = {
      id: cleanText(it.id || ('todo-' + (i + 1)), 48),
      tag: cleanText(it.tag || 'me', 24),
      title,
      sub: cleanText(it.sub || it.note || '', 240),
    };
    if (it.due) out.due = cleanText(it.due, 40);
    if (it.done != null) out.done = !!it.done;
    return out;
  }).filter(Boolean);
}

function normalizePortfolioHoldings(holdings, prevMap = {}) {
  return (Array.isArray(holdings) ? holdings : []).slice(0, 100).map((h) => {
    h = h || {};
    const ticker = cleanText(h.ticker || '', 12).toUpperCase().replace(/[^A-Z0-9.^=-]/g, '');
    if (!ticker) return null;
    const row = {
      ticker,
      name: cleanText(h.name || '', 40),
      shares: toNumber(h.shares, 0),
      avgCost: toNumber(h.avgCost, 0),
      price: toNumber(h.price, 0),
    };
    if (h.prevClose != null && h.prevClose !== '') row.prevClose = toNumber(h.prevClose, 0);
    else if (prevMap[ticker] != null) row.prevClose = prevMap[ticker];
    if (typeof h.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.since)) row.since = h.since;
    return row;
  }).filter(Boolean);
}

async function readPrevPortfolioMap() {
  try {
    const cur = JSON.parse(await fsp.readFile(PORTFOLIO_FILE, 'utf8'));
    const out = {};
    for (const h of (cur.holdings || [])) {
      const t = String(h.ticker || '').toUpperCase().slice(0, 12);
      if (t && h.prevClose != null) out[t] = toNumber(h.prevClose, 0);
    }
    return out;
  } catch { return {}; }
}

function rootForBase(base) {
  const home = os.homedir();
  const roots = {
    vault: VAULT_DIR,
    dev: 'C:\\Dev',
    aios_data: AIOS_DATA_DIR,
    desktop: path.join(home, 'Desktop'),
    documents: path.join(home, 'Documents'),
    downloads: path.join(home, 'Downloads'),
  };
  return roots[String(base || 'vault').toLowerCase()] || VAULT_DIR;
}

function isInside(child, parent) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function safeWriteRoots() {
  const home = os.homedir();
  const roots = [
    PROJECT_DIR,
    VAULT_DIR,
    AIOS_DATA_DIR,
    'C:\\Dev',
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
  ].filter(Boolean);
  return Array.from(new Set(roots.map((r) => path.resolve(r))));
}

function assertSafePath(target, base, forWrite) {
  let raw = String(target || '').trim();
  if (!raw) throw new Error('missing path');
  raw = raw.replace(/^~(?=$|[\\/])/, os.homedir());
  raw = raw.replace(/%USERPROFILE%/ig, os.homedir());
  const root = rootForBase(base);
  const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(root, raw));
  const allowed = safeWriteRoots();
  if (!allowed.some((r) => isInside(resolved, r))) throw new Error('path is outside Jarvis safe roots');
  const lower = resolved.toLowerCase();
  if (/(^|[\\/])(\.git|\.ssh|\.aws|\.azure)([\\/]|$)/i.test(resolved)) throw new Error('refusing secret/system path');
  if (/(^|[\\/])\.env(\.|$)/i.test(resolved) || /(secret|token|credential|creds|password)/i.test(path.basename(resolved))) {
    throw new Error('refusing likely secret file');
  }
  if (forWrite) {
    const ext = path.extname(lower);
    const allowedExt = new Set(['.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.html', '.css', '.js', '.ts', '.ps1']);
    if (ext && !allowedExt.has(ext)) throw new Error('only safe text file extensions can be written');
  }
  return resolved;
}

function resolveVaultNote(input) {
  const q = String(input || '').trim();
  if (!q) throw new Error('missing note path');
  const graph = parseVault();
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const exact = nodes.find((n) => String(n.id).toLowerCase() === q.replace(/\\/g, '/').toLowerCase());
  const byTitle = exact || nodes.find((n) => String(n.title).toLowerCase() === q.replace(/\.md$/i, '').toLowerCase());
  const rel = byTitle ? byTitle.id : q;
  const resolved = path.resolve(VAULT_DIR, rel);
  if (!isInside(resolved, VAULT_DIR) || !resolved.toLowerCase().endsWith('.md')) throw new Error('not a vault markdown note');
  return { rel: path.relative(VAULT_DIR, resolved).replace(/\\/g, '/'), resolved };
}

function denyDangerousCommand(command) {
  const cmd = String(command || '');
  if (!cmd.trim()) throw new Error('empty command');
  if (cmd.length > 2500) throw new Error('command too long');
  const bad = [
    /\b(Remove-Item|Clear-Content|Clear-RecycleBin|rm|del|erase|rmdir|rd)\b/i,
    /\b(format|shutdown|restart-computer|stop-computer|bcdedit|diskpart)\b/i,
    /\bgit\s+(push|reset\s+--hard|clean\s+-\w*f)\b/i,
    /\bnpm\s+publish\b/i,
    /\bgh\s+(release|pr)\s+(create|merge)\b/i,
    /\bSet-ExecutionPolicy\b/i,
    /\bInvoke-RestMethod\b.*\b(Method|X)\s*(Post|Put|Delete)\b/i,
    /\bInvoke-WebRequest\b.*\b(Method|X)\s*(Post|Put|Delete)\b/i,
    /\bcurl\b.*-X\s*(POST|PUT|DELETE)\b/i,
    /\bcrm-delete\b/i,
  ];
  if (bad.some((re) => re.test(cmd))) throw new Error('refusing destructive or external-write command');
}

function safeCwd(cwd) {
  if (!cwd) return CLAUDE_CWD || PROJECT_DIR;
  const resolved = assertSafePath(cwd, 'dev', false);
  try {
    if (!fs.statSync(resolved).isDirectory()) throw new Error('cwd is not a directory');
  } catch { throw new Error('cwd does not exist'); }
  return resolved;
}

function psArgList(args) {
  const out = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CRM_WRITE];
  for (const [k, v] of args) {
    if (v === undefined || v === null || v === '') continue;
    if (v === true) out.push(k);
    else out.push(k, String(v));
  }
  return out;
}

async function executeTool(name, args = {}) {
  try {
    if (capabilities.handled.has(name)) return await capabilities.execute(name, args, { executeTool, assertScreenAllowed, runComputer, verifyComputerAction });
    switch (name) {
      case 'get_current_time': {
        const now = new Date();
        return ok({
          iso: now.toISOString(),
          local: now.toString(),
          date: now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
          time: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      }
      case 'get_aios_health': {
        const health = await fetchJson(`http://127.0.0.1:${PORT}/api/health`, 2500);
        return ok({ health, projectDir: PROJECT_DIR, dataDir: AIOS_DATA_DIR });
      }
      case 'get_jarvis_voice_status': {
        const voiceUrl = process.env.JARVIS_VOICE_URL || 'http://127.0.0.1:3100';
        const health = await fetchJson(voiceUrl.replace(/\/$/, '') + '/health', 2500);
        return ok({ voice: health });
      }
      case 'list_ollama_models': {
        const base = await getOllamaBase();
        const tags = await fetchJson(base + '/api/tags', 5000);
        return ok({ models: tags.models || [] });
      }
      case 'get_ollama_loaded_models': {
        const base = await getOllamaBase();
        const ps = await fetchJson(base + '/api/ps', 5000);
        return ok({ models: ps.models || [] });
      }
      case 'get_goals_snapshot':
        return ok({ data: await getGoals() });
      case 'update_goals': {
        const data = normalizeGoals({ goals: args.goals });
        await writeJsonAtomic(GOALS_FILE, data);
        return ok({ saved: data });
      }
      case 'get_todos_snapshot':
        return ok({ data: await getTodos() });
      case 'update_todos': {
        const data = { updatedAt: new Date().toISOString(), items: normalizeTodoItems(args.items) };
        await writeJsonAtomic(TODOS_FILE, data);
        return ok({ saved: data });
      }
      case 'get_portfolio_snapshot': {
        const [portfolio, netWorth] = await Promise.all([getPortfolio(), getNetWorth([])]);
        const quotes = {};
        for (const p of (portfolio.positions || [])) {
          if (quoteCache[p.ticker]) quotes[p.ticker] = quoteCache[p.ticker].data;
        }
        return ok({ portfolio, netWorth, quotes });
      }
      case 'update_portfolio': {
        const prevMap = await readPrevPortfolioMap();
        const out = {
          currency: cleanText(args.currency || 'USD', 8),
          holdings: normalizePortfolioHoldings(args.holdings, prevMap),
          updatedAt: new Date().toISOString(),
        };
        await writeJsonAtomic(PORTFOLIO_FILE, out);
        return ok({ saved: computePortfolio(out) });
      }
      case 'get_metrics_snapshot':
        return ok({ metrics: await getMetrics([]) });
      case 'update_metrics': {
        const data = normalizeMetrics({ assets: args.assets || {}, instagram: args.instagram || {}, updatedAt: new Date().toISOString() });
        data.updatedAt = new Date().toISOString();
        await writeJsonAtomic(METRICS_FILE, data);
        return ok({ saved: data });
      }
      case 'get_pipeline_snapshot':
        return ok({ pipeline: await getPipeline() });
      case 'update_pipeline': {
        const cards = (Array.isArray(args.cards) ? args.cards : []).slice(0, PIPELINE_MAX_CARDS);
        for (const c of cards) {
          if (!c || !PIPELINE_COLUMN_SET.has(c.stage)) throw new Error('invalid pipeline card stage');
        }
        const state = { columns: PIPELINE_COLUMNS.slice(), cards: cards.map(normalizePipelineCard) };
        await writeJsonAtomic(PIPELINE_FILE, state);
        return ok({ saved: state });
      }
      case 'get_crm_summary': {
        const crm = await getCrm(asBool(args.force));
        return ok({ available: crm.available, fetchedAt: crm.fetchedAt, clients: (crm.clients || []).length, ...crmBookingSummary(crm.bookings || []) });
      }
      case 'crm_log_booking': {
        if (!fs.existsSync(CRM_WRITE)) throw new Error('crm-write.ps1 not found');
        const price = toNumber(args.price, NaN);
        if (!Number.isFinite(price)) throw new Error('price is required');
        const service = cleanText(args.service, 120).trim();
        if (!service) throw new Error('service is required');
        return await runProcess(PWSH, psArgList([
          ['-AddBooking', true],
          ['-Name', cleanText(args.name, 120)],
          ['-Service', service],
          ['-Price', price],
          ['-Vehicle', cleanText(args.vehicle, 120)],
          ['-Date', cleanText(args.date || today(), 20)],
          ['-Notes', cleanText(args.notes, 300)],
          ['-Status', cleanText(args.status || 'completed', 20)],
        ]), { cwd: VAULT_DIR, timeoutMs: 30000 });
      }
      case 'crm_log_expense': {
        if (!fs.existsSync(CRM_WRITE)) throw new Error('crm-write.ps1 not found');
        const amount = toNumber(args.amount, NaN);
        if (!Number.isFinite(amount)) throw new Error('amount is required');
        return await runProcess(PWSH, psArgList([
          ['-AddExpense', true],
          ['-Amount', amount],
          ['-Category', cleanText(args.category || 'other', 20)],
          ['-Desc', cleanText(args.desc, 220)],
          ['-ExpenseDate', cleanText(args.date || today(), 20)],
        ]), { cwd: VAULT_DIR, timeoutMs: 30000 });
      }
      case 'crm_set_booking_status': {
        if (!fs.existsSync(CRM_WRITE)) throw new Error('crm-write.ps1 not found');
        const bookingId = cleanText(args.bookingId || args.id, 120).trim();
        if (!bookingId) throw new Error('bookingId is required');
        return await runProcess(PWSH, psArgList([
          ['-SetStatus', true],
          ['-BookingId', bookingId],
          ['-NewStatus', cleanText(args.status || args.newStatus, 20)],
        ]), { cwd: VAULT_DIR, timeoutMs: 30000 });
      }
      case 'get_local_demand_snapshot':
        return ok({ localDemand: await getLocalDemand() });
      case 'refresh_nextdoor_leads': {
        if (isNextdoorPolling()) return ok({ polling: true });
        const result = await withTimeout(pollNextdoorLeads(true), 15000, 'Nextdoor refresh').catch((e) => ({ timedOut: true, error: e.message }));
        return ok({ refresh: result });
      }
      case 'refresh_social_data': {
        refreshSocial().catch(() => {});
        return ok({ started: true });
      }
      case 'get_freshness_and_brief_status': {
        const [social, nd, brief] = await Promise.all([readSocialCache().catch(() => null), readNextdoorStore().catch(() => null), readBrief().catch(() => null)]);
        return ok({
          freshness,
          socialFetchedAt: social && social.fetchedAt,
          socialLastErrorAt: social && social.lastErrorAt,
          nextdoorLastPolledAt: nd && nd.lastPolledAt,
          nextdoorLastError: nd && nd.lastError,
          briefGenerating: isBriefGenerating(),
          brief,
        });
      }
      case 'generate_brief': {
        if (isBriefGenerating()) return ok({ status: 'already_generating' });
        generateBrief().catch(() => {});
        return ok({ status: 'started' });
      }
      case 'search_vault_notes': {
        const q = cleanText(args.query, 200).trim().toLowerCase();
        if (!q) throw new Error('query is required');
        const limit = Math.max(1, Math.min(toNumber(args.limit, 8), 12));
        const graph = parseVault();
        const terms = q.split(/\s+/).filter(Boolean);
        const hits = [];
        for (const n of (graph.nodes || []).slice(0, 800)) {
          let score = 0;
          const hay = (String(n.title || '') + ' ' + String(n.folder || '') + ' ' + String(n.id || '')).toLowerCase();
          if (terms.every((t) => hay.includes(t))) score += 30;
          let snippet = '';
          if (score < 30) {
            try {
              const text = await fsp.readFile(path.join(VAULT_DIR, n.id), 'utf8');
              const low = text.toLowerCase();
              const i = low.indexOf(q);
              if (i >= 0 || terms.every((t) => low.includes(t))) {
                score += 10;
                const at = i >= 0 ? i : Math.max(0, low.indexOf(terms[0]));
                snippet = text.slice(Math.max(0, at - 80), at + 220).replace(/\s+/g, ' ').trim();
              }
            } catch { /* skip unreadable note */ }
          }
          if (score > 0) hits.push({ score, path: n.id, title: n.title, folder: n.folder, snippet });
        }
        hits.sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)));
        return ok({ query: q, results: hits.slice(0, limit) });
      }
      case 'read_vault_note': {
        const note = resolveVaultNote(args.path);
        const maxChars = Math.max(500, Math.min(toNumber(args.maxChars, 6000), 20000));
        const content = await fsp.readFile(note.resolved, 'utf8');
        return ok({ path: note.rel, title: path.basename(note.rel, '.md'), content: content.slice(0, maxChars), truncated: content.length > maxChars });
      }
      case 'write_local_file': {
        const target = assertSafePath(args.path, args.base || 'vault', true);
        const mode = ['create', 'overwrite', 'append'].includes(String(args.mode || 'create')) ? String(args.mode || 'create') : 'create';
        const content = String(args.content || '');
        if (Buffer.byteLength(content, 'utf8') > FILE_WRITE_LIMIT) throw new Error('content too large');
        if (asBool(args.createDirs)) await fsp.mkdir(path.dirname(target), { recursive: true });
        if (mode === 'create') {
          await fsp.writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
        } else if (mode === 'append') {
          await fsp.appendFile(target, content, 'utf8');
        } else {
          await fsp.writeFile(target, content, 'utf8');
        }
        return ok({ path: target, mode, bytes: Buffer.byteLength(content, 'utf8') });
      }
      case 'open_local_path_or_app': {
        const targetRaw = cleanText(args.target, 500).trim();
        if (!targetRaw) throw new Error('target is required');
        const appMap = {
          chrome: 'chrome.exe',
          edge: 'msedge.exe',
          notepad: 'notepad.exe',
          calculator: 'calc.exe',
          calc: 'calc.exe',
          explorer: 'explorer.exe',
        };
        const app = appMap[targetRaw.toLowerCase()];
        if (app) return await runProcess(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process $env:JV_OPEN_TARGET'], { env: { JV_OPEN_TARGET: app }, timeoutMs: 8000 });
        const target = assertSafePath(targetRaw, args.base || 'vault', false);
        if (!fs.existsSync(target)) throw new Error('target does not exist');
        return await runProcess(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:JV_OPEN_TARGET'], { env: { JV_OPEN_TARGET: target }, timeoutMs: 8000 });
      }
      case 'run_powershell': {
        const command = String(args.command || '');
        denyDangerousCommand(command);
        const cwd = safeCwd(args.cwd);
        return await runProcess(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd, timeoutMs: Math.min(toNumber(args.timeoutMs, 20000), 30000) });
      }
      case 'get_computer_status':
        return await runComputer('status');
      case 'get_active_window': {
        const status = await runComputer('status');
        return ok({ activeWindow: status.activeWindow || null, virtualScreen: status.virtualScreen, screens: status.screens || [] });
      }
      case 'list_open_windows':
        return await runComputer('windows', ['--limit', String(Math.max(1, Math.min(toNumber(args.limit, 80), 120)))]);
      case 'scan_desktop':
        return await scanDesktop(args);
      case 'capture_screen':
        return await captureComputerScreen(args);
      case 'inspect_screen_ui': {
        await assertScreenAllowed('active_window', asBool(args.allowSensitive), args.title);
        const commandArgs = [];
        addOption(commandArgs, 'title', cleanText(args.title, 240));
        addOption(commandArgs, 'handle', cleanText(args.handle, 40));
        addOption(commandArgs, 'max', Math.max(10, Math.min(toNumber(args.maxItems, 180), 400)));
        addOption(commandArgs, 'depth', Math.max(1, Math.min(toNumber(args.depth, 8), 16)));
        return await runComputer('inspect', commandArgs, 30000);
      }
      case 'focus_window': {
        await assertScreenAllowed('active_window', asBool(args.allowSensitive), args.title);
        const commandArgs = [];
        addOption(commandArgs, 'title', cleanText(args.title, 240));
        addOption(commandArgs, 'handle', cleanText(args.handle, 40));
        if (!commandArgs.length) throw new Error('title or handle is required');
        return await verifyComputerAction(await runComputer('focus', commandArgs), args);
      }
      case 'click_screen': {
        await assertScreenAllowed('active_window', asBool(args.allowSensitive));
        const point = await clickPoint(args);
        const commandArgs = ['--x', String(point.x), '--y', String(point.y)];
        addOption(commandArgs, 'button', ['left', 'right', 'middle'].includes(String(args.button)) ? args.button : 'left');
        addOption(commandArgs, 'count', Math.max(1, Math.min(toNumber(args.count, 1), 3)));
        return await verifyComputerAction(await runComputer('click', commandArgs), args);
      }
      case 'click_ui_element': {
        await assertScreenAllowed('active_window', asBool(args.allowSensitive), args.title);
        const commandArgs = [];
        addOption(commandArgs, 'automation-id', cleanText(args.automationId, 240));
        addOption(commandArgs, 'name', cleanText(args.name, 240));
        addOption(commandArgs, 'control-type', cleanText(args.controlType, 60));
        addOption(commandArgs, 'contains', args.contains === false ? 'false' : 'true');
        addOption(commandArgs, 'title', cleanText(args.title, 240));
        addOption(commandArgs, 'handle', cleanText(args.handle, 40));
        if (!args.automationId && !args.name) throw new Error('automationId or name is required');
        return await verifyComputerAction(await runComputer('click-element', commandArgs, 30000), args);
      }
      case 'type_text': {
        await assertScreenAllowed('active_window', asBool(args.allowSensitive));
        const text = String(args.text || '');
        if (!text || text.length > 10000) throw new Error('text must be 1-10000 characters');
        const commandArgs = [
          '--text-base64', Buffer.from(text, 'utf8').toString('base64'),
          '--interval', String(Math.max(0, Math.min(toNumber(args.intervalMs, 2), 50))),
        ];
        return await verifyComputerAction(await runComputer('type', commandArgs, 30000), args);
      }
      case 'send_hotkey': {
        await assertScreenAllowed('active_window', asBool(args.allowSensitive));
        const keys = cleanText(args.keys, 100).trim();
        if (!keys) throw new Error('keys are required');
        return await verifyComputerAction(await runComputer('hotkey', ['--keys', keys]), args);
      }
      case 'scroll_screen': {
        await assertScreenAllowed('active_window', asBool(args.allowSensitive));
        const commandArgs = ['--steps', String(Math.max(-20, Math.min(toNumber(args.steps, -3), 20)))];
        if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
          commandArgs.push('--x', String(Math.round(Number(args.x))), '--y', String(Math.round(Number(args.y))));
        }
        return await verifyComputerAction(await runComputer('scroll', commandArgs), args);
      }
      case 'read_clipboard':
        return await runComputer('clipboard-get');
      case 'write_clipboard': {
        const text = String(args.text || '');
        if (text.length > 100000) throw new Error('clipboard text is too long');
        return await runComputer('clipboard-set', ['--text-base64', Buffer.from(text, 'utf8').toString('base64')]);
      }
      case 'recall_jarvis_memory': {
        const store = await memoryStore();
        const limit = Math.max(1, Math.min(toNumber(args.limit, 12), 20));
        return ok({ query: cleanText(args.query, 240), memories: rankMemories(store.entries, args.query).slice(0, limit) });
      }
      case 'remember_for_later': {
        const text = cleanText(args.text, 1000).replace(/\s+/g, ' ').trim();
        if (!text) throw new Error('memory text is required');
        const allowed = new Set(['preference', 'person', 'project', 'business', 'school', 'routine', 'fact', 'other']);
        const category = allowed.has(String(args.category)) ? String(args.category) : 'fact';
        const store = await memoryStore();
        const existing = store.entries.find((entry) => String(entry.text).toLowerCase() === text.toLowerCase());
        if (existing) return ok({ memory: existing, duplicate: true });
        const memory = { id: newLocalId('mem'), category, text, createdAt: new Date().toISOString() };
        store.entries.push(memory);
        store.entries = store.entries.slice(-200);
        store.updatedAt = new Date().toISOString();
        await writeJsonAtomic(JARVIS_MEMORY_FILE, store);
        return ok({ memory });
      }
      case 'forget_jarvis_memory': {
        const id = cleanText(args.id, 100).trim();
        const store = await memoryStore();
        const before = store.entries.length;
        store.entries = store.entries.filter((entry) => entry.id !== id);
        if (store.entries.length === before) throw new Error('memory not found');
        store.updatedAt = new Date().toISOString();
        await writeJsonAtomic(JARVIS_MEMORY_FILE, store);
        return ok({ removed: id });
      }
      case 'list_local_reminders': {
        const store = await reminderStore();
        const includeDone = asBool(args.includeDone);
        const limit = Math.max(1, Math.min(toNumber(args.limit, 30), 50));
        const reminders = store.reminders
          .filter((item) => includeDone || item.status === 'pending')
          .sort((a, b) => Date.parse(a.dueAt || 0) - Date.parse(b.dueAt || 0))
          .slice(0, limit);
        return ok({ reminders });
      }
      case 'create_local_reminder': {
        const title = cleanText(args.title, 180).replace(/\s+/g, ' ').trim();
        const note = cleanText(args.note, 600).replace(/\s+/g, ' ').trim();
        const rawDue = cleanText(args.dueAt, 80).trim();
        if (!title) throw new Error('reminder title is required');
        if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(rawDue)) throw new Error('dueAt must include a timezone offset');
        const due = new Date(rawDue);
        if (!Number.isFinite(due.getTime())) throw new Error('dueAt is invalid');
        const store = await reminderStore();
        const reminder = {
          id: newLocalId('rem'), title, note, dueAt: due.toISOString(),
          status: 'pending', createdAt: new Date().toISOString(), firedAt: null,
        };
        store.reminders.push(reminder);
        store.reminders = store.reminders.slice(-500);
        store.updatedAt = new Date().toISOString();
        await writeJsonAtomic(JARVIS_REMINDERS_FILE, store);
        return ok({ reminder });
      }
      case 'complete_local_reminder':
      case 'cancel_local_reminder': {
        const id = cleanText(args.id, 100).trim();
        const store = await reminderStore();
        const reminder = store.reminders.find((item) => item.id === id);
        if (!reminder) throw new Error('reminder not found');
        reminder.status = name === 'complete_local_reminder' ? 'completed' : 'cancelled';
        reminder.updatedAt = new Date().toISOString();
        if (reminder.status === 'completed') reminder.completedAt = reminder.updatedAt;
        store.updatedAt = reminder.updatedAt;
        await writeJsonAtomic(JARVIS_REMINDERS_FILE, store);
        return ok({ reminder });
      }
      default:
        throw new Error('unknown local tool: ' + name);
    }
  } catch (e) {
    return err(e);
  }
}

function dollars(n) {
  const v = Number(n) || 0;
  return '$' + Math.round(v).toLocaleString('en-US');
}

function pct(n) {
  const v = Number(n) || 0;
  return (v >= 0 ? 'up ' : 'down ') + Math.abs(v).toFixed(1) + ' percent';
}

function countBy(items, key) {
  const out = {};
  for (const it of (Array.isArray(items) ? items : [])) out[it[key] || 'unknown'] = (out[it[key] || 'unknown'] || 0) + 1;
  return out;
}

async function tryDirectLocalTool(message) {
  const s = directIntent(message);
  if (!s) return null;
  // Search terms may contain time, model, or other shortcut keywords.
  const noteSearch = /^(?:search|find)\s+(?:vault|notes?)\s+(?:for\s+)?(.+)$/i.exec(s);
  if (noteSearch) {
    const r = await executeTool('search_vault_notes', { query: noteSearch[1], limit: 5 });
    if (!r.ok) return null;
    const hits = r.results || [];
    return { reply: hits.length ? ('I found ' + hits.length + ' notes. Top hit: ' + hits[0].title + '.') : 'I did not find a matching vault note.' };
  }
  const isWritey = /\b(update|set|change|add|log|mark|write|edit|create|append|open|launch|run|powershell|script|click|type|press|focus|scroll|hotkey|remember|forget|remind|cancel|complete)\b/.test(s);

  if (/\b(time|date|day)\b/.test(s) && !isWritey) {
    const r = await executeTool('get_current_time', {});
    if (!r.ok) return null;
    return { reply: 'It is ' + r.time.replace(/:\d{2}\s/, ' ') + ' on ' + r.date + '.' };
  }

  if (/voice|stt|wake|whisper|jarvisvoice/.test(s) && !isWritey) {
    const r = await executeTool('get_jarvis_voice_status', {});
    if (!r.ok) return { reply: 'The voice service is not responding.' };
    const v = r.voice || {};
    return { reply: v.ok ? ('Voice is online using ' + (v.model || 'the local model') + '.') : 'Voice is reachable, but it is not healthy.' };
  }

  if (/loaded|running/.test(s) && /ollama|models?|gemma|llama/.test(s) && !isWritey) {
    const r = await executeTool('get_ollama_loaded_models', {});
    if (!r.ok) return { reply: 'Ollama is not answering right now.' };
    const names = (r.models || []).map((m) => m.name || m.model).filter(Boolean);
    return { reply: names.length ? ('Loaded locally: ' + names.slice(0, 4).join(', ') + '.') : 'No Ollama models are loaded right now.' };
  }

  if (/ollama|models?|gemma|llama/.test(s) && !isWritey) {
    const r = await executeTool('list_ollama_models', {});
    if (!r.ok) return { reply: 'Ollama is not answering right now.' };
    const names = (r.models || []).map((m) => m.name || m.model).filter(Boolean);
    return { reply: names.length ? ('Installed locally: ' + names.slice(0, 6).join(', ') + '.') : 'I do not see any installed Ollama models.' };
  }

  if (/aios|server|dashboard|health|status/.test(s) && !/brief|fresh|voice|ollama|model/.test(s) && !isWritey) {
    const r = await executeTool('get_aios_health', {});
    if (!r.ok) return { reply: 'AIOS is not answering on localhost.' };
    return { reply: r.health && r.health.ok ? 'AIOS is online and healthy.' : 'AIOS answered, but something looks off.' };
  }

  if (/goals?/.test(s) && !isWritey) {
    const r = await executeTool('get_goals_snapshot', {});
    if (!r.ok) return null;
    const goals = (r.data && r.data.goals) || [];
    if (!goals.length) return { reply: 'You do not have any AIOS goals saved yet.' };
    const first = goals.slice(0, 3).map((g) => g.name + ' at ' + dollars(g.saved) + ' of ' + dollars(g.target)).join('; ');
    return { reply: 'You have ' + goals.length + ' goals. ' + first + '.' };
  }

  if (/todos?|to[- ]?do|tasks?/.test(s) && !isWritey) {
    const r = await executeTool('get_todos_snapshot', {});
    if (!r.ok) return null;
    const items = (r.data && r.data.items) || [];
    if (!items.length) return { reply: 'Your AIOS to-do list is empty.' };
    return { reply: 'You have ' + items.length + ' to-dos. First up: ' + items.slice(0, 3).map((x) => x.title).join('; ') + '.' };
  }

  if (/portfolio|quotes?|stocks?|net\s*worth|money/.test(s) && !isWritey) {
    const r = await executeTool('get_portfolio_snapshot', {});
    if (!r.ok) return null;
    const p = r.portfolio || {}, n = r.netWorth || {};
    return { reply: 'Portfolio is about ' + dollars(p.totalValue) + ', ' + pct(p.dayChangePct) + ' today. Net worth is about ' + dollars(n.total) + '.' };
  }

  if (/metrics|cash|savings|motorcycle/.test(s) && !isWritey) {
    const r = await executeTool('get_metrics_snapshot', {});
    if (!r.ok) return null;
    const a = (r.metrics && r.metrics.assets) || {};
    return { reply: 'Metrics show ' + dollars(a.cash) + ' cash, ' + dollars(a.savings) + ' savings, and the bike at ' + dollars(a.motorcycle) + '.' };
  }

  if (/pipeline|lead\s*board/.test(s) && !isWritey) {
    const r = await executeTool('get_pipeline_snapshot', {});
    if (!r.ok) return null;
    const cards = (r.pipeline && r.pipeline.cards) || [];
    const c = countBy(cards, 'stage');
    return { reply: 'Pipeline has ' + cards.length + ' cards: ' + (c.new || 0) + ' new, ' + (c.contacted || 0) + ' contacted, ' + (c.booked || 0) + ' booked, ' + (c.done || 0) + ' done.' };
  }

  if (/crm|booking|customer|client|revenue|profit/.test(s) && !isWritey) {
    const r = await executeTool('get_crm_summary', {});
    if (!r.ok) return { reply: 'CRM is not answering right now.' };
    return { reply: 'CRM shows ' + dollars(r.totalRevenue) + ' completed revenue, ' + r.counts.completed + ' completed jobs, and ' + r.clients + ' clients.' };
  }

  if (/nextdoor|local\s*demand|leads?/.test(s) && !isWritey && !/refresh/.test(s)) {
    const r = await executeTool('get_local_demand_snapshot', {});
    if (!r.ok) return null;
    const d = r.localDemand || {};
    return { reply: d.hasLeads ? ('Local demand has ' + (d.leads || []).length + ' leads, ' + (d.freshCount || 0) + ' fresh.') : 'No local demand leads are saved right now.' };
  }

  if (/refresh/.test(s) && /nextdoor|leads?/.test(s)) {
    const r = await executeTool('refresh_nextdoor_leads', {});
    return { reply: r.ok ? 'Nextdoor lead refresh started.' : 'I could not start the Nextdoor refresh.' };
  }

  if (/refresh/.test(s) && /social|instagram|tiktok|youtube/.test(s)) {
    const r = await executeTool('refresh_social_data', {});
    return { reply: r.ok ? 'Social refresh started.' : 'I could not start the social refresh.' };
  }

  if (/generate/.test(s) && /brief/.test(s)) {
    const r = await executeTool('generate_brief', {});
    return { reply: r.ok ? 'Brief generation started.' : 'I could not start the brief.' };
  }

  if (/brief|freshness|fresh/.test(s) && !isWritey) {
    const r = await executeTool('get_freshness_and_brief_status', {});
    if (!r.ok) return null;
    const b = r.brief || {};
    return { reply: 'Freshness is loaded. Brief status is ' + (b.status || (r.briefGenerating ? 'generating' : 'none')) + '.' };
  }

  if (/reminders?/.test(s) && !/create|add|set|cancel|complete|done|remind me/.test(s)) {
    const r = await executeTool('list_local_reminders', { limit: 20 });
    if (!r.ok) return null;
    const reminders = r.reminders || [];
    if (!reminders.length) return { reply: 'You have no pending reminders.' };
    const next = reminders[0];
    return { reply: 'You have ' + reminders.length + ' pending reminders. Next: ' + next.title + ' at ' + new Date(next.dueAt).toLocaleString() + '.' };
  }

  if (/what do you remember|recall memory|jarvis memory/.test(s) && !/forget|remember this/.test(s)) {
    const r = await executeTool('recall_jarvis_memory', { limit: 8 });
    if (!r.ok) return null;
    const memories = r.memories || [];
    return { reply: memories.length ? ('I have ' + memories.length + ' relevant memories. Most recent: ' + memories[0].text) : 'I do not have any structured memories saved yet.' };
  }

  const search = /(?:search|find)\s+(?:vault|notes?)\s+(?:for\s+)?(.+)$/i.exec(message);
  if (search && !isWritey) {
    const r = await executeTool('search_vault_notes', { query: search[1], limit: 5 });
    if (!r.ok) return null;
    const hits = r.results || [];
    return { reply: hits.length ? ('I found ' + hits.length + ' notes. Top hit: ' + hits[0].title + '.') : 'I did not find a matching vault note.' };
  }

  return null;
}
function parseToolArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); }
  catch { return {}; }
}

async function executeLocalToolCall(call) {
  const fn = call && call.function ? call.function : {};
  const name = String(fn.name || '').trim();
  const args = parseToolArgs(fn.arguments);
  const result = await executeTool(name, args);
  return {
    role: 'tool',
    tool_name: name,
    content: toJsonResult(result),
  };
}

module.exports = {
  LOCAL_TOOL_DEFINITIONS,
  LOCAL_TOOL_SYSTEM_PROMPT,
  executeTool,
  getToolPolicy,
  summarizeToolCall,
  isLocalToolMessage,
  localToolsForMessage,
  tryDirectLocalTool,
  executeLocalToolCall,
};
