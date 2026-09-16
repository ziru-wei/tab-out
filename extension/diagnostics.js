'use strict';

(() => {
  const PREFIX = '[tab-out diagnostics]';
  const history = [];
  const MAX_HISTORY = 80;

  function serializeError(value) {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack || '' };
    return { message: String(value) };
  }

  function record(stage, detail = {}, level = 'info') {
    const entry = {
      timestamp: new Date().toISOString(),
      elapsedMs: Math.round(performance.now()),
      stage,
      detail,
    };
    history.push(entry);
    if (history.length > MAX_HISTORY) history.shift();
    console[level](`${PREFIX} ${stage}`, entry);
    return entry;
  }

  async function timed(stage, operation) {
    const startedAt = performance.now();
    try {
      const result = await operation();
      record(stage, { ok: true, durationMs: Math.round(performance.now() - startedAt) });
      return result;
    } catch (error) {
      record(stage, {
        ok: false,
        durationMs: Math.round(performance.now() - startedAt),
        error: serializeError(error),
      }, 'error');
      throw error;
    }
  }

  async function workerProbe() {
    const requestId = crypto.randomUUID();
    const request = chrome.runtime.sendMessage(TabOutContracts.createRuntimeMessage(
      TabOutContracts.MESSAGES.DIAGNOSTICS_PING,
      { requestId },
    ));
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error('Service worker did not respond within 1500 ms')), 1500);
    });
    try {
      const response = await Promise.race([request, timeout]);
      if (!response?.ok) throw new Error('Service worker returned no diagnostic response');
      return {
        contractVersion: response.contractVersion,
        versionMatches: response.contractVersion === TabOutContracts.CONTRACT_VERSION,
      };
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function run() {
    record('run:start', {
      extensionId: chrome.runtime.id,
      contractVersion: TabOutContracts.CONTRACT_VERSION,
      visibilityState: document.visibilityState,
    });
    const results = await Promise.allSettled([
      timed('tabs:query', async () => ({ count: (await chrome.tabs.query({})).length })),
      timed('storage:local', async () => ({ keys: Object.keys(await chrome.storage.local.get(null)).length })),
      timed('storage:session', async () => ({ keys: Object.keys(await chrome.storage.session.get(null)).length })),
      timed('worker:ping', workerProbe),
    ]);
    const summary = results.map(result => result.status === 'fulfilled'
      ? { ok: true, result: result.value }
      : { ok: false, error: serializeError(result.reason) });
    record('run:complete', { summary }, summary.every(item => item.ok) ? 'info' : 'warn');
    return summary;
  }

  window.addEventListener('error', event => {
    record('window:error', serializeError(event.error || event.message), 'error');
  });
  window.addEventListener('unhandledrejection', event => {
    record('promise:unhandled-rejection', serializeError(event.reason), 'error');
  });

  globalThis.TabOutDiagnostics = Object.freeze({
    mark: (stage, detail = {}) => record(stage, detail),
    run,
    history: () => history.map(entry => ({ ...entry })),
  });
  window.setTimeout(() => { void run(); }, 0);
})();
