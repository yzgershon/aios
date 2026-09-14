'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const OMIT = new Set(['node_modules', '.git', '.codex', '.agents', '.aios', '.ssh', '.aws', '.azure', 'bin', 'obj', 'publish', 'dist', 'build', '.next', '.cache', 'coverage', 'vendor']);
const TEXT = new Set(['.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.html', '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.cs', '.csproj', '.sln', '.py', '.ps1', '.sql', '.toml', '.xml', '.sh', '.rs', '.go', '.vue', '.svelte']);
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const inside = (child, root) => { const rel = path.relative(root, child); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
function allowedName(file) {
  const parts = file.split(/[\\/]/);
  return !parts.some((part) => OMIT.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part) || /(?:^|[-_.])(secret|credentials?|passwords?|private[-_]?key|auth)(?:[-_.]|$)/i.test(part));
}
function textFile(file) { return TEXT.has(path.extname(file).toLowerCase()) || /^(AGENTS|README|LICENSE|Dockerfile|Makefile)$/i.test(path.basename(file)); }
function command(file, args, cwd, timeout = 8000) {
  return new Promise((resolve) => execFile(file, args, { cwd, timeout, maxBuffer: 128 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout, stderr) => resolve({ ok: !error, output: String(stdout || '').slice(0, 18000), error: error ? String(stderr || error.message).slice(0, 800) : undefined })));
}

