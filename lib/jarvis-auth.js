'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

// Hard links stop following auth.json when a login atomically replaces it.
// Sync only when the source changes; preserve credentials refreshed by Jarvis
// between source logins. Never write credentials back to the user's Codex home.
function syncAuth(sourceHome, targetHome) {
  fs.mkdirSync(targetHome, { recursive: true });
  const source = path.join(sourceHome, 'auth.json');
  const target = path.join(targetHome, 'auth.json');
  const marker = path.join(targetHome, 'jarvis-auth-source.json');
  if (path.resolve(source) === path.resolve(target)) return { available: fs.existsSync(target), changed: false };
  let sourceBytes;
  try { sourceBytes = fs.readFileSync(source); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { available: fs.existsSync(target), changed: false };
  }
  JSON.parse(sourceBytes.toString('utf8')); // Never replace good credentials with a partial login write.
  const fingerprint = createHash('sha256').update(sourceBytes).digest('hex');
  let saved;
  try { saved = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* first sync */ }
  if (saved?.fingerprint === fingerprint && fs.existsSync(target)) return { available: true, changed: false };
  const temp = target + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, sourceBytes, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, target); // Replaces old hard links without changing the source file.
    fs.writeFileSync(marker, JSON.stringify({ fingerprint }), { mode: 0o600 });
  } finally {
    try { fs.unlinkSync(temp); } catch { /* already renamed */ }
  }
  return { available: true, changed: true };
}

function brainError(error, signal) {
  const raw = String(error?.message || error);
  let code = error?.code;
  let message = raw;
  if (/refresh token|access token|unauthori[sz]ed|401\b|sign in|log in|not authenticated/i.test(raw)) {
    code = 'AUTH_REQUIRED';
    message = 'JARVIS needs a fresh Codex sign-in. Sign in to Codex, then try again.';
  } else if (signal?.aborted) {
    code = signal.reason?.code || 'CANCELLED';
    message = code === 'TURN_TIMEOUT' ? 'JARVIS took too long to respond. Please try a shorter request.' : 'Request cancelled.';
  } else if (/429\b|usage limit|rate limit|quota/i.test(raw)) {
    code = 'RATE_LIMITED';
    message = 'The Codex usage limit was reached. Try again after it resets.';
  } else if (/model.*(not found|not supported|does not exist)|reasoning.*(unsupported|not supported)/i.test(raw)) {
    code = 'MODEL_UNAVAILABLE';
    message = 'The configured JARVIS model or reasoning setting is unavailable.';
  }
  return Object.assign(new Error(message.slice(0, 500)), { code: code || 'BRAIN_ERROR' });
}

module.exports = { syncAuth, brainError };
