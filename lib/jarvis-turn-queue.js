'use strict';

// Serialize the shared conversation, but never let requests accumulate behind
// an unresponsive turn. Cancellation while waiting settles immediately.
class TurnQueue {
  constructor(onState, waitMs = 5000) {
    this.onState = onState;
    this.waitMs = waitMs;
    this.busy = false;
    this.waiter = null;
  }
  update() { this.onState({ busy: this.busy, queueDepth: this.waiter ? 1 : 0 }); }
  async run(fn, signal) {
    signal?.throwIfAborted();
    if (this.busy) {
      if (this.waiter) throw Object.assign(new Error('JARVIS is still finishing another request.'), { code: 'BUSY' });
      await new Promise((resolve, reject) => {
        const finish = (error) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (this.waiter === finish) this.waiter = null;
          this.update();
          error ? reject(error) : resolve();
        };
        const abort = () => finish(signal.reason || new Error('Request cancelled.'));
        const timer = setTimeout(() => finish(Object.assign(new Error('JARVIS is still finishing another request.'), { code: 'BUSY' })), this.waitMs);
        this.waiter = finish;
        signal?.addEventListener('abort', abort, { once: true });
        this.update();
      });
    }
    signal?.throwIfAborted();
    this.busy = true;
    this.update();
    try { return await fn(); }
    finally {
      this.busy = false;
      const next = this.waiter;
      if (next) next();
      this.update();
    }
  }
}
module.exports = { TurnQueue };