function createWorkspace({ root = 'C:/Dev', backupRoot }) {
  async function resolveProject(input = '.') {
    const resolvedRoot = await fsp.realpath(root);
    const candidate = path.resolve(root, String(input));
    if (!inside(candidate, path.resolve(root)) || !allowedName(path.relative(root, candidate))) throw new Error('Choose a project within the configured development folder.');
    const real = await fsp.realpath(candidate);
    if (!inside(real, resolvedRoot) || !(await fsp.stat(real)).isDirectory()) throw new Error('Project is outside the development folder or is not a directory.');
    return real;
  }
  async function resolveFile(project, relative, create = false) {
    if (!relative || !allowedName(relative) || !textFile(relative)) throw new Error('Choose a non-secret source or text file.');
    const candidate = path.resolve(project, relative);
    if (!inside(candidate, project)) throw new Error('File must stay inside the selected project.');
    let real;
    try { real = await fsp.realpath(candidate); }
    catch (e) {
      if (e.code !== 'ENOENT' || !create) throw e;
      real = path.join(await fsp.realpath(path.dirname(candidate)), path.basename(candidate));
    }
    if (!inside(real, project) || !allowedName(path.relative(project, real))) throw new Error('File link leaves the project or points to a protected location.');
    return real;
  }
  async function files(project) {
    const results = [], queue = [project];
    let visited = 0;
    while (queue.length && results.length < 4000 && visited < 12000) {
      const dir = queue.shift();
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        visited++;
        const full = path.join(dir, entry.name), rel = path.relative(project, full);
        if (entry.isSymbolicLink() || !allowedName(rel)) continue;
        if (entry.isDirectory()) queue.push(full);
        else if (entry.isFile() && textFile(rel)) results.push(rel.replace(/\\/g, '/'));
        if (results.length >= 4000 || visited >= 12000) break;
      }
    }
    return { files: results, truncated: queue.length > 0 || results.length >= 4000 || visited >= 12000 };
  }
  async function read(args) {
    const project = await resolveProject(args.project);
    const file = await resolveFile(project, args.path);
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('File is too large; search for the relevant section instead.');
    const content = await fsp.readFile(file, 'utf8');
    if (content.includes('\0')) throw new Error('Binary files are not supported.');
    const all = content.split('\n');
    const start = Math.max(1, Math.floor(Number(args.startLine) || 1));
    const count = Math.max(1, Math.min(180, Math.floor(Number(args.lineCount) || 100)));
    const excerpt = all.slice(start - 1, start - 1 + count).map((line, i) => `${start + i}: ${line.replace(/\r$/, '')}`).join('\n');
    return { ok: true, project, path: path.relative(project, file), sha256: hash(content), totalLines: all.length, startLine: start, content: excerpt.slice(0, 14000), truncated: start - 1 + count < all.length || excerpt.length > 14000 };
  }
  async function edit(args) {
    const project = await resolveProject(args.project);
    const file = await resolveFile(project, args.path, args.create === true);
    const replacement = String(args.replacement ?? '');
    if (Buffer.byteLength(replacement) > 120 * 1024) throw new Error('Edit is too large.');
    if (args.create === true) {
      await fsp.writeFile(file, replacement, { encoding: 'utf8', flag: 'wx' });
      return { ok: true, created: true, path: file, sha256: hash(replacement), bytes: Buffer.byteLength(replacement) };
    }
    const stat = await fsp.stat(file);
    if (stat.size > 1024 * 1024) throw new Error('File is too large to edit.');
    const before = await fsp.readFile(file, 'utf8');
    if (!args.expectedSha256 || args.expectedSha256 !== hash(before)) throw new Error('File changed since it was read. Read it again before editing.');
    const search = String(args.find ?? '');
    if (!search || before.indexOf(search) === -1 || before.indexOf(search) !== before.lastIndexOf(search)) throw new Error('The exact text must match once. Include more surrounding context.');
    const after = before.replace(search, () => replacement);
    await fsp.mkdir(backupRoot, { recursive: true });
    const backup = path.join(backupRoot, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${path.basename(file)}`);
    await fsp.writeFile(backup, before, { encoding: 'utf8', flag: 'wx' });
    // Recheck after writing the backup to catch intervening user edits.
    if (hash(await fsp.readFile(file, 'utf8')) !== args.expectedSha256) throw new Error('File changed while preparing the edit. Read it again.');
    await fsp.writeFile(file, after, 'utf8');
    return { ok: true, path: file, backup, beforeSha256: hash(before), sha256: hash(after), replacements: 1, verified: hash(await fsp.readFile(file, 'utf8')) === hash(after) };
  }
  async function list() {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || !allowedName(entry.name)) continue;
      const dir = path.join(root, entry.name);
      const names = await fsp.readdir(dir).catch(() => []);
      if (!names.some((name) => ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'].includes(name) || /\.(csproj|sln)$/i.test(name))) continue;
      projects.push({ name: entry.name, path: dir, git: names.includes('.git') });
    }
    return { ok: true, root, projects };
  }
  async function context(args) {
    const project = await resolveProject(args.project);
    const [inventory, git, diff] = await Promise.all([
      files(project), command('git', ['status', '--short', '--branch', '--untracked-files=normal'], project), command('git', ['diff', '--stat'], project),
    ]);
    const top = await fsp.readdir(project);
    const instructions = [];
    for (const name of ['AGENTS.md', 'README.md', 'HANDOFF.md', 'package.json']) {
      if (!top.includes(name)) continue;
      const file = await resolveFile(project, name);
      if ((await fsp.stat(file)).size < 512 * 1024) instructions.push({ path: name, content: (await fsp.readFile(file, 'utf8')).slice(0, name === 'AGENTS.md' ? 5000 : 1600) });
    }
    return { ok: true, project, git, diff, instructions, files: inventory.files.slice(0, 100), inventoryTruncated: inventory.truncated || inventory.files.length > 100, totalIndexedFiles: inventory.files.length };
  }
  async function search(args) {
    const project = await resolveProject(args.project);
    const query = String(args.query || '').trim();
    if (!query || query.length > 160) throw new Error('A short literal search query is required.');
    const inventory = await files(project);
    const results = [];
    const lower = query.toLowerCase();
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
    const started = Date.now();
    let scanned = 0;
    for (const relative of inventory.files) {
      if (Date.now() - started > 7000 || results.length >= limit) break;
      if (args.pathFilter && !relative.toLowerCase().includes(String(args.pathFilter).toLowerCase())) continue;
      const file = await resolveFile(project, relative).catch(() => null);
      if (!file || (await fsp.stat(file)).size > 512 * 1024) continue;
      const content = await fsp.readFile(file, 'utf8'); scanned++;
      if (content.includes('\0')) continue;
      if (relative.toLowerCase().includes(lower)) results.push({ path: relative, line: null, text: 'File name match' });
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < limit; i++) {
        if (lines[i].toLowerCase().includes(lower)) results.push({ path: relative, line: i + 1, text: lines[i].trim().slice(0, 360) });
      }
    }
    return { ok: true, project, query, results, scanned, truncated: inventory.truncated || results.length >= limit || Date.now() - started > 7000 };
  }
  return { list, context, search, read, edit };
}

module.exports = { createWorkspace };
