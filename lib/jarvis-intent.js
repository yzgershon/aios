'use strict';

// These are command grammars, not topic keywords. Anything ambiguous goes to
// the brain with the complete request and conversation context.
function directIntent(message) {
  const text = String(message || '').toLowerCase().replace(/[’]/g, "'")
    .replace(/[.!?,]+$/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^(?:hey |hi )?jarvis[, ]+/, '').replace(/^please /, '').replace(/ please$/, '');
  const commands = [
    /^(?:(?:what(?:'s| is) (?:the )?(?:current )?(?:time|date)|what time is it|what (?:day|date) is (?:it|today))(?: right now)?|(?:current )?(?:time|date))$/,
    /^(?:is (?:jarvisvoice|the voice service|voice|aios|the server|the dashboard) (?:working|online|healthy)|(?:aios|voice|jarvisvoice|server) (?:health|status))$/,
    /^(?:(?:list|show)(?: me)? (?:my |the )?(?:goals|todos|to-dos|to do list|tasks|reminders)|what(?:'s| is) on my (?:to-do|to do|task) list|what are my (?:goals|todos|to-dos|tasks|reminders))$/,
    /^(?:(?:list|show)(?: me)? (?:the )?(?:installed|loaded|running) (?:ollama )?models|what (?:ollama )?models are (?:installed|loaded|running))$/,
    /^(?:what do you remember(?: about me)?|recall memory|jarvis memory)$/,
    /^(?:search|find) (?:vault|notes?) (?:for )?[^?;\n]+$/,
    /^(?:refresh (?:nextdoor leads|social data)|generate (?:the |my )?brief|(?:brief|freshness) status)$/,
  ];
  return commands.some((pattern) => pattern.test(text)) ? text : null;
}

module.exports = { directIntent };
