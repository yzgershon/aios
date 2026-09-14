'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { approvalReason } = require('../lib/jarvis-approval-policy');

test('the recorded Chrome Lady Gaga search proceeds without an approval at every step', () => {
  const calls = [
    ['scan_desktop', {}],
    ['focus_window', { title: 'Google Chrome' }],
    ['send_hotkey', { keys: 'ctrl+l', intent: "Focus Chrome's address bar for the Lady Gaga search.", verify: true }],
    ['type_text', { text: 'Lady Gaga', intent: 'Enter the requested Lady Gaga search.', verify: true }],
    ['send_hotkey', { keys: 'enter', intent: 'Submit the Lady Gaga search in Chrome.', verify: true }],
    ['click_screen', { intent: 'Focus Chrome address bar.', x: 1130, y: 86, verify: false }],
    ['type_text', { text: 'Lady Gaga', intent: 'Enter the requested search.' }],
    ['send_hotkey', { keys: 'enter', intent: 'Submit Lady Gaga search.' }],
    ['capture_screen', { mode: 'active' }],
  ];
  for (const [tool, input] of calls) {
    assert.equal(approvalReason(tool, input), null, tool + ': ' + input.intent);
  }
});

test('navigation and draft preparation do not inherit later send or purchase intent', () => {
  const calls = [
    ['mcp__jarvis__send_hotkey', { keys: 'Control + L', intent: 'Focus the address bar to search how to send email.' }],
    ['jarvis.sendHotkey', { keys: 'ctrl+w', intent: 'Close this tab.' }],
    ['type_text', { intent: 'Prepare an email draft to send later.' }],
    ['set_ui_field', { name: 'Post text', intent: 'Write the draft post.' }],
    ['open_web_page', { url: 'https://example.com', intent: 'Open the store to compare purchase options.' }],
    ['click_screen', { intent: 'Click the search box to search for Post Malone.' }],
    ['send_hotkey', { keys: 'enter', intent: 'Submit the search for buy Lady Gaga tickets.' }],
    ['click_ui_element', { name: 'Submit', intent: 'Submit the Lady Gaga search.' }],
    ['click_ui_element', { name: 'Search Post Malone', intent: 'Search for Post Malone.' }],
    ['read_email', {}],
    ['read_post', {}],
    ['run_powershell', { command: 'Get-Process chrome', intent: 'Check Chrome processes.' }],
  ];
  for (const [tool, input] of calls) assert.equal(approvalReason(tool, input), null, tool + ': ' + JSON.stringify(input));
});

test('sending, money, destructive actions, and security changes still require approval', () => {
  const calls = [
    ['send_email', {}], ['send_message', {}], ['publish_post', {}], ['purchase_item', {}], ['delete_file', {}],
    ['click_ui_element', { name: 'Send', intent: 'Submit the search.' }],
    ['click_ui_element', { name: 'Buy now', intent: 'Continue.' }],
    ['click_ui_element', { name: 'Publish', intent: 'Continue.' }],
    ['click_ui_element', { name: 'Delete', intent: 'Continue.' }],
    ['click_screen', { intent: 'Send the email draft.' }],
    ['send_hotkey', { keys: 'enter', intent: 'Submit the payment.' }],
    ['send_hotkey', { keys: 'enter', intent: 'Submit the completed form.' }],
    ['send_hotkey', { keys: 'ctrl+enter', intent: 'Confirm.' }],
    ['send_hotkey', { keys: 'shift+delete', intent: 'Confirm.' }],
    ['click_screen', { intent: 'Grant account permissions.' }],
    ['click_screen', { intent: 'Disable two-factor authentication.' }],
    ['capture_screen', { allowSensitive: true }],
    ['type_text', { allowSensitive: 'true', intent: 'Fill the field.' }],
    ['run_powershell', { command: 'Remove-Item example.txt' }],
    ['run_powershell', { command: 'git push origin main' }],
    ['run_powershell', { command: 'Restart-Computer' }],
    ['run_powershell', { command: 'Invoke-RestMethod https://example.com -Method Post' }],
    ['run_powershell', { command: './helper.ps1', intent: 'Send the email.' }],
  ];
  for (const [tool, input] of calls) assert.ok(approvalReason(tool, input), tool + ': ' + JSON.stringify(input));
});
