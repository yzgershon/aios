'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createWorkspace } = require('../lib/jarvis-workspace');
const { createPersonal, nextDue } = require('../lib/jarvis-personal');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-capability-test-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^jarvis-capability-test-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const project = path.join(root, 'app'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"fixture"}');
  fs.writeFileSync(path.join(project, 'app.js'), 'const greeting = "before";\nconsole.log(greeting);\n');
  return { root, project, workspace: createWorkspace({ root, backupRoot: path.join(root, 'backups') }), personal: createPersonal({ remindersFile: path.join(root, 'reminders.json'), routinesFile: path.join(root, 'routines.json'), notesRoot: path.join(root, 'notes') }) };
}

test('project search is grounded and excludes secrets, dependencies, and escaped paths', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, '.env'), 'greeting=private');
  fs.mkdirSync(path.join(f.project, 'node_modules'));
  fs.writeFileSync(path.join(f.project, 'node_modules', 'dep.js'), 'greeting');
  assert.equal((await f.workspace.list()).projects[0].name, 'app');
  const hits = await f.workspace.search({ project: 'app', query: 'greeting' });
  assert.equal(hits.results.length, 2);
  assert.ok(hits.results.every((row) => row.path === 'app.js'));
  await assert.rejects(f.workspace.read({ project: 'app', path: '.env' }), /non-secret/);
  await assert.rejects(f.workspace.read({ project: 'app', path: '../outside.js' }), /inside/);
  fs.mkdirSync(path.join(f.root, 'outside'));
  fs.writeFileSync(path.join(f.root, 'outside', 'leak.js'), 'greeting private');
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.project, 'link'), 'junction');
  await assert.rejects(f.workspace.read({ project: 'app', path: 'link/leak.js' }), /leaves the project/);
});

test('project edits preserve user changes, require a unique match, and create a usable backup', async (t) => {
  const f = fixture(t), file = path.join(f.project, 'app.js');
  const read = await f.workspace.read({ project: 'app', path: 'app.js' });
  assert.match(read.content, /1: const greeting/);
  const edited = await f.workspace.edit({ project: 'app', path: 'app.js', expectedSha256: read.sha256, find: '"before"', replacement: '"after"' });
  assert.equal(edited.verified, true);
  assert.match(fs.readFileSync(edited.backup, 'utf8'), /"before"/);
  await assert.rejects(f.workspace.edit({ project: 'app', path: 'app.js', expectedSha256: read.sha256, find: '"after"', replacement: '"bad"' }), /changed since/);
  fs.appendFileSync(file, '// user edit\n');
  assert.match(fs.readFileSync(file, 'utf8'), /user edit/);
  const fresh = await f.workspace.read({ project: 'app', path: 'app.js' });
  await assert.rejects(f.workspace.edit({ project: 'app', path: 'app.js', expectedSha256: fresh.sha256, find: 'greeting', replacement: 'x' }), /match once/);
  await assert.rejects(f.workspace.edit({ project: 'app', path: 'app.js', create: true, replacement: 'overwrite' }), /EEXIST/);
  assert.match(fs.readFileSync(file, 'utf8'), /user edit/);
});

test('reminders survive concurrent writers and are claimed once across processes', async (t) => {
  const f = fixture(t);
  const dueAt = new Date(Date.now() - 1000).toISOString();
  await Promise.all(Array.from({ length: 12 }, (_, i) => f.personal.changeReminder('create', { title: 'Fixture ' + i, dueAt })));
  assert.equal((await f.personal.reminders()).total, 12);
  const modulePath = path.resolve(__dirname, '../lib/jarvis-personal.js');
  const options = { remindersFile: path.join(f.root, 'reminders.json'), routinesFile: path.join(f.root, 'routines.json'), notesRoot: path.join(f.root, 'notes') };
  const source = `const {createPersonal}=require(process.argv[1]); createPersonal(JSON.parse(process.argv[2])).claimDue().then(rows=>console.log(JSON.stringify(rows.map(x=>x.id)))).catch(e=>{console.error(e);process.exitCode=1;});`;
  const claim = () => new Promise((resolve, reject) => execFile(process.execPath, ['-e', source, modulePath, JSON.stringify(options)], { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
  const batches = await Promise.all([claim(), claim(), claim()]);
  const ids = batches.flat();
  assert.equal(ids.length, 12); assert.equal(new Set(ids).size, 12);
  assert.equal((await f.personal.claimDue()).length, 0);
});

test('recurring reminders reschedule, snooze, and cancel without losing their anchor', async (t) => {
  const f = fixture(t);
  const created = await f.personal.changeReminder('create', { title: 'Plan the day', dueAt: new Date(Date.now() - 1000).toISOString(), repeat: 'daily' });
  assert.equal((await f.personal.claimDue()).length, 1);
  const pending = (await f.personal.reminders()).reminders[0];
  assert.ok(Date.parse(pending.dueAt) > Date.now());
  assert.equal(pending.firedAt, null);
  const snoozed = await f.personal.changeReminder('snooze', { id: created.reminder.id, minutes: 5 });
  assert.equal(snoozed.reminder.scheduleAnchorAt, created.reminder.scheduleAnchorAt);
  assert.ok(Math.abs(Date.parse(snoozed.reminder.dueAt) - Date.now() - 300000) < 1000);
  await f.personal.changeReminder('cancel', { id: created.reminder.id });
  assert.equal((await f.personal.reminders()).total, 0);
  await assert.rejects(f.personal.changeReminder('create', { title: 'Bad', dueAt: '2026-10-01T09:00:00' }), /timezone offset/);
});

test('daily and weekday recurrence follow local civil time across DST', () => {
  const old = process.env.TZ; process.env.TZ = 'America/New_York';
  try {
    const anchor = '2026-03-07T09:00:00-05:00';
    assert.equal(nextDue({ dueAt: anchor, repeat: 'daily' }, Date.parse(anchor)), '2026-03-08T13:00:00.000Z');
    assert.equal(nextDue({ dueAt: '2026-03-06T09:00:00-05:00', repeat: 'weekdays' }, Date.parse('2026-03-06T10:00:00-05:00')), '2026-03-09T13:00:00.000Z');
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});

test('routines and notes persist without silently replacing existing data', async (t) => {
  const f = fixture(t);
  assert.equal((await f.personal.routines()).routines.length, 4);
  await f.personal.saveRoutine({ name: 'Study setup', steps: ['Open my study notes.', 'List my pending reminders.'] });
  assert.equal((await f.personal.getRoutine({ name: 'study setup' })).routine.steps.length, 2);
  await assert.rejects(f.personal.saveRoutine({ name: 'Study setup', steps: ['New step'] }), /exists/);
  const note = await f.personal.note({ title: '../../Study note', content: 'A saved finding with a source.' });
  assert.equal(path.dirname(note.path), path.join(f.root, 'notes'));
  assert.match(fs.readFileSync(note.path, 'utf8'), /saved finding/);
});
