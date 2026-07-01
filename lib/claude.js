'use strict';
// AIOS claude binary resolution — shared by the terminal PTY and the brief.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// Resolve the claude binary once at boot. { kind, value }:
//  'exe'  → spawn directly;
//  'shim' → run via cmd.exe with the quoted path (.cmd/.bat that cmd can exec);
//  'name' → run via cmd.exe as bare `claude` so PATHEXT finds claude.cmd
//           (npm also drops an extensionless Unix shim that cmd can't run — so
//            never quote a full path to that; rely on the bare name instead).
const CLAUDE = (() => {
  const explicit = process.env.AIOS_CLAUDE_BIN;
  if (explicit) {
    return { kind: path.extname(explicit).toLowerCase() === '.exe' ? 'exe' : 'shim', value: explicit };
  }
  let onPath = false;
  try { execSync('where claude', { stdio: 'ignore' }); onPath = true; } catch { /* not on PATH */ }
  if (onPath) return { kind: 'name', value: 'claude' };
  const exe = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(exe)) return { kind: 'exe', value: exe };
  const cmd = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
  if (fs.existsSync(cmd)) return { kind: 'shim', value: cmd };
  return { kind: 'name', value: 'claude' };
})();

function buildSpawn(skill) {
  const slash = skill ? '/' + skill : '';
  if (CLAUDE.kind === 'exe') return { file: CLAUDE.value, args: slash ? [slash] : [] };
  // .cmd / bare name → run through the shell (ConPTY can't exec a shim directly).
  const comspec = process.env.ComSpec || 'cmd.exe';
  const ref = CLAUDE.kind === 'name' ? 'claude' : `"${CLAUDE.value}"`;
  return { file: comspec, args: ['/d', '/s', '/c', ref + (slash ? ' ' + slash : '')] };
}

function ptyEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // use the claude.ai subscription login, not the paid API
  env.TERM = 'xterm-256color';
  if (CLAUDE.value.includes(path.sep)) {
    env.PATH = path.dirname(CLAUDE.value) + path.delimiter + (env.PATH || '');
  }
  return env;
}


module.exports = { CLAUDE, buildSpawn, ptyEnv };
