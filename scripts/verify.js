'use strict';
/*
 * AIOS verification harness — drives headless Chrome over raw CDP (no puppeteer).
 * Usage: node scripts/verify.js [baseUrl]   (default http://127.0.0.1:3210)
 * Walks every page, collects console errors / exceptions / failed requests,
 * screenshots each page to scripts/shots/, prints a JSON summary, exit 1 on errors.
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const PORT = 9333;
const PAGES = ['dashboard', 'pipeline', 'portfolio', 'ads', 'goals', 'brain'];
const SHOTS = path.join(__dirname, 'shots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const profile = path.join(os.tmpdir(), 'aios-verify-profile');
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) {
    await sleep(250);
    targets = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => null);
  }
  if (!targets) { chrome.kill(); throw new Error('chrome CDP never came up'); }
  const page = targets.find((t) => t.type === 'page');

  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

  let msgId = 0;
  const pending = new Map();
  const issues = []; // {page, kind, text}
  let currentPage = 'load';
  let loadedResolve = null;

  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Page.loadEventFired' && loadedResolve) { loadedResolve(); loadedResolve = null; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const text = m.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
      issues.push({ page: currentPage, kind: 'console.error', text: text.slice(0, 500) });
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      const text = (d.exception && d.exception.description) || d.text || 'exception';
      issues.push({ page: currentPage, kind: 'exception', text: text.slice(0, 500) });
    }
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      issues.push({ page: currentPage, kind: `http ${m.params.response.status}`, text: m.params.response.url.slice(0, 300) });
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

  const loaded = new Promise((r) => { loadedResolve = r; });
  await send('Page.navigate', { url: BASE });
  await Promise.race([loaded, sleep(15000)]);
  await sleep(4500); // boot sequence + first data paint

  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };

  await shot('00-boot-landing');
  for (const p of PAGES) {
    currentPage = p;
    await send('Runtime.evaluate', { expression: `AIOS.showPage('${p}')` });
    await sleep(p === 'brain' ? 3500 : 1800);
    await shot(p);
  }

  // terminal expand check (UI only — no claude session is started by expand alone)
  currentPage = 'terminal';
  await send('Runtime.evaluate', { expression: `AIOS.terminal && AIOS.terminal.expand && AIOS.terminal.expand()` });
  await sleep(1200);
  await shot('terminal');

  ws.close();
  chrome.kill();

  const errors = issues.filter((i) => !/favicon/.test(i.text));
  console.log(JSON.stringify({ ok: errors.length === 0, count: errors.length, issues: errors }, null, 2));
  process.exit(errors.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('VERIFY HARNESS FAILED:', e.message); process.exit(2); });
