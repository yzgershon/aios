'use strict';
// One-off: open the brain page, wait out the intro, screenshot the settled cortex.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const PORT = 9334;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

async function main() {
  const profile = path.join(os.tmpdir(), 'aios-shot-profile');
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) { await sleep(250); targets = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => null); }
  if (!targets) { chrome.kill(); throw new Error('no CDP'); }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  let id = 0; const pend = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE });
  await sleep(6000);
  await send('Runtime.evaluate', { expression: `AIOS.showPage('brain')` });
  await sleep(2000); // mid-intro: embryonic ball
  let { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', 'rebuild', 'shots', 'brain-intro.png'), Buffer.from(data, 'base64'));
  await sleep(8000); // intro over + settled
  ({ data } = await send('Page.captureScreenshot', { format: 'png' }));
  fs.writeFileSync(path.join(__dirname, '..', 'rebuild', 'shots', 'brain-settled.png'), Buffer.from(data, 'base64'));
  ws.close(); chrome.kill();
  console.log('done');
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
