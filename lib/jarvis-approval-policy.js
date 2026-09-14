'use strict';

// Classify the effect of an action, not incidental words in a tool name.
// In particular, "send_hotkey" sends a key to Windows, not a message to anyone.
const NAVIGATION_KEYS = new Set([
  'ctrl+l', 'alt+d', 'ctrl+f', 'ctrl+t', 'ctrl+tab', 'ctrl+shift+tab',
  'alt+tab', 'alt+left', 'alt+right', 'ctrl+w', 'ctrl+a', 'ctrl+c',
  'ctrl+v', 'ctrl+x', 'ctrl+z', 'ctrl+y', 'ctrl+s', 'tab', 'shift+tab',
  'escape', 'esc', 'up', 'down', 'left', 'right', 'home', 'end',
  'pageup', 'pagedown', 'backspace', 'f5', 'ctrl+r', 'win+d',
]);
const PREPARATION_TOOLS = new Set([
  'focus_window', 'type_text', 'set_ui_field', 'write_clipboard',
  'open_local_path_or_app', 'open_web_page', 'scroll_screen',
]);
function normalizedTool(tool) {
  return String(tool || '').split(/__|\./).pop()
    .replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}
function approvalReason(tool, input = {}) {
  input = input && typeof input === 'object' ? input : {};
  const name = normalizedTool(tool);
  if (input.allowSensitive === true || input.allowSensitive === 'true') return 'protected-window';

  const readTool = /^(get|read|list|search|find|inspect|capture|scan|check|recall)(_|$)/.test(name);
  if (name !== 'send_hotkey' && !readTool) {
    if (/(^|_)(send|publish|post|tweet|reply_send)(_|$)/.test(name)) return 'external-send';
    if (/(^|_)(pay|payment|buy|purchase|checkout|charge|transfer_funds)(_|$)/.test(name)) return 'money';
    if (/(^|_)(delete|remove|trash|erase|purge)(_|$)/.test(name)) return 'destructive';
  }

  const command = String(input.command || input.cmd || '');
  if (command) {
    if (/\b(rm|del|erase|rmdir|rd)\b|Remove-Item|Clear-Content|Clear-Recyclebin/i.test(command)) return 'destructive';
    if (/git\s+(push|reset\s+--hard|clean\s+-\w*f)|npm\s+publish|(^|\s)gh\s+(pr|release)\s+(create|merge)/i.test(command)) return 'publish-or-destructive';
    if (/\b(format|shutdown|restart-computer|stop-computer)\b/i.test(command)) return 'system-change';
    if (/-Method\s+(Post|Put|Patch|Delete)|curl[^|]*-X\s*(POST|PUT|PATCH|DELETE)|crm-delete/i.test(command)) return 'external-write';
  }

  // Reading, focusing, editing text, opening a page, and preparing a draft
  // cannot be mistaken for the later Send/Buy/Publish action in their intent.
  if (readTool || PREPARATION_TOOLS.has(name)) return null;

  const keys = String(input.keys || '').toLowerCase().replace(/\s+/g, '').replace(/control/g, 'ctrl').replace(/return/g, 'enter');
  if (name === 'send_hotkey') {
    if (keys === 'shift+delete') return 'permanent-delete';
    if (keys === 'ctrl+enter' || keys === 'ctrl+shift+enter') return 'submit-shortcut';
    if (NAVIGATION_KEYS.has(keys)) return null;
  }

  const intent = String(input.intent || '').trim();
  // Submitting a browser/search query is routine navigation. The object of
  // the search may itself contain words such as "buy" or "Post Malone".
  const searchIntent = /^(?:submit|run|perform|execute|start|confirm)\b[^.!?;\n]{0,100}\b(?:search|query)\b|^search\s+(?:for|the web|google|bing)\b/i.test(intent)
    && !/\b(?:and|then)\s+(?:send|pay|buy|purchase|publish|delete)\b/i.test(intent);
  // An observed Send/Buy/etc. button overrides a benign description. A
  // generic Submit control can belong to a search form, so use its context.
  const label = String(input.name || input.label || '').trim();
  const major = /\b(send|submit|post|publish|tweet|pay|purchase|buy|checkout|charge|delete|remove|trash|erase|purge)\b/i;
  const searchLabel = /^(?:search|submit (?:the )?search|run (?:the )?search)\b/i.test(label);
  if (major.test(label) && !searchLabel && !(searchIntent && /^submit$/i.test(label))) return 'consequential-control';
  if (searchIntent) return null;
  if (/^click_(?:screen|ui_element)$/.test(name) && /^(?:click|focus|select)\b[^.!?;\n]{0,80}\b(?:address\s*bar|omnibox|search (?:box|field|bar))\b/i.test(intent)) return null;
  if (major.test(intent)) return 'consequential-action';
  if (/\b(?:grant|change|disable|enable|reset)\b.{0,50}\b(?:permissions?|password|security|firewall|authentication|two.factor|2fa)\b/i.test(intent)) return 'security-change';
  return null;
}

module.exports = { approvalReason };
