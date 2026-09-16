/* ================================================================
   Tab Out — Dashboard controller and renderer

   Owns dashboard interaction, grouping, rendering, drag/drop, and history.
   Shared storage/message contracts live in contracts.js; Captain schemas,
   Task Group matching, and PDF detection live in captain-rules.js. The
   service worker is the authoritative writer for Pocket and Captain state.
   ================================================================ */

'use strict';

const tabOutContracts = globalThis.TabOutContracts;
const { STORAGE_KEYS: TAB_OUT_STORAGE, MESSAGES: TAB_OUT_MESSAGES, DOM_EVENTS: TAB_OUT_EVENTS } = tabOutContracts;
const createRuntimeMessage = tabOutContracts.createRuntimeMessage;
const captainRules = globalThis.TabOutCaptainRules;
const CAPTAIN_KEEP_TRACE = '[tab-out captain keep]';
const CAPTAIN_KEEP_TRACE_LOG_KEY = TAB_OUT_STORAGE.CAPTAIN_KEEP_TRACE_LOG;
const TAB_ORIGIN_TRACE = '[tab-out tab-origin]';
const POCKET_BIND_TRACE = '[tab-out pocket-bind]';
const DUPLICATE_DELETE_TRACE = '[tab-out duplicate-delete]';
const CAPTAIN_KEEP_DEDUP_TRACE = '[tab-out captain-keep-dedup]';
const CAPTAIN_KEEP_REVIVE_TRACE = '[tab-out captain-keep-revive]';
const DRAG_DEBUG_TRACE = '[tab-out drag-debug]';
let captainKeepTracePersistTail = Promise.resolve();
const PERSIST_VERBOSE_CAPTAIN_TRACES = false;

function persistCaptainKeepTrace(stage, detail) {
  if (!PERSIST_VERBOSE_CAPTAIN_TRACES) return;
  const entry = { at: new Date().toISOString(), stage, detail };
  captainKeepTracePersistTail = captainKeepTracePersistTail.then(async () => {
    const stored = await chrome.storage.local.get(CAPTAIN_KEEP_TRACE_LOG_KEY);
    const previous = Array.isArray(stored[CAPTAIN_KEEP_TRACE_LOG_KEY])
      ? stored[CAPTAIN_KEEP_TRACE_LOG_KEY] : [];
    await chrome.storage.local.set({
      [CAPTAIN_KEEP_TRACE_LOG_KEY]: [...previous, entry].slice(-160),
    });
  }).catch(() => {});
}

function traceCaptainKeep(stage, detail = {}) {
  let serialized = '{}';
  try {
    serialized = JSON.stringify(detail);
  } catch (error) {
    serialized = JSON.stringify({ serializationError: String(error?.message || error) });
  }
  console.info(`${CAPTAIN_KEEP_TRACE} ${stage} ${serialized}`);
  persistCaptainKeepTrace(stage, JSON.parse(serialized));
}

async function dashboardTabOriginContext() {
  try {
    const stored = await chrome.storage.session.get([
      STARTUP_PRUNE_STATE_KEY,
      CAPTAIN_SESSION_TOKEN_KEY,
    ]);
    return {
      startupPhase: stored[STARTUP_PRUNE_STATE_KEY]?.phase || 'none',
      sessionToken: typeof stored[CAPTAIN_SESSION_TOKEN_KEY] === 'string'
        ? stored[CAPTAIN_SESSION_TOKEN_KEY] : null,
    };
  } catch {
    return { startupPhase: 'unavailable', sessionToken: null };
  }
}

function traceTabOrigin(stage, detail = {}) {
  console.info(`${TAB_ORIGIN_TRACE} ${stage}`, {
    timestamp: Date.now(),
    ...detail,
  });
}

function tracePocketBind(stage, detail = {}) {
  console.log(`${POCKET_BIND_TRACE} ${stage}`, JSON.stringify(detail));
}

function traceDuplicateDelete(stage, detail = {}) {
  console.log(`${DUPLICATE_DELETE_TRACE} ${stage}`, JSON.stringify(detail));
}

let captainKeepDedupTrace = null;
let captainKeepReviveTrace = null;
let captainKeepReviveTraceTimer = null;

function traceCaptainKeepRevive(stage, detail = {}) {
  if (!captainKeepReviveTrace && stage !== 'start') return;
  if (stage === 'start') {
    clearTimeout(captainKeepReviveTraceTimer);
    captainKeepReviveTrace = {
      operationId: crypto.randomUUID(),
      startedAt: performance.now(),
      keepId: detail.keepId || '',
      createdTabId: null,
    };
    captainKeepReviveTraceTimer = setTimeout(() => {
      traceCaptainKeepRevive('trace-window-end', {});
      captainKeepReviveTrace = null;
      captainKeepReviveTraceTimer = null;
    }, 30000);
  }
  if (Number.isInteger(detail.createdTabId)) {
    captainKeepReviveTrace.createdTabId = detail.createdTabId;
  }
  const trace = captainKeepReviveTrace;
  console.info(`${CAPTAIN_KEEP_REVIVE_TRACE} ${stage}`, JSON.stringify({
    timestamp: new Date().toISOString(),
    operationId: trace?.operationId || null,
    elapsedMs: trace ? Math.round((performance.now() - trace.startedAt) * 10) / 10 : null,
    keepId: trace?.keepId || detail.keepId || null,
    trackedTabId: trace?.createdTabId ?? null,
    ...detail,
  }));
}

function traceCaptainKeepDedup(stage, detail = {}) {
  if (!captainKeepDedupTrace && stage !== 'start') return;
  if (stage === 'start') {
    captainKeepDedupTrace = {
      operationId: crypto.randomUUID(),
      startedAt: performance.now(),
      clickedTabId: detail.clickedTabId ?? null,
      targetTabIds: [],
    };
  }
  const trace = captainKeepDedupTrace;
  console.info(`${CAPTAIN_KEEP_DEDUP_TRACE} ${stage}`, JSON.stringify({
    timestamp: new Date().toISOString(),
    operationId: trace?.operationId || null,
    elapsedMs: trace ? Math.round((performance.now() - trace.startedAt) * 10) / 10 : null,
    ...detail,
  }));
  if (stage === 'complete' || stage === 'error') captainKeepDedupTrace = null;
}

let dragDebugStartedAt = null;

function traceDragDebug(stage, detail = {}) {
  console.log(`${DRAG_DEBUG_TRACE} ${stage}`, JSON.stringify({
    timestamp: new Date().toISOString(),
    elapsedMs: Number.isFinite(dragDebugStartedAt)
      ? Math.round(performance.now() - dragDebugStartedAt)
      : null,
    ...detail,
  }));
}

let dailyQuotes = [];
let dailyQuoteRefreshTimer = null;
let dailyQuotesEnabled = true;
let dailyQuoteState = null;

function localCalendarDateKey(date = new Date()) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('-');
}

function dailyQuoteId(entry) {
  const value = `${entry.quote}\n${entry.source}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `quote-${(hash >>> 0).toString(36)}`;
}

function normalizeDailyQuoteState(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    lastShownDate: typeof value.lastShownDate === 'string' ? value.lastShownDate : '',
    currentQuoteId: typeof value.currentQuoteId === 'string' ? value.currentQuoteId : '',
    seenQuoteIds: [...new Set((Array.isArray(value.seenQuoteIds) ? value.seenQuoteIds : [])
      .filter(id => typeof id === 'string' && id))],
  };
}

async function quoteForCurrentVisibleDay() {
  const today = localCalendarDateKey();
  const quotesById = new Map(dailyQuotes.map(entry => [entry.id, entry]));
  const current = quotesById.get(dailyQuoteState?.currentQuoteId);
  if (current && dailyQuoteState.lastShownDate === today) return current;

  let seenQuoteIds = (dailyQuoteState?.seenQuoteIds || []).filter(id => quotesById.has(id));
  let seen = new Set(seenQuoteIds);
  let candidates = dailyQuotes.filter(entry => !seen.has(entry.id));
  if (candidates.length === 0) {
    seenQuoteIds = [];
    seen = new Set();
    candidates = dailyQuotes.length > 1 && current
      ? dailyQuotes.filter(entry => entry.id !== current.id)
      : [...dailyQuotes];
  }
  const entry = candidates[0];
  if (!entry) return null;
  seen.add(entry.id);
  dailyQuoteState = {
    lastShownDate: today,
    currentQuoteId: entry.id,
    seenQuoteIds: [...seen],
  };
  await chrome.storage.local.set({ [DAILY_QUOTE_STATE_KEY]: dailyQuoteState });
  return entry;
}

function syncDailyQuoteLayout(quoteEl = document.getElementById('dailyQuote')) {
  if (!quoteEl || quoteEl.hidden) return;
  const leadEl = quoteEl.querySelector('.daily-quote__lead');
  const attributionEl = quoteEl.querySelector('.daily-quote__attribution');
  if (!leadEl || !attributionEl) return;
  quoteEl.classList.remove('is-stacked');
  const gap = Number.parseFloat(getComputedStyle(quoteEl).columnGap) || 0;
  quoteEl.classList.toggle(
    'is-stacked',
    leadEl.scrollWidth + attributionEl.scrollWidth + gap > quoteEl.clientWidth,
  );
}

async function renderDailyQuote() {
  const quoteEl = document.getElementById('dailyQuote');
  clearTimeout(dailyQuoteRefreshTimer);
  if (!quoteEl) return;
  if (!dailyQuotesEnabled || dailyQuotes.length === 0) {
    quoteEl.hidden = true;
    quoteEl.replaceChildren();
    return;
  }
  const entry = await quoteForCurrentVisibleDay();
  if (!entry) return;
  const leadEl = document.createElement('span');
  leadEl.className = 'daily-quote__lead';
  leadEl.append(document.createTextNode(`「${entry.quote}」`));
  if (entry.thoughts) {
    const thoughtsEl = document.createElement('span');
    thoughtsEl.className = 'daily-quote__thoughts';
    thoughtsEl.textContent = entry.thoughts;
    leadEl.append(document.createTextNode(' '), thoughtsEl);
  }
  const sourceEl = document.createElement('em');
  sourceEl.className = 'daily-quote__source';
  sourceEl.textContent = entry.source;
  const attributionEl = document.createElement('span');
  attributionEl.className = 'daily-quote__attribution';
  attributionEl.append(document.createTextNode('— '), sourceEl);
  quoteEl.replaceChildren(leadEl, attributionEl);
  quoteEl.hidden = false;
  requestAnimationFrame(() => syncDailyQuoteLayout(quoteEl));
  document.fonts?.ready.then(() => syncDailyQuoteLayout(quoteEl));

  const now = new Date();
  const nextLocalDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  dailyQuoteRefreshTimer = setTimeout(() => {
    renderDailyQuote().catch(() => {});
  }, nextLocalDay.getTime() - now.getTime() + 50);
}

window.addEventListener('resize', () => syncDailyQuoteLayout());

async function loadDailyQuotes() {
  try {
    const [response, stored] = await Promise.all([
      fetch(chrome.runtime.getURL('assets/data/daily-quotes.json')),
      chrome.storage.local.get([DAILY_QUOTES_ENABLED_KEY, DAILY_QUOTE_STATE_KEY]),
    ]);
    if (!response.ok) return;
    dailyQuotesEnabled = stored[DAILY_QUOTES_ENABLED_KEY] !== false;
    dailyQuoteState = normalizeDailyQuoteState(stored[DAILY_QUOTE_STATE_KEY]);
    const quotes = await response.json();
    dailyQuotes = Array.isArray(quotes)
      ? quotes.filter(entry => typeof entry?.quote === 'string' && entry.quote.trim()
        && typeof entry.source === 'string' && entry.source.trim())
        .map(entry => ({
          quote: entry.quote.trim(),
          thoughts: typeof entry.thoughts === 'string' ? entry.thoughts.trim() : '',
          source: entry.source.trim(),
        }))
        .map(entry => ({ ...entry, id: dailyQuoteId(entry) }))
      : [];
    await renderDailyQuote();
  } catch {
    dailyQuotes = [];
  }
}

async function createDashboardTabWithOrigin(source, createProperties) {
  const context = await dashboardTabOriginContext();
  traceTabOrigin('create-request', {
    source,
    url: typeof createProperties.url === 'string' ? createProperties.url : '',
    windowId: Number.isInteger(createProperties.windowId) ? createProperties.windowId : null,
    active: createProperties.active === true,
    ...context,
  });
  const tab = await chrome.tabs.create(createProperties);
  traceTabOrigin('create-result', {
    source,
    tabId: tab.id,
    url: typeof tab.pendingUrl === 'string' && tab.pendingUrl ? tab.pendingUrl : tab.url || '',
    windowId: tab.windowId,
  });
  if (Number.isInteger(tab.id)) {
    try {
      chrome.runtime.sendMessage(createRuntimeMessage(TAB_OUT_MESSAGES.RECORD_TAB_ORIGIN, {
        tabId: tab.id,
      })).catch(() => {});
    } catch {}
  }
  return tab;
}

function captainTraceTab(tab) {
  return {
    id: tab?.id,
    windowId: tab?.windowId,
    index: tab?.index,
    active: Boolean(tab?.active),
    status: tab?.status,
    url: typeof tab?.pendingUrl === 'string' && tab.pendingUrl
      ? tab.pendingUrl
      : typeof tab?.url === 'string' ? tab.url : '',
    title: typeof tab?.title === 'string' ? tab.title : '',
  };
}

// Keep failed favicon handling CSP-safe. Inline `onerror` handlers are blocked
// on extension pages, so hide failed chip icons through one delegated listener.
document.addEventListener('error', event => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.classList.contains('chip-favicon')) {
    image.hidden = true;
  }
}, true);

// Tab Out uses pointer gestures plus its own document-level shortcuts. Keep
// native control focus/navigation out of the dashboard so Chrome does not add
// accessibility focus rings or activate individual UI controls from Tab/keys.
const DASHBOARD_FOCUSABLE_SELECTOR = 'button, a[href], [tabindex], [role="button"]';

function removeDashboardControlFocus(root) {
  if (!(root instanceof Element || root instanceof Document)) return;
  const controls = [
    ...(root instanceof Element && root.matches(DASHBOARD_FOCUSABLE_SELECTOR) ? [root] : []),
    ...root.querySelectorAll(DASHBOARD_FOCUSABLE_SELECTOR),
  ];
  controls.forEach(control => {
    if (control instanceof HTMLElement) control.tabIndex = -1;
  });
}

removeDashboardControlFocus(document);
new MutationObserver(records => {
  records.forEach(record => {
    record.addedNodes.forEach(node => removeDashboardControlFocus(node));
  });
}).observe(document.body, { childList: true, subtree: true });

document.addEventListener('focusin', event => {
  if (event.target instanceof HTMLElement
    && event.target.matches(DASHBOARD_FOCUSABLE_SELECTOR)) event.target.blur();
}, true);

document.addEventListener('keydown', event => {
  if (event.key === 'Tab') event.preventDefault();
}, true);

function buttonIcon(name) {
  return `<span class="button-icon icon-${name}" aria-hidden="true"></span>`;
}

function escapeHtmlAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function keyboardPromptKeysHtml(keys, prefix = '') {
  const prefixHtml = prefix ? `<span class="prompt-label">${escapeHtmlAttribute(prefix)}</span>` : '';
  const keySymbols = {
    Esc: '<span class="prompt-key-word">ESC</span>',
    Shift: '⇧',
    Enter: '↵',
    Backspace: '⌫',
  };
  const keysHtml = keys.map((key, index) => {
    const displayKeyHtml = keySymbols[key] || escapeHtmlAttribute(key);
    return `${index > 0 ? '<span class="prompt-key-separator">+</span>' : ''}<kbd aria-label="${escapeHtmlAttribute(key)}">${displayKeyHtml}</kbd>`;
  }).join('');
  return `${prefixHtml}${keysHtml}`;
}

function keyboardPromptHtml(keys, label, prefix = '') {
  return `${keyboardPromptKeysHtml(keys, prefix)}<span class="prompt-label">${escapeHtmlAttribute(label)}</span>`;
}

/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];
let archivedTabIds = new Set();
let undoHistory = [];
let redoHistory = [];
let isUndoing = false;
let pocketVisible = false;
let readLaterEnabled = true;
let captainRetainedTabIds = new Set();
let captainTabOrder = [];
let candidateBatchMode = null;
let candidateTabIds = new Set();
let detectedErrorTabIds = new Set();
let candidateHeaderShimmerTimer = null;
let captainConfigs = [];
let captainConfig = null;
let uiLanguage = 'en';
let dashboardColumnCount = 3;
let pocketPosition = 'left';
let pocketGroupLooseTabs = true;
let pocketGroupOrder = [];
let pocketTabOrder = [];
let pocketItems = [];
let pocketLiveItemIds = {};
let pocketLifecycleMutationDepth = 0;
let tabCustomLabels = {};
let captainKeepCustomLabelsByTabId = new Map();
let captainKeepManifestSnapshot = null;
let captainPendingDeadItems = [];
const captainKeepLifecycleInFlight = new Set();
let captainLifecycleMutationDepth = 0;
let captainLifecycleRefreshSuppressedUntil = 0;
const recentlyRevivedCaptainTabIds = new Set();
const locallyPatchedExternalCaptainCloseKeepIds = new Set();
// Chrome emits a burst of ordinary tab mutations while windows are
// closing. Those events describe teardown, not an intentional Keep edit, and
// must never erase the cross-session Captain manifest.
let preserveCaptainManifestForWindowClose = false;
let captainManifestCloseGuardTimer = null;
let startupRestoreRetryRequested = false;

function guardCaptainManifestDuringWindowClose() {
  preserveCaptainManifestForWindowClose = true;
  clearTimeout(captainManifestCloseGuardTimer);
  // If the user closes a secondary window while this dashboard survives,
  // release the guard after Chrome's teardown event burst has settled. During
  // a full browser shutdown this document disappears before the timer matters.
  captainManifestCloseGuardTimer = setTimeout(() => {
    preserveCaptainManifestForWindowClose = false;
    captainManifestCloseGuardTimer = null;
  }, 10000);
}

const ARCHIVED_TAB_IDS_KEY = TAB_OUT_STORAGE.ARCHIVED_TAB_IDS_LEGACY;
const POCKET_TAB_IDS_KEY = TAB_OUT_STORAGE.POCKET_TAB_IDS;
const POCKET_ITEMS_KEY = TAB_OUT_STORAGE.POCKET_ITEMS;
const POCKET_LIVE_ITEM_IDS_KEY = TAB_OUT_STORAGE.POCKET_LIVE_ITEM_IDS;
const TAB_CUSTOM_LABELS_KEY = TAB_OUT_STORAGE.TAB_CUSTOM_LABELS;
const POCKET_SESSION_MIGRATION_KEY = TAB_OUT_STORAGE.POCKET_SESSION_MIGRATION;
const COIN_POCKET_VISIBLE_KEY = TAB_OUT_STORAGE.POCKET_VISIBLE;
const READ_LATER_ENABLED_KEY = TAB_OUT_STORAGE.POCKET_ENABLED;
const POCKET_POSITION_KEY = TAB_OUT_STORAGE.POCKET_POSITION;
const POCKET_GROUP_LOOSE_TABS_KEY = TAB_OUT_STORAGE.POCKET_GROUP_LOOSE_TABS;
const POCKET_GROUP_ORDER_KEY = TAB_OUT_STORAGE.POCKET_GROUP_ORDER;
const POCKET_TAB_ORDER_KEY = TAB_OUT_STORAGE.POCKET_TAB_ORDER;
const CAPTAIN_RETAINED_TAB_IDS_KEY = TAB_OUT_STORAGE.CAPTAIN_RETAINED_TAB_IDS;
const CAPTAIN_TAB_ORDER_KEY = TAB_OUT_STORAGE.CAPTAIN_TAB_ORDER;
const CAPTAIN_KEEP_MANIFEST_KEY = TAB_OUT_STORAGE.CAPTAIN_KEEP_MANIFEST;
const CAPTAIN_SESSION_TOKEN_KEY = TAB_OUT_STORAGE.CAPTAIN_SESSION_TOKEN;
const CAPTAIN_PENDING_DEAD_ITEMS_KEY = TAB_OUT_STORAGE.CAPTAIN_PENDING_DEAD_ITEMS;
const STARTUP_PRUNE_STATE_KEY = TAB_OUT_STORAGE.CAPTAIN_STARTUP_PRUNE_STATE;
const UI_LANGUAGE_KEY = TAB_OUT_STORAGE.UI_LANGUAGE;
const DASHBOARD_COLUMNS_KEY = TAB_OUT_STORAGE.DASHBOARD_COLUMNS;
const DAILY_QUOTES_ENABLED_KEY = TAB_OUT_STORAGE.DAILY_QUOTES_ENABLED;
const DAILY_QUOTE_STATE_KEY = TAB_OUT_STORAGE.DAILY_QUOTE_STATE;
const PDF_GROUP_TITLE = 'PDF';
const CAPTAIN_CONFIG_KEY = TAB_OUT_STORAGE.CAPTAIN_CONFIG_LEGACY;
const CAPTAIN_CONFIGS_KEY = TAB_OUT_STORAGE.CAPTAIN_CONFIGS;
const CAPTAIN_GROUP_KEY = '__captain__';
const POCKET_LOOSE_GROUP_KEY = '__pocket_loose__';
const UNDO_HISTORY_KEY = TAB_OUT_STORAGE.UNDO_HISTORY;
const REDO_HISTORY_KEY = TAB_OUT_STORAGE.REDO_HISTORY;
const ERROR_TAB_SIGNALS_KEY = TAB_OUT_STORAGE.ERROR_TAB_SIGNALS;
const ERROR_DETECT_TRACE = '[tab-out error-detect]';
// History is capped by user operations; one entry may describe many tabs.
const MAX_UNDO_STEPS = 200;
const RUNTIME_STATE_REQUEST_TIMEOUT_MS = 2000;

function uiText(english, chinese) {
  return uiLanguage === 'zh' ? chinese : english;
}

function traceErrorDetect(stage, detail = {}) {
  console.log(`${ERROR_DETECT_TRACE} ${stage}`, JSON.stringify({
    timestamp: new Date().toISOString(),
    ...detail,
  }));
}

function withRuntimeStateTimeout(operation, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out while waiting for the service worker`));
    }, RUNTIME_STATE_REQUEST_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timeoutId));
}

async function loadUiLanguage() {
  try {
    const stored = await chrome.storage.local.get(UI_LANGUAGE_KEY);
    uiLanguage = stored[UI_LANGUAGE_KEY] === 'zh' ? 'zh' : 'en';
  } catch {
    uiLanguage = 'en';
  }
  globalThis.TabOutLanguage = uiLanguage;
  document.documentElement.lang = uiLanguage === 'zh' ? 'zh-CN' : 'en';
  document.querySelector('.keyboard-prompts')?.setAttribute('aria-label', uiText('Keyboard shortcuts', '键盘快捷键'));
  const selectionPrompt = document.getElementById('selectionKeyboardPrompt');
  if (selectionPrompt) selectionPrompt.innerHTML = '';
  const undoPrompt = document.getElementById('undoKeyboardPrompt');
  if (undoPrompt) undoPrompt.innerHTML = keyboardPromptHtml(
    ['⌘', 'Z'],
    uiText('Withdraw', '撤回'),
    uiText('', '按'),
  );
  const archiveEmpty = document.getElementById('archiveEmpty');
  if (archiveEmpty) archiveEmpty.textContent = '';
  const clearPocketButton = document.getElementById('clearArchiveButton');
  clearPocketButton?.setAttribute('aria-label', uiText('Delete every tab in Pocket', '清空「口袋」'));
  clearPocketButton?.setAttribute('data-pocket-tooltip', uiText('Clean Pocket', '清空「口袋」'));
  const killPocketButton = document.getElementById('killArchiveButton');
  killPocketButton?.setAttribute('aria-label', uiText('Kill every live tab in Pocket', '关闭「口袋」中所有 live 标签页'));
  killPocketButton?.setAttribute('data-pocket-tooltip', uiText('Kill live Pocket tabs', '关闭所有 live 标签页'));
  const restorePocketButton = document.getElementById('restoreArchiveButton');
  restorePocketButton?.setAttribute('aria-label', uiText('Restore every tab from Pocket', '掏光「口袋」'));
  restorePocketButton?.setAttribute('data-pocket-tooltip', uiText('Take everything out', '掏光「口袋」'));
  const movePocketButton = document.getElementById('cyclePocketPositionButton');
  movePocketButton?.setAttribute('aria-label', uiText('Move Pocket', '移动「口袋」'));
  movePocketButton?.setAttribute('data-pocket-tooltip', uiText('Move Pocket', '移动「口袋」'));
}

async function loadDashboardColumns() {
  try {
    const stored = await chrome.storage.local.get(DASHBOARD_COLUMNS_KEY);
    dashboardColumnCount = stored[DASHBOARD_COLUMNS_KEY] === 2 ? 2 : 3;
  } catch {
    dashboardColumnCount = 3;
  }
}

function normalizePocketPosition(value) {
  return value === 'right' ? 'right' : 'left';
}

function applyPocketPosition() {
  document.body.classList.remove(
    'pocket-position-left',
    'pocket-position-right',
  );
  document.body.classList.add(`pocket-position-${pocketPosition}`);
  document.body.classList.remove('pocket-controls-visible');
}

let lastPocketPointer = null;

function syncPocketControlsVisibility(pointer = lastPocketPointer) {
  const pocket = document.getElementById('archiveSection');
  if (!pointer || !pocket || !readLaterEnabled) {
    document.body.classList.remove('pocket-controls-visible');
    return;
  }

  const bounds = pocket.getBoundingClientRect();
  let visible = false;
  if (pocketPosition === 'left') visible = pointer.x <= bounds.right;
  else visible = pointer.x >= bounds.left;
  document.body.classList.toggle('pocket-controls-visible', visible);
}

document.addEventListener('pointermove', event => {
  lastPocketPointer = { x: event.clientX, y: event.clientY };
  syncPocketControlsVisibility();
}, { passive: true });

document.addEventListener('pointerleave', () => {
  lastPocketPointer = null;
  document.body.classList.remove('pocket-controls-visible');
});

window.addEventListener('scroll', () => syncPocketControlsVisibility(), { passive: true });
window.addEventListener('resize', () => syncPocketControlsVisibility(), { passive: true });

async function loadPocketPosition() {
  try {
    const stored = await chrome.storage.local.get(POCKET_POSITION_KEY);
    pocketPosition = normalizePocketPosition(stored[POCKET_POSITION_KEY]);
  } catch {
    pocketPosition = 'left';
  }
  applyPocketPosition();
}

async function loadPocketGrouping() {
  try {
    const stored = await chrome.storage.local.get(POCKET_GROUP_LOOSE_TABS_KEY);
    pocketGroupLooseTabs = stored[POCKET_GROUP_LOOSE_TABS_KEY] !== false;
  } catch {
    pocketGroupLooseTabs = true;
  }
}

async function loadPocketManualOrder() {
  try {
    const stored = await chrome.storage.local.get([POCKET_GROUP_ORDER_KEY, POCKET_TAB_ORDER_KEY]);
    pocketGroupOrder = Array.isArray(stored[POCKET_GROUP_ORDER_KEY])
      ? stored[POCKET_GROUP_ORDER_KEY].filter(value => typeof value === 'string')
      : [];
    pocketTabOrder = normalizePocketOrderKeys(stored[POCKET_TAB_ORDER_KEY]);
  } catch {
    pocketGroupOrder = [];
    pocketTabOrder = [];
  }
}

function applyPocketManualOrder(groups) {
  const groupRank = new Map(pocketGroupOrder.map((key, index) => [key, index]));
  const tabRank = new Map(pocketTabOrder.map((id, index) => [id, index]));
  for (const group of groups) {
    group.tabs.sort((a, b) => {
      const aRank = tabRank.get(pocketOrderKey(a));
      const bRank = tabRank.get(pocketOrderKey(b));
      if (aRank !== undefined || bRank !== undefined) {
        return (aRank ?? Number.MAX_SAFE_INTEGER) - (bRank ?? Number.MAX_SAFE_INTEGER);
      }
      return (a.pocketOrder ?? Number.MAX_SAFE_INTEGER) - (b.pocketOrder ?? Number.MAX_SAFE_INTEGER);
    });
  }
  return groups.sort((a, b) => {
    const aCaptain = captainIndexForGroupKey(a.domain);
    const bCaptain = captainIndexForGroupKey(b.domain);
    if (aCaptain >= 0 || bCaptain >= 0) {
      if (aCaptain < 0) return 1;
      if (bCaptain < 0) return -1;
      return aCaptain - bCaptain;
    }
    return (groupRank.get(a.domain) ?? Number.MAX_SAFE_INTEGER)
      - (groupRank.get(b.domain) ?? Number.MAX_SAFE_INTEGER);
  });
}

function applyPocketVisibility(visible) {
  pocketVisible = readLaterEnabled && visible;
  document.body.classList.toggle('pocket-coin-hidden', !pocketVisible);
  document.body.classList.toggle('read-later-disabled', !readLaterEnabled);
  // Disabling Pocket is also a layout choice: clear any previously measured
  // side lane immediately so the coin and cards return to the viewport axis.
  syncDashboardAdaptiveLayout();
  const coin = document.getElementById('taboutMetalCoin');
  if (!coin) return;
  coin.dataset.side = pocketVisible ? 'visible' : 'hidden';
  coin.dispatchEvent(new CustomEvent(TAB_OUT_EVENTS.POCKET_VISIBILITY_SYNC, {
    detail: { visible: pocketVisible },
  }));
  syncArchiveLooseTabsHeaderPrompt();
  syncKeyboardPromptProgression();
}

async function loadReadLaterEnabled() {
  const stored = await chrome.storage.local.get(READ_LATER_ENABLED_KEY);
  readLaterEnabled = stored[READ_LATER_ENABLED_KEY] !== false;
  if (!readLaterEnabled) {
    pocketVisible = false;
    chrome.storage.session.set({ [COIN_POCKET_VISIBLE_KEY]: false }).catch(() => {});
  }
  applyPocketVisibility(pocketVisible);
}

async function loadCoinPocketVisibility() {
  // Retire the removed Angel/Demon preferences. The coin now starts with
  // Pocket hidden in each browser session and remembers only visibility.
  chrome.storage.local.remove([
    TAB_OUT_STORAGE.POCKET_DEFAULT_COIN_MODE_LEGACY,
    TAB_OUT_STORAGE.POCKET_PURE_DEMON_LEGACY,
    TAB_OUT_STORAGE.POCKET_DEMON_BULK_LEGACY,
  ]).catch(() => {});
  chrome.storage.session.remove(TAB_OUT_STORAGE.POCKET_COIN_MODE_LEGACY).catch(() => {});
  const stored = await chrome.storage.session.get(COIN_POCKET_VISIBLE_KEY);
  const visible = stored[COIN_POCKET_VISIBLE_KEY] === true;
  applyPocketVisibility(visible);
}

async function setCoinPocketVisibility(visible) {
  const nextVisible = readLaterEnabled && visible === true;
  const changed = pocketVisible !== nextVisible;
  applyPocketVisibility(nextVisible);
  await chrome.storage.session.set({ [COIN_POCKET_VISIBLE_KEY]: nextVisible });
  return changed ? 1 : 0;
}

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * The dashboard reads only what it needs to render and manage tabs.
 */
async function fetchOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      // A tab recreated by Undo can expose its destination only through
      // pendingUrl until its navigation commits. Prefer it so it renders and
      // can rejoin Pocket immediately rather than only after a refresh.
      url:      t.pendingUrl || t.url,
      title:    t.title,
      pendingUrl: t.pendingUrl,
      windowId: t.windowId,
      active:   t.active,
      groupId:  t.groupId,
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * POCKET STATE
 *
 * Live Pocket membership is Tab Out session state. Persistent Pocket items
 * retain their URL/title/order independently, then become dormant when their
 * live tab disappears at the end of a browser session.
 */
const normalizeTabIds = tabOutContracts.normalizeTabIds;
const normalizePocketOrderKeys = tabOutContracts.normalizeOrderKeys;
const normalizePocketItems = tabOutContracts.normalizePocketItems;
const normalizePocketLiveItemIds = tabOutContracts.normalizePocketLiveItemIds;
const normalizeCustomLabel = tabOutContracts.normalizeCustomLabel;
const normalizeTabCustomLabels = tabOutContracts.normalizeTabCustomLabels;

async function loadTabCustomLabels() {
  try {
    const stored = await chrome.storage.session.get(TAB_CUSTOM_LABELS_KEY);
    tabCustomLabels = normalizeTabCustomLabels(stored[TAB_CUSTOM_LABELS_KEY]);
  } catch {
    tabCustomLabels = {};
  }
}

async function setSessionTabCustomLabel(tabId, customLabel) {
  if (!Number.isInteger(tabId)) return Promise.resolve();
  const response = await chrome.runtime.sendMessage(createRuntimeMessage(TAB_OUT_MESSAGES.SET_TAB_CUSTOM_LABEL, {
    tabId,
    customLabel: normalizeCustomLabel(customLabel),
  }));
  if (!response?.ok) throw new Error(response?.error || 'Tab label update failed');
  tabCustomLabels = normalizeTabCustomLabels(response.tabCustomLabels);
}

function removeSessionTabCustomLabel(tabId) {
  return setSessionTabCustomLabel(tabId, '');
}

function pocketOrderKey(tab) {
  return typeof tab?.pocketItemId === 'string' ? tab.pocketItemId : tab?.id;
}

const normalizeCaptainConfigs = captainRules.normalizeConfigs;

function activeCaptainConfigs() {
  return captainConfigs.filter(config => config.enabled);
}

function captainUsesKeepArea(config) {
  return Boolean(config?.enabled && config.keepAreaEnabled !== false);
}

function captainGroupKey(index) {
  return index === 0 ? CAPTAIN_GROUP_KEY : `__captain_${index + 1}__`;
}

function captainIndexForGroupKey(groupKey) {
  if (groupKey === CAPTAIN_GROUP_KEY) return 0;
  const match = typeof groupKey === 'string' ? groupKey.match(/^__captain_(\d+)__$/) : null;
  const ordinal = Number(match?.[1]);
  return Number.isInteger(ordinal) && ordinal >= 2 ? ordinal - 1 : -1;
}

function captainConfigForGroupKey(groupKey) {
  const index = captainIndexForGroupKey(groupKey);
  return index >= 0 ? captainConfigs[index] : null;
}

function isCaptainGroupKey(groupKey) {
  return captainIndexForGroupKey(groupKey) >= 0;
}

function captainConfigKey(config = captainConfig) {
  return captainRules.configKey(config);
}

function captainDefaultTitle(config = captainConfig) {
  if (!config) return PDF_GROUP_TITLE;
  return config.type === 'task' ? config.domain : PDF_GROUP_TITLE;
}

function captainTitle(config = captainConfig) {
  return config?.customTitle || captainDefaultTitle(config);
}

function captainSetKey() {
  return captainRules.configSetKey(captainConfigs.filter(captainUsesKeepArea));
}

async function loadCaptainConfig() {
  try {
    const stored = await chrome.storage.local.get([CAPTAIN_CONFIGS_KEY, CAPTAIN_CONFIG_KEY]);
    captainConfigs = normalizeCaptainConfigs(stored[CAPTAIN_CONFIGS_KEY], stored[CAPTAIN_CONFIG_KEY]);
  } catch {
    captainConfigs = normalizeCaptainConfigs(null, null);
  }
  captainConfig = captainConfigs.find(config => config.enabled) || null;
  globalThis.TabOutCaptain = captainConfig ? {
    key: captainConfigKey(captainConfig),
    title: captainTitle(captainConfig),
  } : null;
  globalThis.TabOutCaptains = activeCaptainConfigs().map(config => ({
    key: captainConfigKey(config),
    title: captainTitle(config),
  }));
}

function matchesCaptainConfig(tab, config) {
  return captainRules.matchesTab(tab, config);
}

function captainIndexForTab(tab) {
  if ((tab?.captainDead === true || tab?.captainPendingDead === true)
    && Number.isInteger(tab.captainIndex)) return tab.captainIndex;
  return captainRules.captainIndexForTab(tab, captainConfigs);
}

function isCaptainTab(tab, config = null) {
  return config && typeof config === 'object'
    ? matchesCaptainConfig(tab, config)
    : captainIndexForTab(tab) >= 0;
}

function captainKeepAreaEnabledForTab(tab) {
  const captainIndex = captainIndexForTab(tab);
  return captainIndex >= 0 && captainUsesKeepArea(captainConfigs[captainIndex]);
}

async function captainSessionToken() {
  const stored = await chrome.storage.session.get(CAPTAIN_SESSION_TOKEN_KEY);
  if (typeof stored[CAPTAIN_SESSION_TOKEN_KEY] === 'string'
    && stored[CAPTAIN_SESSION_TOKEN_KEY]) {
    return stored[CAPTAIN_SESSION_TOKEN_KEY];
  }
  const token = crypto.randomUUID();
  await chrome.storage.session.set({ [CAPTAIN_SESSION_TOKEN_KEY]: token });
  return token;
}

function captainTabUrl(tab) {
  return typeof tab?.pendingUrl === 'string' && tab.pendingUrl
    ? tab.pendingUrl
    : typeof tab?.url === 'string' ? tab.url : '';
}

const normalizeCaptainKeepManifest = captainRules.normalizeKeepManifest;
const normalizeCaptainPendingDeadItems = captainRules.normalizePendingDeadItems;

function matchCaptainKeepManifestEntries(manifest, liveCaptainTabs) {
  if (!manifest || manifest.captainSetKey !== captainSetKey()) return [];
  const unmatched = new Set(liveCaptainTabs.map(tab => tab.id));
  const matches = [];

  for (const reference of manifest.tabs) {
    if (reference.state === 'dead') continue;
    const config = captainConfigs[reference.captainIndex];
    if (!config) continue;
    const match = liveCaptainTabs.find(tab => unmatched.has(tab.id)
      && captainIndexForTab(tab) === reference.captainIndex
      && captainConfigKey(config) === reference.captainKey
      && captainTabUrl(tab) === reference.url);
    if (!match) continue;
    unmatched.delete(match.id);
    matches.push({ tab: match, reference });
  }
  return matches;
}

function matchCaptainKeepManifest(manifest, liveCaptainTabs) {
  return matchCaptainKeepManifestEntries(manifest, liveCaptainTabs).map(match => match.tab.id);
}

function adoptExternalTabsIntoDeadCaptainKeep(manifest, liveCaptainTabs, retainedIds, order) {
  if (!manifest || manifest.captainSetKey !== captainSetKey()) {
    return { manifest, retainedIds, order, adopted: [] };
  }
  const assignedTabIds = new Set([
    ...retainedIds,
    ...manifest.tabs.filter(item => item.state !== 'dead' && Number.isInteger(item.tabId))
      .map(item => item.tabId),
  ]);
  const availableTabs = liveCaptainTabs.filter(tab =>
    Number.isInteger(tab.id) && !assignedTabIds.has(tab.id));
  const nextTabs = [...manifest.tabs];
  const nextRetainedIds = [...retainedIds];
  const nextOrder = [...order];
  const adopted = [];

  for (let index = 0; index < nextTabs.length; index += 1) {
    const reference = nextTabs[index];
    if (reference.state !== 'dead') continue;
    const config = captainConfigs[reference.captainIndex];
    if (!captainUsesKeepArea(config) || captainConfigKey(config) !== reference.captainKey) continue;
    const identityUrl = getPocketIdentityUrl(reference.url);
    if (!identityUrl) continue;
    const matchIndex = availableTabs.findIndex(tab =>
      captainIndexForTab(tab) === reference.captainIndex
      && getPocketIdentityUrl(captainTabUrl(tab)) === identityUrl);
    if (matchIndex < 0) continue;

    const [tab] = availableTabs.splice(matchIndex, 1);
    nextTabs[index] = {
      ...reference,
      state: 'live',
      tabId: tab.id,
      url: captainTabUrl(tab),
      title: typeof tab.title === 'string' && tab.title ? tab.title : reference.title,
    };
    nextRetainedIds.push(tab.id);
    const precedingLiveIds = nextTabs.slice(0, index)
      .filter(item => item.state !== 'dead' && Number.isInteger(item.tabId))
      .map(item => item.tabId);
    const precedingOrderIndexes = precedingLiveIds
      .map(id => nextOrder.indexOf(id))
      .filter(position => position >= 0);
    const insertionIndex = precedingOrderIndexes.length > 0
      ? Math.max(...precedingOrderIndexes) + 1
      : 0;
    nextOrder.splice(insertionIndex, 0, tab.id);
    adopted.push({ keepId: reference.keepId, tabId: tab.id, url: captainTabUrl(tab) });
  }

  return {
    manifest: { ...manifest, tabs: nextTabs },
    retainedIds: normalizeTabIds(nextRetainedIds),
    order: normalizeTabIds(nextOrder),
    adopted,
  };
}

function buildCaptainKeepManifest(liveCaptainTabs, retainedIds, sessionToken) {
  const tabsById = new Map(liveCaptainTabs.map(tab => [tab.id, tab]));
  const retainedSet = new Set(retainedIds);
  const orderedRetainedIds = captainTabOrder.filter(id => retainedSet.has(id) && tabsById.has(id));
  for (const tab of liveCaptainTabs) {
    if (!retainedSet.has(tab.id) || orderedRetainedIds.includes(tab.id)) continue;
    orderedRetainedIds.push(tab.id);
  }
  const liveEntries = orderedRetainedIds.map(id => {
    const tab = tabsById.get(id);
    const captainIndex = captainIndexForTab(tab);
    const previous = captainKeepManifestSnapshot?.tabs.find(item => item.state !== 'dead' && item.tabId === tab.id)
      || captainKeepManifestSnapshot?.tabs.find(item => item.captainIndex === captainIndex
        && item.url === captainTabUrl(tab));
    return {
      keepId: previous?.keepId || crypto.randomUUID(),
      state: 'live',
      tabId: tab.id,
      captainIndex,
      captainKey: captainConfigKey(captainConfigs[captainIndex]),
      url: captainTabUrl(tab),
      title: typeof tab.title === 'string' ? tab.title : '',
      ...(normalizeCustomLabel(captainKeepCustomLabelsByTabId.get(tab.id) || previous?.customLabel)
        ? { customLabel: normalizeCustomLabel(captainKeepCustomLabelsByTabId.get(tab.id) || previous?.customLabel) }
        : {}),
    };
  }).filter(item => item.url);
  const tabs = [];
  const deadAnchors = new Map();
  let precedingLiveCount = 0;
  for (const previous of captainKeepManifestSnapshot?.tabs || []) {
    if (previous.state !== 'dead') {
      precedingLiveCount += 1;
      continue;
    }
    // A live entry with the same stable identity means Undo/reopen revived
    // this slot; do not retain a second dead representation beside it.
    if (liveEntries.some(item => item.keepId === previous.keepId)) continue;
    const config = captainConfigs[previous.captainIndex];
    if (!captainUsesKeepArea(config)
      || captainConfigKey(config) !== previous.captainKey
      || !matchesCaptainConfig({ url: previous.url }, config)) continue;
    const anchored = deadAnchors.get(precedingLiveCount) || [];
    anchored.push(previous);
    deadAnchors.set(precedingLiveCount, anchored);
  }
  for (let index = 0; index <= liveEntries.length; index += 1) {
    tabs.push(...(deadAnchors.get(index) || []));
    if (index < liveEntries.length) tabs.push(liveEntries[index]);
  }
  for (const [anchor, entries] of deadAnchors) {
    if (anchor > liveEntries.length) tabs.push(...entries);
  }
  return {
    version: 1,
    sessionToken,
    captainSetKey: captainSetKey(),
    tabs,
  };
}

function captainKeepManifestsEqual(first, second) {
  if (!first || !second
    || first.sessionToken !== second.sessionToken
    || first.captainSetKey !== second.captainSetKey
    || first.tabs.length !== second.tabs.length) return false;
  return first.tabs.every((item, index) => {
    const other = second.tabs[index];
    return item.keepId === other.keepId
      && item.state === other.state
      && item.captainIndex === other.captainIndex
      && item.tabId === other.tabId
      && item.captainKey === other.captainKey
      && item.url === other.url
      && item.title === other.title
      && normalizeCustomLabel(item.customLabel) === normalizeCustomLabel(other.customLabel);
  });
}

function deadCaptainKeepTabs() {
  return (captainKeepManifestSnapshot?.tabs || []).flatMap((item, index) => {
    if (item.state !== 'dead') return [];
    const config = captainConfigs[item.captainIndex];
    if (!captainUsesKeepArea(config)
      || captainConfigKey(config) !== item.captainKey
      || !matchesCaptainConfig({ url: item.url }, config)) return [];
    return [{
      url: item.url,
      title: item.title,
      captainDead: true,
      captainKeepId: item.keepId,
      captainIndex: item.captainIndex,
      captainManifestOrder: index,
      ...(normalizeCustomLabel(item.customLabel) ? { customLabel: item.customLabel } : {}),
    }];
  });
}

function deadCaptainPendingTabs() {
  return captainPendingDeadItems.flatMap(item => {
    const config = captainConfigs[item.captainIndex];
    if (!captainUsesKeepArea(config)
      || captainConfigKey(config) !== item.captainKey
      || !matchesCaptainConfig({ url: item.url }, config)) return [];
    return [{
      url: item.url,
      title: item.title,
      captainPendingDead: true,
      captainPendingDeadId: item.id,
      captainIndex: item.captainIndex,
      captainPendingOrder: item.order,
      ...(normalizeCustomLabel(item.customLabel) ? { customLabel: item.customLabel } : {}),
    }];
  });
}

function captainPendingDeadItemSnapshot(itemId) {
  return captainPendingDeadItems.find(item => item.id === itemId) || null;
}

async function moveDeadCaptainItemToPocket({ keepId = '', pendingItemId = '' }) {
  const keepEntry = keepId
    ? captainKeepManifestSnapshot?.tabs.find(item => item.keepId === keepId && item.state === 'dead')
    : null;
  const pendingItem = pendingItemId ? captainPendingDeadItemSnapshot(pendingItemId) : null;
  const source = keepEntry || pendingItem;
  if (!source?.url) return { moved: false, removedDuplicateCount: 0 };

  beginDashboardRefreshSuppression();
  const pocketItem = {
    id: crypto.randomUUID(),
    url: source.url,
    title: source.title || '',
    order: pocketItems.length === 0
      ? 0
      : Math.max(...pocketItems.map(item => Number(item.order) || 0)) + 1,
    state: 'dead',
    ...(normalizeCustomLabel(source.customLabel) ? { customLabel: source.customLabel } : {}),
  };
  try {
    const pocketResult = await requestPocketStateMutation(
      'replace-dormant', [], [pocketItem.id], '', pocketItem,
    );
    if (keepEntry) await requestCaptainKeepLifecycle('remove-dead', { keepId });
    else await requestCaptainKeepLifecycle('remove-pending-dead', { keepItem: { pendingItemId } });
    return { moved: true, removedDuplicateCount: pocketResult.removedDuplicateCount };
  } finally {
    setTimeout(() => {
      cancelScheduledDashboardRefresh();
      endDashboardRefreshSuppression();
    }, 180);
  }
}

function isLiveCaptainKeepTab(tab) {
  if (!Number.isInteger(tab?.id) || !captainKeepAreaEnabledForTab(tab)) return false;
  if (captainRetainedTabIds.has(tab.id)) return true;
  return Boolean(captainKeepManifestSnapshot?.tabs.some(item =>
    item.state !== 'dead' && item.tabId === tab.id));
}

function duplicatePartitionKey(tab) {
  if (!isCaptainTab(tab)) return 'open';
  const captainIndex = captainIndexForTab(tab);
  return `captain-${captainIndex}-${isLiveCaptainKeepTab(tab) ? 'keep' : 'pending'}`;
}

function duplicateIdentityKey(tab) {
  const identityUrl = getPocketIdentityUrl(tab?.pendingUrl || tab?.url || '');
  return identityUrl ? `${duplicatePartitionKey(tab)}\n${identityUrl}` : '';
}

async function requestCaptainKeepLifecycle(operation, { keepId = '', tabId = null, keepItem = null } = {}) {
  const diagnosticStartedAt = performance.now();
  globalThis.TabOutDiagnostics?.mark('captain:mutation-start', { operation });
  captainLifecycleMutationDepth += 1;
  captainLifecycleRefreshSuppressedUntil = Math.max(
    captainLifecycleRefreshSuppressedUntil,
    Date.now() + 500,
  );
  try {
    const response = await withRuntimeStateTimeout(
      chrome.runtime.sendMessage(createRuntimeMessage(
        TAB_OUT_MESSAGES.MUTATE_CAPTAIN_KEEP_LIFECYCLE,
        {
        operation,
        keepId,
        tabId,
        keepItem,
        },
      )),
      `Captain ${operation}`,
    );
    if (!response?.ok) throw new Error(response?.error || 'Captain Keep lifecycle update failed');
    if (operation === 'revive') {
      traceCaptainKeepRevive('background-response', {
        createdTabId: response.createdTab?.id ?? null,
        retainedIds: response.retainedIds || [],
        order: response.order || [],
        manifestEntry: response.manifest?.tabs?.find(item => item.keepId === keepId) || null,
      });
    }
    captainKeepManifestSnapshot = normalizeCaptainKeepManifest(response.manifest);
    captainRetainedTabIds = new Set(normalizeTabIds(response.retainedIds));
    captainTabOrder = normalizeTabIds(response.order);
    if (Array.isArray(response.pendingDeadItems)) {
      captainPendingDeadItems = normalizeCaptainPendingDeadItems(response.pendingDeadItems);
    }
    if (Number.isInteger(response.createdTab?.id)) {
      recentlyRevivedCaptainTabIds.add(response.createdTab.id);
      setTimeout(() => recentlyRevivedCaptainTabIds.delete(response.createdTab.id), 10000);
    }
    captainLifecycleRefreshSuppressedUntil = Math.max(
      captainLifecycleRefreshSuppressedUntil,
      Date.now() + 500,
    );
    globalThis.TabOutDiagnostics?.mark('captain:mutation-complete', {
      operation,
      durationMs: Math.round(performance.now() - diagnosticStartedAt),
    });
    return response;
  } catch (error) {
    globalThis.TabOutDiagnostics?.mark('captain:mutation-error', {
      operation,
      durationMs: Math.round(performance.now() - diagnosticStartedAt),
      error: String(error?.message || error),
    });
    throw error;
  } finally {
    captainLifecycleMutationDepth = Math.max(0, captainLifecycleMutationDepth - 1);
  }
}

function applyLocalCaptainKeepRevival(keepId, tab) {
  if (!captainKeepManifestSnapshot || !Number.isInteger(tab?.id)) return;
  captainKeepManifestSnapshot = {
    ...captainKeepManifestSnapshot,
    tabs: captainKeepManifestSnapshot.tabs.map(item => item.keepId === keepId ? {
      ...item,
      state: 'live',
      tabId: tab.id,
      title: typeof tab.title === 'string' && tab.title ? tab.title : item.title,
    } : item),
  };
  captainRetainedTabIds.add(tab.id);
  if (!captainTabOrder.includes(tab.id)) captainTabOrder.push(tab.id);
}

async function openDeadCaptainKeep(keepId, keepItem) {
  const createdTab = await createDashboardTabWithOrigin('captain-keep-revive', {
    url: keepItem.url,
    active: true,
  });
  try {
    return await requestCaptainKeepLifecycle('revive-existing', {
      keepId,
      tabId: createdTab.id,
    });
  } catch (error) {
    // Opening is the user's primary action. Keep the new tab usable even if a
    // stale/restarting worker cannot attach the persisted Keep record yet.
    console.warn('[tab-out] Reopened Captain tab before Keep state synchronized:', error);
    applyLocalCaptainKeepRevival(keepId, createdTab);
    return { createdTab, deferredStateSync: true };
  }
}

async function openDeadCaptainPending(pendingItemId, pendingItem) {
  const createdTab = await createDashboardTabWithOrigin('captain-pending-revive', {
    url: pendingItem.url,
    active: true,
  });
  try {
    return await requestCaptainKeepLifecycle('revive-pending-existing', {
      tabId: createdTab.id,
      keepItem: { pendingItemId },
    });
  } catch (error) {
    console.warn('[tab-out] Reopened Pending tab before its state synchronized:', error);
    captainPendingDeadItems = captainPendingDeadItems.filter(item => item.id !== pendingItemId);
    return { createdTab, deferredStateSync: true };
  }
}

function patchCaptainKeepChip(keepId, state, tab = null) {
  const chip = document.querySelector(`.page-chip[data-captain-keep-id="${CSS.escape(keepId)}"]`);
  if (!chip) return false;
  const previousTabId = Number(chip.dataset.tabId);
  const actions = chip.querySelector('.chip-actions');
  const label = chip.querySelector('[data-chip-label]');
  if (!actions || !label) return false;

  if (state === 'dead') {
    chip.classList.add('is-dead-captain-keep');
    chip.classList.remove('is-delete-pending', 'chip-has-dupes', 'cleanup-item', 'candidate', 'chip-error');
    chip.dataset.action = 'revive-captain-keep';
    delete chip.dataset.tabId;
    delete chip.dataset.dragTabId;
    chip.dataset.dragCaptainKeepId = keepId;
    chip.setAttribute('draggable', 'true');
    label.classList.add('tab-drag-handle');
    chip.closest('.page-chip-wrapper')?.classList.remove('has-duplicate-stack');
    chip.querySelector('.chip-dupe-indicator')?.remove();
    actions.innerHTML = `<button class="chip-action chip-close icon-button" data-action="close-dead-captain-keep" data-captain-keep-id="${escapeHtmlAttribute(keepId)}" aria-label="${uiText('Remove this dead tab from Keep', '从保留区彻底移除此失效标签页')}">${buttonIcon('close')}</button>`;
    const deadTab = deadCaptainKeepTabs().find(item => item.captainKeepId === keepId);
    if (deadTab) {
      for (const group of domainGroups) {
        group.tabs = group.tabs.map(item => item.id === previousTabId ? deadTab : item);
      }
    }
    return true;
  }

  if (!Number.isInteger(tab?.id)) return false;
  chip.classList.remove('is-dead-captain-keep', 'is-delete-pending');
  chip.dataset.action = 'focus-tab';
  chip.dataset.tabId = String(tab.id);
  chip.dataset.dragTabId = String(tab.id);
  delete chip.dataset.dragCaptainKeepId;
  chip.setAttribute('draggable', 'true');
  label.classList.add('tab-drag-handle');
  const identityUrl = getPocketIdentityUrl(tab.pendingUrl || tab.url || '');
  const captainIndex = captainIndexForTab(tab);
  const duplicatePartition = duplicatePartitionKey(tab);
  const duplicateCount = openTabs.filter(candidate =>
    !archivedTabIds.has(candidate.id)
    && captainIndexForTab(candidate) === captainIndex
    && duplicatePartitionKey(candidate) === duplicatePartition
    && getPocketIdentityUrl(candidate.pendingUrl || candidate.url || '') === identityUrl).length;
  const hasDuplicates = Boolean(identityUrl && duplicateCount > 1);
  chip.classList.toggle('chip-has-dupes', hasDuplicates);
  chip.classList.toggle('cleanup-item', hasDuplicates);
  chip.closest('.page-chip-wrapper')?.classList.toggle('has-duplicate-stack', hasDuplicates);
  chip.querySelector('.chip-dupe-indicator')?.remove();
  if (hasDuplicates) {
    chip.insertAdjacentHTML(
      'afterbegin',
      `<span class="chip-dupe-indicator" aria-hidden="true">${duplicateCount}X</span>`,
    );
  }
  const trailingAction = hasDuplicates
    ? `<button class="chip-action chip-close chip-dedup icon-button" data-action="dedup-tab" data-tab-id="${tab.id}" data-tab-url="${escapeHtmlAttribute(tab.pendingUrl || tab.url || '')}" aria-label="${uiText('Remove duplicate copies', '去除重复副本')}">${buttonIcon('minus')}</button>`
    : `<button class="chip-action chip-close chip-kill icon-button" data-action="kill-captain-keep" data-tab-id="${tab.id}" data-captain-keep-id="${escapeHtmlAttribute(keepId)}" aria-label="${uiText('Kill this tab but keep its place', '关闭此标签页但保留其位置')}">${buttonIcon('kill')}</button>`;
  actions.innerHTML = `<button class="archive-tab-button icon-button" data-action="archive-tab" data-tab-id="${tab.id}" aria-label="${uiText('Put in Pocket', '扔进「口袋」')}">${buttonIcon('archive')}</button>
    ${trailingAction}`;
  for (const group of domainGroups) {
    group.tabs = group.tabs.map(item => item.captainKeepId === keepId ? tab : item);
  }
  return true;
}

function removeCaptainKeepChip(keepId) {
  const chip = document.querySelector(`.page-chip[data-captain-keep-id="${CSS.escape(keepId)}"]`);
  const wrapper = chip?.closest('.page-chip-wrapper');
  const card = chip?.closest('.mission-card');
  for (const group of domainGroups) {
    group.tabs = group.tabs.filter(item => item.captainKeepId !== keepId);
  }
  wrapper?.remove();
  if (card && card.querySelectorAll('.page-chip').length === 0) {
    card.closest('.domain-card-shell')?.remove();
  }
  return Boolean(chip);
}

function patchExternallyClosedCaptainKeepTab(tabId) {
  const entry = captainKeepManifestSnapshot?.tabs.find(item =>
    item.state !== 'dead' && item.tabId === tabId);
  if (!entry?.keepId) return false;

  captainKeepManifestSnapshot = {
    ...captainKeepManifestSnapshot,
    tabs: captainKeepManifestSnapshot.tabs.map(item => item.keepId === entry.keepId
      ? { ...item, state: 'dead', tabId: null }
      : item),
  };
  captainRetainedTabIds.delete(tabId);
  captainTabOrder = captainTabOrder.filter(id => id !== tabId);
  openTabs = openTabs.filter(tab => tab.id !== tabId);
  locallyPatchedExternalCaptainCloseKeepIds.add(entry.keepId);

  const patched = patchCaptainKeepChip(entry.keepId, 'dead');
  if (patched) {
    const activeTabs = openTabs.filter(tab => isManageableTab(tab) && !archivedTabIds.has(tab.id));
    updateCandidateBatch(activeTabs);
    syncCandidateHeaderPrompt();
    syncKeyboardPromptProgression();
  }

  setTimeout(() => {
    if (!locallyPatchedExternalCaptainCloseKeepIds.delete(entry.keepId)) return;
    scheduleDashboardRefresh();
  }, 3000);
  return patched;
}

function removeClosedCaptainTabWithoutCardRender(tabId) {
  const tab = openTabs.find(candidate => candidate.id === tabId);
  if (!tab || !captainKeepAreaEnabledForTab(tab) || isLiveCaptainKeepTab(tab)) return false;
  const chip = document.querySelector(`.captain-group-card[data-area="open"] .page-chip[data-tab-id="${tabId}"]`);
  const card = chip?.closest('.captain-group-card');
  const hasDeadKeep = Boolean(card?.querySelector(
    '.captain-subgroup-retained .page-chip.is-dead-captain-keep[data-captain-keep-id]',
  ));
  if (!chip || !card || !hasDeadKeep) return false;

  openTabs = openTabs.filter(candidate => candidate.id !== tabId);
  for (const group of domainGroups) {
    group.tabs = group.tabs.filter(candidate => candidate.id !== tabId);
  }
  chip.closest('.page-chip-wrapper')?.remove();
  const pendingList = card.querySelector('.captain-subgroup-pending .mission-pages');
  const pendingEmpty = !pendingList?.querySelector('.page-chip');
  card.querySelector('.captain-subgroup-pending')?.classList.toggle('is-empty', pendingEmpty);
  card.querySelectorAll('.captain-subgroup-actions button').forEach(button => {
    button.disabled = pendingEmpty;
  });
  const activeTabs = openTabs.filter(candidate =>
    isManageableTab(candidate) && !archivedTabIds.has(candidate.id));
  updateCandidateBatch(activeTabs);
  syncCandidateHeaderPrompt();
  syncKeyboardPromptProgression();
  return true;
}

function optimisticallyResolveCaptainKeepDuplicates(keepId, clickedTabId, duplicateIds) {
  const targetIds = new Set(normalizeTabIds(duplicateIds));
  const clickedTab = openTabs.find(tab => tab.id === clickedTabId);
  if (!clickedTab || targetIds.size === 0) return false;
  openTabs = openTabs.filter(tab => !targetIds.has(tab.id));
  for (const group of domainGroups) {
    group.tabs = group.tabs.filter(tab => !targetIds.has(tab.id));
  }
  const patched = patchCaptainKeepChip(keepId, 'live', clickedTab);
  const activeTabs = openTabs.filter(tab => isManageableTab(tab) && !archivedTabIds.has(tab.id));
  updateCandidateBatch(activeTabs);
  syncCandidateHeaderPrompt();
  syncKeyboardPromptProgression();
  traceCaptainKeepDedup('optimistic-ui-complete', {
    clickedTabId,
    removedDuplicateIds: [...targetIds],
    domPatched: patched,
  });
  return patched;
}

function captainKeepItemSnapshot(keepId) {
  const index = (captainKeepManifestSnapshot?.tabs || []).findIndex(item => item.keepId === keepId);
  if (index < 0) return null;
  return { ...captainKeepManifestSnapshot.tabs[index], manifestIndex: index };
}

async function applyCaptainKeepHistory(entry, reverse) {
  const keepId = entry.keepItem?.keepId || '';
  if (!keepId) return { count: 0, entry };
  let response;
  if (entry.transition === 'kill') {
    if (reverse) {
      response = await requestCaptainKeepLifecycle('revive', { keepId });
      if (response.createdTab) {
        openTabs = [...openTabs.filter(tab => tab.id !== response.createdTab.id), response.createdTab];
      }
      return {
        count: 1,
        entry: { ...entry, tabId: response.createdTab?.id ?? null },
        domPatched: patchCaptainKeepChip(keepId, 'live', response.createdTab),
      };
    }
    if (Number.isInteger(entry.tabId)) markTabsForLocalClose([entry.tabId]);
    response = await requestCaptainKeepLifecycle('kill', { keepId, tabId: entry.tabId });
    openTabs = openTabs.filter(tab => tab.id !== entry.tabId);
  } else if (entry.transition === 'revive') {
    if (reverse) {
      if (Number.isInteger(entry.tabId)) markTabsForLocalClose([entry.tabId]);
      response = await requestCaptainKeepLifecycle('kill', { keepId, tabId: entry.tabId });
      openTabs = openTabs.filter(tab => tab.id !== entry.tabId);
    } else {
      response = await requestCaptainKeepLifecycle('revive', { keepId });
      if (response.createdTab) {
        openTabs = [...openTabs.filter(tab => tab.id !== response.createdTab.id), response.createdTab];
      }
      return {
        count: 1,
        entry: { ...entry, tabId: response.createdTab?.id ?? null },
        domPatched: patchCaptainKeepChip(keepId, 'live', response.createdTab),
      };
    }
  } else if (entry.transition === 'remove-dead') {
    response = reverse
      ? await requestCaptainKeepLifecycle('restore-dead', { keepItem: entry.keepItem })
      : await requestCaptainKeepLifecycle('remove-dead', { keepId });
  } else {
    return { count: 0, entry };
  }
  return {
    count: response?.ok === false ? 0 : 1,
    entry,
    domPatched: entry.transition === 'kill' || entry.transition === 'revive'
      ? patchCaptainKeepChip(keepId, 'dead')
      : false,
  };
}

async function applyCaptainPendingDeadHistory(entry, reverse) {
  if (entry?.transition !== 'unkeep' || !entry.keepEntry?.keepId || !entry.pendingItem?.id) return 0;
  if (reverse) {
    await requestCaptainKeepLifecycle('restore-unkept-dead', {
      keepItem: {
        keepEntry: entry.keepEntry,
        pendingItemId: entry.pendingItem.id,
        manifestIndex: entry.keepEntry.manifestIndex,
      },
    });
  } else {
    await requestCaptainKeepLifecycle('unkeep-dead', {
      keepId: entry.keepEntry.keepId,
      keepItem: { pendingItemId: entry.pendingItem.id },
    });
  }
  return 1;
}

async function persistCaptainSubgroupState(
  liveCaptainTabs,
  { preserveManifest = false, expectedManifest = captainKeepManifestSnapshot } = {},
) {
  const retainedIds = normalizeTabIds([...captainRetainedTabIds]);
  const order = normalizeTabIds(captainTabOrder);
  const nextManifest = preserveManifest
    ? null
    : buildCaptainKeepManifest(
      liveCaptainTabs,
      retainedIds,
      await captainSessionToken(),
    );
  traceCaptainKeep('persist:before-write', {
    preserveManifest,
    retainedIds,
    order,
    liveCaptainTabs: liveCaptainTabs.map(captainTraceTab),
    manifest: nextManifest || '(preserved)',
  });
  const response = await withRuntimeStateTimeout(
    chrome.runtime.sendMessage(createRuntimeMessage(TAB_OUT_MESSAGES.REPLACE_CAPTAIN_STATE, {
      state: {
        expectedManifest,
        nextManifest,
        retainedIds,
        order,
        preserveManifest,
      },
    })),
    'Captain state synchronization',
  );
  if (!response?.ok) throw new Error(response?.error || 'Captain state update failed');
  if (response.conflict) {
    captainKeepManifestSnapshot = normalizeCaptainKeepManifest(response.manifest);
    captainRetainedTabIds = new Set(normalizeTabIds(response.retainedIds));
    captainTabOrder = normalizeTabIds(response.order);
    dashboardRenderRequested = true;
    throw new Error('Captain state changed while the dashboard was reconciling');
  }
  captainKeepManifestSnapshot = normalizeCaptainKeepManifest(response.manifest);
  traceCaptainKeep('persist:write-complete', {
    preserveManifest,
    retainedIds,
  });
}

/**
 * The Captain card's Keep/Pending split belongs only to this dashboard. It is
 * persisted locally by tab id and deliberately never changes Chrome's native
 * tab-group membership. Any new Captain match is absent from this set, so it
 * starts in Pending; ids disappear from the set when it leaves Open tabs.
 */
async function syncCaptainSubgroupState(activeTabs) {
  const liveCaptainTabs = activeTabs.filter(captainKeepAreaEnabledForTab);
  const liveCaptainIds = new Set(liveCaptainTabs
    .map(tab => tab.id)
    .filter(Number.isInteger));

  let storedIds = [];
  let storedOrder = [];
  let storedManifest = null;
  try {
    const stored = await chrome.storage.local.get([
      CAPTAIN_RETAINED_TAB_IDS_KEY,
      CAPTAIN_TAB_ORDER_KEY,
      CAPTAIN_KEEP_MANIFEST_KEY,
    ]);
    storedIds = normalizeTabIds(stored[CAPTAIN_RETAINED_TAB_IDS_KEY]);
    storedOrder = normalizeTabIds(stored[CAPTAIN_TAB_ORDER_KEY]);
    storedManifest = normalizeCaptainKeepManifest(stored[CAPTAIN_KEEP_MANIFEST_KEY]);
    captainKeepManifestSnapshot = storedManifest;
  } catch {
    storedIds = [...captainRetainedTabIds];
    storedOrder = [...captainTabOrder];
  }
  const persistedManifest = storedManifest;

  try {
    const sessionState = await chrome.storage.session.get(CAPTAIN_PENDING_DEAD_ITEMS_KEY);
    captainPendingDeadItems = normalizeCaptainPendingDeadItems(
      sessionState[CAPTAIN_PENDING_DEAD_ITEMS_KEY],
    );
  } catch {
    // The in-memory transient Pending records remain usable for this pass.
  }

  const sessionToken = await captainSessionToken();
  const startupState = (await chrome.storage.session.get(STARTUP_PRUNE_STATE_KEY))[STARTUP_PRUNE_STATE_KEY];
  const startupPruneActive = startupState?.phase === 'pending'
    || startupState?.phase === 'running'
    || startupState?.phase === 'waiting-for-window';
  const isNewBrowserSession = storedManifest
    && storedManifest.sessionToken !== sessionToken;
  let externallyAdoptedKeepTabs = [];
  if (!isNewBrowserSession && storedManifest) {
    const adoption = adoptExternalTabsIntoDeadCaptainKeep(
      storedManifest,
      liveCaptainTabs,
      storedIds,
      storedOrder,
    );
    storedManifest = adoption.manifest;
    storedIds = adoption.retainedIds;
    storedOrder = adoption.order;
    externallyAdoptedKeepTabs = adoption.adopted;
    if (externallyAdoptedKeepTabs.length > 0) {
      captainKeepManifestSnapshot = storedManifest;
      traceCaptainKeep('sync:adopt-external-dead-keep', {
        adopted: externallyAdoptedKeepTabs,
      });
    }
  }
  const remappedKeepEntries = isNewBrowserSession
    ? matchCaptainKeepManifestEntries(storedManifest, liveCaptainTabs)
    : [];
  const remappedKeepIds = remappedKeepEntries.map(match => match.tab.id);
  const storedLiveKeepEntryCount = storedManifest?.tabs.filter(item => item.state !== 'dead').length || 0;
  const remappedKeepManifestComplete = isNewBrowserSession
    && remappedKeepEntries.length === storedLiveKeepEntryCount;
  traceCaptainKeep('sync:snapshot', {
    sessionToken,
    startupState: startupState || null,
    isNewBrowserSession,
    closeGuard: preserveCaptainManifestForWindowClose,
    captainSetKey: captainSetKey(),
    storedIds,
    storedOrder,
    storedManifest,
    liveCaptainTabs: liveCaptainTabs.map(captainTraceTab),
    remappedKeepIds,
    remappedKeepManifestComplete,
  });
  const manifestLiveIds = !isNewBrowserSession
    ? storedManifest?.tabs
      .filter(item => item.state !== 'dead' && Number.isInteger(item.tabId) && liveCaptainIds.has(item.tabId))
      .map(item => item.tabId) || []
    : [];
  const retainedIds = isNewBrowserSession
    ? remappedKeepIds
    : normalizeTabIds([
      ...storedIds.filter(id => liveCaptainIds.has(id)),
      ...manifestLiveIds,
    ]);
  if (captainKeepReviveTrace) {
    const trackedTabId = captainKeepReviveTrace.createdTabId;
    traceCaptainKeepRevive('sync-classification', {
      trackedTabId,
      trackedTabIsLiveCaptain: liveCaptainIds.has(trackedTabId),
      storedIds,
      manifestLiveIds,
      retainedIds,
      storedManifestEntry: storedManifest?.tabs.find(item =>
        item.keepId === captainKeepReviveTrace.keepId) || null,
      inMemoryManifestEntry: captainKeepManifestSnapshot?.tabs.find(item =>
        item.keepId === captainKeepReviveTrace.keepId) || null,
    });
  }
  const orderedIds = isNewBrowserSession
    ? [...remappedKeepIds]
    : storedOrder.filter(id => liveCaptainIds.has(id));
  const orderedIdSet = new Set(orderedIds);
  for (const tab of liveCaptainTabs) {
    if (!Number.isInteger(tab.id) || orderedIdSet.has(tab.id)) continue;
    orderedIds.push(tab.id);
    orderedIdSet.add(tab.id);
  }
  captainRetainedTabIds = new Set(retainedIds);
  captainTabOrder = orderedIds;
  if (!isNewBrowserSession && storedManifest && !startupPruneActive
    && !preserveCaptainManifestForWindowClose) {
    const allLiveTabIds = new Set(getRealTabs().map(tab => tab.id));
    const missingRetainedIds = new Set(storedIds.filter(id => !allLiveTabIds.has(id)));
    if (missingRetainedIds.size > 0) {
      storedManifest = {
        ...storedManifest,
        tabs: storedManifest.tabs.map(item => item.state !== 'dead'
          && missingRetainedIds.has(item.tabId)
          ? { ...item, keepId: item.keepId || crypto.randomUUID(), state: 'dead', tabId: null }
          : item),
      };
      captainKeepManifestSnapshot = storedManifest;
    }
  }
  const retainedIdSet = new Set(retainedIds);
  const currentKeepReferences = isNewBrowserSession
    ? remappedKeepEntries.map(match => ({ tabId: match.tab.id, reference: match.reference }))
    : (storedManifest?.tabs || []).map(reference => ({ tabId: reference.tabId, reference }));
  captainKeepCustomLabelsByTabId = new Map(currentKeepReferences
    .filter(({ tabId, reference }) => retainedIdSet.has(tabId)
      && normalizeCustomLabel(reference.customLabel))
    .map(({ tabId, reference }) => [tabId, normalizeCustomLabel(reference.customLabel)]));

  const currentManifest = buildCaptainKeepManifest(liveCaptainTabs, retainedIds, sessionToken);
  const manifestChanged = !captainKeepManifestsEqual(storedManifest, currentManifest);

  const orderChanged = orderedIds.length !== storedOrder.length
    || orderedIds.some((id, index) => id !== storedOrder[index]);
  const emptyStartupShell = liveCaptainTabs.length === 0
    && getRealTabs().length === 0
    && (storedManifest?.tabs.filter(item => item.state !== 'dead').length || 0) > 0;
  if (emptyStartupShell && !startupPruneActive && !startupRestoreRetryRequested) {
    startupRestoreRetryRequested = true;
    traceCaptainKeep('restore:request-empty-startup-shell', {
      startupState: startupState || null,
      manifestTabCount: storedManifest.tabs.length,
    });
    chrome.runtime.sendMessage(createRuntimeMessage(
      TAB_OUT_MESSAGES.RETRY_CAPTAIN_STARTUP_RESTORE,
    )).then(response => {
      traceCaptainKeep('restore:request-response', response || null);
      if (!response?.ok) startupRestoreRetryRequested = false;
    }).catch(error => {
      startupRestoreRetryRequested = false;
      traceCaptainKeep('restore:request-error', {
        error: String(error?.message || error),
      });
    });
  }
  if (!storedManifest || isNewBrowserSession || externallyAdoptedKeepTabs.length > 0 || manifestChanged
    || retainedIds.length !== storedIds.length || orderChanged) {
    try {
      // A new Chrome session restores tabs incrementally. A partial remap must
      // retain the prior manifest, but a complete remap is now authoritative:
      // commit its current tab ids and current session token so later Keep
      // mutations continue through the normal session-token guard.
      await persistCaptainSubgroupState(liveCaptainTabs, {
        expectedManifest: persistedManifest,
        preserveManifest: Boolean(startupPruneActive
          || preserveCaptainManifestForWindowClose
          || (isNewBrowserSession && !remappedKeepManifestComplete)
          // A lone Tab Out/new-tab page is a startup shell, not affirmative
          // evidence that the user deleted every saved Keep tab.
          || emptyStartupShell),
      });
    } catch {
      // The in-memory split remains usable if storage is temporarily unavailable.
    }
  } else {
    traceCaptainKeep('sync:no-write-needed', {
      retainedIds,
      orderedIds,
    });
  }
}

function orderedOpenCaptainTabs(tabs) {
  const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
  const deadByKeepId = new Map(tabs.filter(tab => tab.captainDead)
    .map(tab => [tab.captainKeepId, tab]));
  const orderedTabs = [];
  const usedIds = new Set();
  for (const item of captainKeepManifestSnapshot?.tabs || []) {
    if (item.state === 'dead') {
      const dead = deadByKeepId.get(item.keepId);
      if (dead) orderedTabs.push(dead);
      continue;
    }
    const live = tabsById.get(item.tabId) || tabs.find(tab => !usedIds.has(tab.id)
      && !tab.captainDead
      && captainIndexForTab(tab) === item.captainIndex
      && captainTabUrl(tab) === item.url);
    if (live && isLiveCaptainKeepTab(live)) {
      orderedTabs.push(live);
      usedIds.add(live.id);
    }
  }
  for (const id of captainTabOrder) {
    const tab = tabsById.get(id);
    if (tab && !usedIds.has(id)) {
      orderedTabs.push(tab);
      usedIds.add(id);
    }
  }
  const pendingDeadTabs = tabs
    .filter(tab => tab.captainPendingDead)
    .sort((first, second) => first.captainPendingOrder - second.captainPendingOrder);
  for (const deadTab of pendingDeadTabs) {
    const pendingItem = captainPendingDeadItemSnapshot(deadTab.captainPendingDeadId);
    const anchorIndex = Number.isInteger(pendingItem?.beforeTabId)
      ? orderedTabs.findIndex(tab => tab.id === pendingItem.beforeTabId && !isLiveCaptainKeepTab(tab))
      : -1;
    orderedTabs.splice(anchorIndex >= 0 ? anchorIndex : orderedTabs.length, 0, deadTab);
  }
  const orderedIds = new Set(orderedTabs.map(tab => tab.id));
  const orderedDeadIds = new Set(orderedTabs.filter(tab => tab.captainDead).map(tab => tab.captainKeepId));
  const orderedPendingDeadIds = new Set(pendingDeadTabs.map(tab => tab.captainPendingDeadId));
  return orderedTabs.concat(tabs.filter(tab => tab.captainDead
    ? !orderedDeadIds.has(tab.captainKeepId)
    : tab.captainPendingDead
      ? !orderedPendingDeadIds.has(tab.captainPendingDeadId)
      : !orderedIds.has(tab.id)));
}

function captureCaptainLayoutState(tabs = openTabs) {
  const tabsById = new Map((Array.isArray(tabs) ? tabs : [])
    .filter(tab => Number.isInteger(tab?.id))
    .map(tab => [tab.id, tab]));
  return {
    captainKey: captainSetKey(),
    retainedIds: normalizeTabIds([...captainRetainedTabIds]),
    order: normalizeTabIds(captainTabOrder),
    // URLs prevent a history entry surviving a browser restart from applying
    // an old tab id to an unrelated new tab that happens to reuse that id.
    tabRefs: captainTabOrder.map(id => ({ id, url: tabsById.get(id)?.url || '' })),
  };
}

function normalizeCaptainLayoutState(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    captainKey: typeof state.captainKey === 'string' ? state.captainKey : 'pdf',
    retainedIds: normalizeTabIds(state.retainedIds),
    order: normalizeTabIds(state.order),
    tabRefs: (Array.isArray(state.tabRefs) ? state.tabRefs : [])
      .filter(ref => Number.isInteger(ref?.id))
      .map(ref => ({ id: ref.id, url: typeof ref.url === 'string' ? ref.url : '' })),
  };
}

function remapCaptainLayoutState(state, tabIdMap) {
  const normalized = normalizeCaptainLayoutState(state);
  if (!normalized || !(tabIdMap instanceof Map) || tabIdMap.size === 0) return normalized;
  const remapId = id => tabIdMap.get(id) || id;
  return {
    captainKey: normalized.captainKey,
    retainedIds: normalizeTabIds(normalized.retainedIds.map(remapId)),
    order: normalizeTabIds(normalized.order.map(remapId)),
    tabRefs: normalized.tabRefs.map(ref => ({ ...ref, id: remapId(ref.id) })),
  };
}

function captainLayoutStatesEqual(first, second) {
  const a = normalizeCaptainLayoutState(first);
  const b = normalizeCaptainLayoutState(second);
  if (!a || !b) return false;
  return a.captainKey === b.captainKey
    && a.retainedIds.length === b.retainedIds.length
    && a.retainedIds.every((id, index) => id === b.retainedIds[index])
    && a.order.length === b.order.length
    && a.order.every((id, index) => id === b.order[index]);
}

async function transferCaptainCustomLabels(previousRetainedIds, nextRetainedIds) {
  const previous = previousRetainedIds instanceof Set
    ? previousRetainedIds : new Set(previousRetainedIds || []);
  const next = nextRetainedIds instanceof Set
    ? nextRetainedIds : new Set(nextRetainedIds || []);
  for (const tabId of next) {
    if (previous.has(tabId)) continue;
    const customLabel = normalizeCustomLabel(tabCustomLabels[String(tabId)]);
    if (customLabel) {
      captainKeepCustomLabelsByTabId.set(tabId, customLabel);
      await removeSessionTabCustomLabel(tabId);
    }
  }
  for (const tabId of previous) {
    if (next.has(tabId)) continue;
    const customLabel = normalizeCustomLabel(captainKeepCustomLabelsByTabId.get(tabId));
    if (customLabel) await setSessionTabCustomLabel(tabId, customLabel);
    captainKeepCustomLabelsByTabId.delete(tabId);
  }
}

/** Restores a saved Captain split/order while leaving later matches untouched. */
async function applyCaptainLayoutState(state) {
  const target = normalizeCaptainLayoutState(state);
  if (!target || target.captainKey !== captainSetKey()) return 0;

  const allTabs = await chrome.tabs.query({});
  const archiveIds = await getPocketTabIds(allTabs);
  const liveCaptainTabs = allTabs.filter(tab => isManageableTab(tab)
    && captainKeepAreaEnabledForTab(tab)
    && !archiveIds.has(tab.id));
  const liveTabsById = new Map(liveCaptainTabs.map(tab => [tab.id, tab]));
  const expectedUrls = new Map(target.tabRefs.map(ref => [ref.id, ref.url]));
  const isMatchingLiveId = id => {
    const tab = liveTabsById.get(id);
    if (!tab) return false;
    const expectedUrl = expectedUrls.get(id);
    return !expectedUrl || (tab.pendingUrl || tab.url || '') === expectedUrl;
  };

  const currentOrder = normalizeTabIds(captainTabOrder.filter(id => liveTabsById.has(id)));
  const currentOrderIds = new Set(currentOrder);
  for (const tab of liveCaptainTabs) {
    if (currentOrderIds.has(tab.id)) continue;
    currentOrder.push(tab.id);
    currentOrderIds.add(tab.id);
  }

  const restoredOrder = target.order.filter(isMatchingLiveId);
  const restoredIds = new Set(restoredOrder);
  const nextOrder = [...restoredOrder, ...currentOrder.filter(id => !restoredIds.has(id))];
  const trackedIds = new Set([
    ...target.order.filter(isMatchingLiveId),
    ...target.retainedIds.filter(isMatchingLiveId),
  ]);
  const targetRetainedIds = new Set(target.retainedIds.filter(isMatchingLiveId));
  const nextRetainedIds = nextOrder.filter(id => trackedIds.has(id)
    ? targetRetainedIds.has(id)
    : captainRetainedTabIds.has(id));

  const before = captureCaptainLayoutState(liveCaptainTabs);
  const previousRetainedIds = new Set(captainRetainedTabIds);
  captainTabOrder = nextOrder;
  captainRetainedTabIds = new Set(nextRetainedIds);
  const after = captureCaptainLayoutState(liveCaptainTabs);
  if (captainLayoutStatesEqual(before, after)) return 0;

  await transferCaptainCustomLabels(previousRetainedIds, captainRetainedTabIds);
  await persistCaptainSubgroupState(liveCaptainTabs);
  return Math.max(1, trackedIds.size);
}

async function moveCaptainTabsToSubgroup(tabIds, destination, beforeTabId = null, captainGroup = null) {
  if (destination !== 'retained' && destination !== 'pending') return [];

  const targetCaptainGroup = captainGroup
    || domainGroups.find(group => (group.tabs || []).some(tab => tabIds.includes(tab.id)) && isCaptainGroupKey(group.domain));
  const openCaptainIds = new Set((targetCaptainGroup?.tabs || [])
    .map(tab => tab.id)
    .filter(Number.isInteger));
  const eligibleIds = normalizeTabIds(tabIds).filter(id => openCaptainIds.has(id));
  if (eligibleIds.length === 0) return [];

  const layoutBefore = captureCaptainLayoutState(targetCaptainGroup.tabs);
  const previousRetainedIds = new Set(captainRetainedTabIds);
  const previousOrder = [...captainTabOrder];
  const otherCaptainOrder = captainTabOrder.filter(id => !openCaptainIds.has(id));
  const shouldRetain = destination === 'retained';

  for (const id of eligibleIds) {
    if (shouldRetain) captainRetainedTabIds.add(id);
    else captainRetainedTabIds.delete(id);
  }

  const moveIdSet = new Set(eligibleIds);
  const currentOrder = captainTabOrder
    .filter(id => openCaptainIds.has(id));
  const currentOrderSet = new Set(currentOrder);
  for (const tab of targetCaptainGroup.tabs) {
    if (!Number.isInteger(tab.id) || currentOrderSet.has(tab.id)) continue;
    currentOrder.push(tab.id);
    currentOrderSet.add(tab.id);
  }

  const movedIds = currentOrder.filter(id => moveIdSet.has(id));
  let retainedOrder = currentOrder.filter(id => !moveIdSet.has(id) && captainRetainedTabIds.has(id));
  let pendingOrder = currentOrder.filter(id => !moveIdSet.has(id) && !captainRetainedTabIds.has(id));
  const destinationOrder = shouldRetain ? retainedOrder : pendingOrder;
  const insertionIndex = Number.isInteger(beforeTabId)
    ? destinationOrder.indexOf(beforeTabId)
    : -1;
  destinationOrder.splice(insertionIndex >= 0 ? insertionIndex : destinationOrder.length, 0, ...movedIds);
  if (shouldRetain) retainedOrder = destinationOrder;
  else pendingOrder = destinationOrder;
  // Ordering is independent per Captain. Moving inside this card must not
  // discard or reorder the other Captain's saved sequence.
  captainTabOrder = [...otherCaptainOrder, ...retainedOrder, ...pendingOrder];

  const membershipChanged = eligibleIds.some(id =>
    previousRetainedIds.has(id) !== captainRetainedTabIds.has(id));
  const orderChanged = captainTabOrder.length !== previousOrder.length
    || captainTabOrder.some((id, index) => id !== previousOrder[index]);
  if (!membershipChanged && !orderChanged) return [];

  await transferCaptainCustomLabels(previousRetainedIds, captainRetainedTabIds);
  await persistCaptainSubgroupState(openTabs.filter(captainKeepAreaEnabledForTab));
  await pushUndoEntry({
    type: 'captain-layout',
    before: layoutBefore,
    after: captureCaptainLayoutState(targetCaptainGroup.tabs),
    tabCount: eligibleIds.length,
  });
  return eligibleIds;
}

function latestRevisedLabelForIdentity(identityUrl, fallbackLabels = []) {
  const revisions = undoHistory
    .filter(entry => entry?.type === 'tab-label'
      && Number.isFinite(entry.renamedAt)
      && getPocketIdentityUrl(entry.url || '') === identityUrl)
    .sort((first, second) => second.renamedAt - first.renamedAt);
  if (revisions.length > 0) return normalizeCustomLabel(revisions[0].after);
  return fallbackLabels.map(normalizeCustomLabel).find(Boolean) || '';
}

async function setLiveCaptainKeepLabel(tabId, customLabel) {
  const nextLabel = normalizeCustomLabel(customLabel);
  const response = await chrome.runtime.sendMessage(createRuntimeMessage(TAB_OUT_MESSAGES.SET_CAPTAIN_KEEP_LABEL, {
    tabId,
    customLabel: nextLabel,
  }));
  if (!response?.ok) throw new Error(response?.error || 'Captain Keep label update failed');
  if (nextLabel) captainKeepCustomLabelsByTabId.set(tabId, nextLabel);
  else captainKeepCustomLabelsByTabId.delete(tabId);
}

function captainKeepEntriesForIdentity(captainIndex, identityUrl) {
  return (captainKeepManifestSnapshot?.tabs || []).filter(item =>
    item.captainIndex === captainIndex
    && getPocketIdentityUrl(item.url) === identityUrl);
}

async function removeCaptainKeepEntry(entry) {
  if (entry.state !== 'dead' && Number.isInteger(entry.tabId)) {
    await requestCaptainKeepLifecycle('kill', { keepId: entry.keepId, tabId: entry.tabId });
  }
  await requestCaptainKeepLifecycle('remove-dead', { keepId: entry.keepId });
}

async function dedupeLiveCaptainDropToKeep(tabIds, representativeIds, beforeTabId, captainGroup) {
  const representativeSet = new Set(normalizeTabIds(representativeIds));
  const draggedTabs = normalizeTabIds(tabIds)
    .map(id => openTabs.find(tab => tab.id === id))
    .filter(tab => tab && isCaptainTab(tab));
  for (const representative of [...draggedTabs]) {
    if (!representativeSet.has(representative.id)) continue;
    const identityUrl = getPocketIdentityUrl(representative.pendingUrl || representative.url || '');
    const captainIndex = captainIndexForTab(representative);
    for (const duplicate of openTabs) {
      if (!Number.isInteger(duplicate.id)
        || isLiveCaptainKeepTab(duplicate)
        || captainIndexForTab(duplicate) !== captainIndex
        || getPocketIdentityUrl(duplicate.pendingUrl || duplicate.url || '') !== identityUrl
        || draggedTabs.some(tab => tab.id === duplicate.id)) continue;
      draggedTabs.push(duplicate);
    }
  }
  const buckets = new Map();
  for (const tab of draggedTabs) {
    const identityUrl = getPocketIdentityUrl(tab.pendingUrl || tab.url || '');
    if (!identityUrl) continue;
    const bucket = buckets.get(identityUrl) || [];
    bucket.push(tab);
    buckets.set(identityUrl, bucket);
  }
  if (buckets.size === 0) return null;

  let removedCount = 0;
  const retainedWinnerIds = [];
  for (const [identityUrl, bucket] of buckets) {
    const captainIndex = captainIndexForTab(bucket[0]);
    const winner = bucket.find(tab => representativeSet.has(tab.id))
      || bucket.reduce((latest, tab) => tab.id > latest.id ? tab : latest, bucket[0]);
    const existingKeepEntries = captainKeepEntriesForIdentity(captainIndex, identityUrl);
    const latestLabel = latestRevisedLabelForIdentity(identityUrl, [
      customLabelForLiveTabBeforePocket(winner),
      ...bucket.map(customLabelForLiveTabBeforePocket),
      ...existingKeepEntries.map(entry => entry.customLabel),
    ]);

    for (const entry of existingKeepEntries) {
      await removeCaptainKeepEntry(entry);
      removedCount += 1;
    }
    const duplicateDraggedIds = bucket.filter(tab => tab.id !== winner.id).map(tab => tab.id);
    if (duplicateDraggedIds.length > 0) {
      const closed = await closeTabsWithUndo(duplicateDraggedIds);
      removedCount += closed.length;
    }
    const moved = await moveCaptainTabsToSubgroup([winner.id], 'retained', beforeTabId, captainGroup);
    if (moved.length > 0) retainedWinnerIds.push(winner.id);
    await setLiveCaptainKeepLabel(winner.id, latestLabel);
  }
  return { removedCount, retainedWinnerIds };
}

async function dedupeDeadCaptainDropToKeep(pendingItemId, beforeKeepId) {
  const pendingItem = captainPendingDeadItemSnapshot(pendingItemId);
  if (!pendingItem) return null;
  const identityUrl = getPocketIdentityUrl(pendingItem.url);
  if (!identityUrl) return null;
  const existingKeepEntries = captainKeepEntriesForIdentity(pendingItem.captainIndex, identityUrl);
  const existingLiveEntries = existingKeepEntries.filter(item =>
    item.state !== 'dead' && Number.isInteger(item.tabId));
  const latestLabel = latestRevisedLabelForIdentity(identityUrl, [
    pendingItem.customLabel,
    ...existingKeepEntries.map(entry => entry.customLabel),
  ]);
  let removedCount = 0;

  if (existingLiveEntries.length > 0) {
    const winner = existingLiveEntries.at(-1);
    for (const entry of existingKeepEntries) {
      if (entry.keepId === winner.keepId) continue;
      await removeCaptainKeepEntry(entry);
      removedCount += 1;
    }
    await requestCaptainKeepLifecycle('remove-pending-dead', {
      keepItem: { pendingItemId },
    });
    removedCount += 1;
    await setLiveCaptainKeepLabel(winner.tabId, latestLabel);
    return { removedCount, winnerState: 'live' };
  }

  for (const entry of existingKeepEntries) {
    await removeCaptainKeepEntry(entry);
    removedCount += 1;
  }
  await requestCaptainKeepLifecycle('keep-pending-dead', {
    keepItem: { pendingItemId, beforeKeepId, customLabel: latestLabel },
  });
  return { removedCount, winnerState: 'dead' };
}

function isBrowserInternalUrl(url) {
  return /^(?:chrome|edge|brave|devtools|chrome-extension):\/\//i.test(url || '');
}

function isManageableTab(tab) {
  const urls = [tab?.pendingUrl, tab?.url]
    .filter(url => typeof url === 'string' && url.length > 0);
  // Chrome's built-in PDF viewer can be an extension URL. Keep it visible
  // whenever its URL, pending URL, or title identifies it as a PDF.
  if (isPdfTab(tab)) return true;

  const tabOutRoot = chrome.runtime.getURL('');
  return urls.some(url => {
    const normalized = url.toLowerCase();
    return !url.startsWith(tabOutRoot)
      && normalized !== 'chrome://newtab/'
      && normalized !== 'about:blank'
      && normalized !== 'about:newtab';
  });
}

function isPdfTab(tab) {
  return captainRules.isPdfTab(tab);
}

const doiTitles = new Map();
const doiTitleRequests = new Map();
const arxivTitles = new Map();
const arxivTitleRequests = new Map();
const citationTitles = new Map();
const citationTitleRequests = new Map();

function doiFromTab(tab) {
  const values = [tab?.pendingUrl, tab?.url]
    .filter(value => typeof value === 'string' && value.length > 0);
  for (const value of values) {
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch {}
    const match = decoded.match(/(?:^|[^a-z0-9])((?:10\.\d{4,9})\/[^\s?#]+)/i);
    if (!match) continue;
    const doi = match[1].replace(/[.,;:]+$/, '').toLowerCase();
    if (/^10\.\d{4,9}\/\S+$/i.test(doi)) return doi;
  }
  return '';
}

function arxivIdFromTab(tab) {
  const values = [tab?.pendingUrl, tab?.url]
    .filter(value => typeof value === 'string' && value.length > 0);
  for (const value of values) {
    let decoded = value;
    // Chrome's built-in PDF viewer nests the source URL in its `file`
    // parameter, sometimes URL-encoded more than once.
    for (let pass = 0; pass < 3; pass += 1) {
      const candidates = [decoded];
      try {
        const parsed = new URL(decoded);
        const sourceUrl = parsed.searchParams.get('file');
        if (sourceUrl) candidates.push(sourceUrl);
      } catch {}

      for (const candidate of candidates) {
        try {
          const parsed = new URL(candidate);
          if (!/^(?:www\.)?arxiv\.org$/i.test(parsed.hostname)) continue;
          const match = decodeURIComponent(parsed.pathname)
            .match(/^\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v\d+)?)(?:\.pdf)?\/?$/i);
          if (match) return match[1].replace(/v\d+$/i, '').toLowerCase();
        } catch {}
      }

      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }
  }
  return '';
}

function acmDoiFromTab(tab) {
  return acmPaperRoute(tab)?.doi || '';
}

function paperTitleDescriptor(tab) {
  const arxivId = arxivIdFromTab(tab);
  if (arxivId) return { source: 'arxiv', id: arxivId };
  const acmDoi = acmDoiFromTab(tab);
  if (acmDoi) return { source: 'acm', id: acmDoi };
  const doi = isPdfTab(tab) ? doiFromTab(tab) : '';
  return doi ? { source: 'doi', id: doi } : null;
}

function cachedPaperTitle(tab) {
  const descriptor = paperTitleDescriptor(tab);
  if (!descriptor) return '';
  return descriptor.source === 'arxiv'
    ? arxivTitles.get(descriptor.id) || ''
    : doiTitles.get(descriptor.id) || '';
}

function citationTitleKey(tabId, url) {
  return Number.isInteger(tabId) && typeof url === 'string' && url
    ? `${tabId}\n${url}`
    : '';
}

function cachedCitationTitle(tab) {
  const key = citationTitleKey(tab?.id, tab?.pendingUrl || tab?.url || '');
  return key ? citationTitles.get(key) || '' : '';
}

function requestDoiTitle(doi) {
  if (!doi) return Promise.resolve('');
  if (doiTitles.has(doi)) return Promise.resolve(doiTitles.get(doi));
  if (doiTitleRequests.has(doi)) return doiTitleRequests.get(doi);
  const request = chrome.runtime.sendMessage(createRuntimeMessage(TAB_OUT_MESSAGES.GET_DOI_TITLE, {
    doi,
  })).then(response => {
    const title = typeof response?.title === 'string'
      ? response.title.replace(/\s+/g, ' ').trim()
      : '';
    doiTitles.set(doi, title);
    return title;
  }).catch(() => '').finally(() => doiTitleRequests.delete(doi));
  doiTitleRequests.set(doi, request);
  return request;
}

function requestArxivTitle(arxivId) {
  if (!arxivId) return Promise.resolve('');
  if (arxivTitles.has(arxivId)) return Promise.resolve(arxivTitles.get(arxivId));
  if (arxivTitleRequests.has(arxivId)) return arxivTitleRequests.get(arxivId);
  const request = chrome.runtime.sendMessage(createRuntimeMessage(TAB_OUT_MESSAGES.GET_ARXIV_TITLE, {
    arxivId,
  })).then(response => {
    const title = typeof response?.title === 'string'
      ? response.title.replace(/\s+/g, ' ').trim()
      : '';
    arxivTitles.set(arxivId, title);
    return title;
  }).catch(() => '').finally(() => arxivTitleRequests.delete(arxivId));
  arxivTitleRequests.set(arxivId, request);
  return request;
}

function requestPaperTitle({ source, id }) {
  return source === 'arxiv' ? requestArxivTitle(id) : requestDoiTitle(id);
}

function requestCitationTitle(tabId, url) {
  const key = citationTitleKey(tabId, url);
  if (!key) return Promise.resolve('');
  if (citationTitles.has(key)) return Promise.resolve(citationTitles.get(key));
  if (citationTitleRequests.has(key)) return citationTitleRequests.get(key);
  const readFromPage = () => chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const selectors = [
        'meta[name="citation_title"]',
        'meta[name="dc.title" i]',
        'meta[name="dcterms.title" i]',
        'meta[property="og:title"]',
      ];
      for (const selector of selectors) {
        const value = document.querySelector(selector)?.content?.replace(/\s+/g, ' ').trim();
        if (value) return value;
      }
      return '';
    },
  }).then(results => typeof results?.[0]?.result === 'string' ? results[0].result : '');
  const request = chrome.tabs.sendMessage(
    tabId,
    createRuntimeMessage(TAB_OUT_MESSAGES.GET_CITATION_TITLE),
  ).then(response => response?.title || '', readFromPage).then(rawTitle => {
    const title = typeof rawTitle === 'string'
      ? rawTitle.replace(/\s+/g, ' ').trim()
      : '';
    if (title) citationTitles.set(key, title);
    return title;
  }).catch(() => '').finally(() => citationTitleRequests.delete(key));
  citationTitleRequests.set(key, request);
  return request;
}

function hydrateRenderedPaperTitles() {
  document.querySelectorAll('.page-chip[data-auto-title-request]').forEach(chip => {
    const paper = chip.dataset.autoPaperTitleSource && chip.dataset.autoPaperTitleId
      ? {
        source: chip.dataset.autoPaperTitleSource,
        id: chip.dataset.autoPaperTitleId,
      }
      : null;
    const tabId = Number(chip.dataset.autoTitleTabId);
    const url = chip.dataset.autoTitleUrl || '';
    const structuredTitle = paper ? requestPaperTitle(paper) : Promise.resolve('');
    void structuredTitle.then(title => title
      || requestCitationTitle(tabId, url)).then(title => {
      if (!title || !chip.isConnected) return;
      const label = chip.querySelector('[data-chip-label]');
      if (label) label.textContent = title;
    });
  });
}

/**
 * Extract a human-readable PDF filename from the tab metadata available to
 * Chrome extensions. This also handles Chrome's PDF viewer URL, where the
 * source document is encoded in a `file` query parameter.
 */
function pdfFileName(tab) {
  const values = [tab?.pendingUrl, tab?.url, tab?.title]
    .filter(value => typeof value === 'string' && value.length > 0);

  for (const value of values) {
    let decodedValue = value;
    // Viewer URLs may encode their source URL more than once.
    for (let i = 0; i < 2; i += 1) {
      try {
        const nextValue = decodeURIComponent(decodedValue);
        if (nextValue === decodedValue) break;
        decodedValue = nextValue;
      } catch {
        break;
      }
    }

    const matches = [...decodedValue.matchAll(/(?:^|[\\/])([^\\/?#]+\.pdf)(?=$|[?#&\s])/gi)];
    if (matches.length > 0) return matches.at(-1)[1].trim();
  }

  return '';
}

/** Uses a PDF's filename whenever Chrome exposes one, otherwise its tab title. */
function displayTabTitle(tab, hostname = '') {
  const metadataTitle = cachedPaperTitle(tab) || cachedCitationTitle(tab);
  if (metadataTitle) return metadataTitle;
  if (isPdfTab(tab)) {
    return pdfFileName(tab) || stripTitleNoise(tab.title || '') || tab.url || 'PDF';
  }

  return cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), hostname);
}

async function requestPocketStateMutation(
  operation,
  tabIds = [],
  itemIds = [],
  customLabel = '',
  pocketItem = null,
) {
  const diagnosticStartedAt = performance.now();
  globalThis.TabOutDiagnostics?.mark('pocket:mutation-start', { operation });
  try {
    const response = await withRuntimeStateTimeout(
      chrome.runtime.sendMessage(createRuntimeMessage(TAB_OUT_MESSAGES.MUTATE_POCKET_STATE, {
        operation,
        tabIds: normalizeTabIds(tabIds),
        itemIds: [...new Set((Array.isArray(itemIds) ? itemIds : [])
          .filter(itemId => typeof itemId === 'string' && itemId.length > 0))],
        customLabel: normalizeCustomLabel(customLabel),
        pocketItem,
      })),
      `Pocket ${operation}`,
    );
    if (!response?.ok || !Array.isArray(response.pocketTabIds)) {
      throw new Error(response?.error || 'Pocket state mutation failed');
    }
    const pocketTabIds = normalizeTabIds(response.pocketTabIds);
    archivedTabIds = new Set(pocketTabIds);
    pocketItems = normalizePocketItems(response.pocketItems);
    pocketLiveItemIds = normalizePocketLiveItemIds(response.pocketLiveItemIds);
    globalThis.TabOutDiagnostics?.mark('pocket:mutation-complete', {
      operation,
      durationMs: Math.round(performance.now() - diagnosticStartedAt),
    });
    return {
      pocketTabIds: archivedTabIds,
      addedTabIds: normalizeTabIds(response.addedTabIds),
      removedTabIds: normalizeTabIds(response.removedTabIds),
      pocketItems,
      pocketLiveItemIds,
      killedTabs: Array.isArray(response.killedTabs) ? response.killedTabs : [],
      removedDuplicateCount: Number(response.removedDuplicateCount) || 0,
    };
  } catch (error) {
    globalThis.TabOutDiagnostics?.mark('pocket:mutation-error', {
      operation,
      durationMs: Math.round(performance.now() - diagnosticStartedAt),
      error: String(error?.message || error),
    });
    throw error;
  }
}

/** Imports pre-decoupling Pocket membership once, then never reads groups again. */
async function migrateLegacyPocketMembership(realTabs) {
  const [local, session] = await Promise.all([
    chrome.storage.local.get([ARCHIVED_TAB_IDS_KEY, POCKET_SESSION_MIGRATION_KEY]),
    chrome.storage.session.get(POCKET_TAB_IDS_KEY),
  ]);
  if (local[POCKET_SESSION_MIGRATION_KEY]) {
    archivedTabIds = new Set(normalizeTabIds(session[POCKET_TAB_IDS_KEY]));
    return;
  }

  const importedIds = new Set(normalizeTabIds(local[ARCHIVED_TAB_IDS_KEY]));
  if (chrome.tabGroups) {
    const aliases = new Set(['pocket', '口袋', 'archive', '稍后阅读']);
    const groups = await chrome.tabGroups.query({});
    const groupIds = new Set(groups
      .filter(group => aliases.has(String(group.title || '').trim().toLowerCase()))
      .map(group => group.id));
    realTabs.filter(tab => groupIds.has(tab.groupId)).forEach(tab => importedIds.add(tab.id));
  }

  const liveIds = realTabs.filter(tab => isManageableTab(tab) && importedIds.has(tab.id))
    .map(tab => tab.id);
  await withRuntimeStateTimeout(
    requestPocketStateMutation('migration-import', liveIds),
    'Pocket migration',
  );
  await chrome.storage.local.set({ [POCKET_SESSION_MIGRATION_KEY]: true });
}

/**
 * Keeps the dashboard readable while an unpacked extension is being reloaded
 * and its page and service worker temporarily belong to different versions.
 * This path is intentionally read-only; the worker remains the sole writer.
 */
async function readPocketStateFallback(realTabs) {
  const manageableIds = new Set(realTabs.filter(isManageableTab).map(tab => tab.id));
  try {
    const [local, session] = await Promise.all([
      chrome.storage.local.get([
        POCKET_ITEMS_KEY,
        ARCHIVED_TAB_IDS_KEY,
        POCKET_SESSION_MIGRATION_KEY,
      ]),
      chrome.storage.session.get([POCKET_TAB_IDS_KEY, POCKET_LIVE_ITEM_IDS_KEY]),
    ]);
    pocketItems = normalizePocketItems(local[POCKET_ITEMS_KEY]);
    pocketLiveItemIds = normalizePocketLiveItemIds(session[POCKET_LIVE_ITEM_IDS_KEY]);
    const cachedIds = normalizeTabIds([
      ...normalizeTabIds(session[POCKET_TAB_IDS_KEY]),
      ...(local[POCKET_SESSION_MIGRATION_KEY]
        ? [] : normalizeTabIds(local[ARCHIVED_TAB_IDS_KEY])),
      ...Object.keys(pocketLiveItemIds).map(Number),
    ]).filter(tabId => manageableIds.has(tabId));
    archivedTabIds = new Set(cachedIds);
  } catch {
    archivedTabIds = new Set([...archivedTabIds].filter(tabId => manageableIds.has(tabId)));
  }
  return archivedTabIds;
}

async function syncArchivedTabIds(realTabs) {
  let state;
  try {
    state = await withRuntimeStateTimeout(
      requestPocketStateMutation('prune'),
      'Pocket state synchronization',
    );
  } catch (error) {
    console.warn('[tab-out] Using the cached Pocket state for this render:', error);
    return readPocketStateFallback(realTabs);
  }
  const remappedOrder = pocketTabOrder.map(key => Number.isInteger(key)
    ? pocketLiveItemIds[key] || key
    : key);
  if (remappedOrder.some((key, index) => key !== pocketTabOrder[index])) {
    pocketTabOrder = normalizePocketOrderKeys(remappedOrder);
    await chrome.storage.local.set({ [POCKET_TAB_ORDER_KEY]: pocketTabOrder });
    await requestPocketStateMutation(
      'set-order',
      [],
      pocketTabOrder.filter(key => typeof key === 'string'),
    );
  }
  const liveIds = realTabs.filter(tab => state.pocketTabIds.has(tab.id)).map(tab => tab.id);
  archivedTabIds = new Set(liveIds);
  return archivedTabIds;
}

async function getPocketTabIds(tabs) {
  const allTabs = Array.isArray(tabs) ? tabs : await chrome.tabs.query({});
  return syncArchivedTabIds(allTabs.filter(isManageableTab));
}

function customLabelForTab(tab) {
  if (tab?.captainDead) return normalizeCustomLabel(tab.customLabel);
  if (typeof tab?.pocketItemId === 'string') {
    return normalizeCustomLabel(tab.customLabel || pocketItemById(tab.pocketItemId)?.customLabel);
  }
  if (Number.isInteger(tab?.id)
    && !archivedTabIds.has(tab.id)
    && captainRetainedTabIds.has(tab.id)) {
    return normalizeCustomLabel(captainKeepCustomLabelsByTabId.get(tab.id));
  }
  return Number.isInteger(tab?.id) ? normalizeCustomLabel(tabCustomLabels[String(tab.id)]) : '';
}

function customLabelForChip(chip) {
  const pocketItemId = chip?.dataset?.pocketItemId;
  if (pocketItemId) return normalizeCustomLabel(pocketItemById(pocketItemId)?.customLabel);
  const tabId = Number(chip?.dataset?.tabId);
  if (!Number.isInteger(tabId)) return '';
  if (!archivedTabIds.has(tabId) && captainRetainedTabIds.has(tabId)) {
    return normalizeCustomLabel(captainKeepCustomLabelsByTabId.get(tabId));
  }
  return normalizeCustomLabel(tabCustomLabels[String(tabId)]);
}

async function setChipCustomLabel(chip, customLabel) {
  const nextLabel = normalizeCustomLabel(customLabel);
  const pocketItemId = chip?.dataset?.pocketItemId;
  const tabId = Number(chip?.dataset?.tabId);
  if (pocketItemId) {
    await requestPocketStateMutation('set-label', [], [pocketItemId], nextLabel);
    return;
  }
  if (!Number.isInteger(tabId)) return;
  if (!archivedTabIds.has(tabId) && captainRetainedTabIds.has(tabId)) {
    const response = await chrome.runtime.sendMessage(createRuntimeMessage(TAB_OUT_MESSAGES.SET_CAPTAIN_KEEP_LABEL, {
      tabId,
      customLabel: nextLabel,
    }));
    if (!response?.ok) throw new Error(response?.error || 'Captain Keep label update failed');
    if (nextLabel) captainKeepCustomLabelsByTabId.set(tabId, nextLabel);
    else captainKeepCustomLabelsByTabId.delete(tabId);
    return;
  }
  await setSessionTabCustomLabel(tabId, nextLabel);
}

function customLabelForLiveTabBeforePocket(tab) {
  if (!Number.isInteger(tab?.id)) return '';
  if (captainRetainedTabIds.has(tab.id)) {
    return normalizeCustomLabel(captainKeepCustomLabelsByTabId.get(tab.id))
      || normalizeCustomLabel(tabCustomLabels[String(tab.id)]);
  }
  return normalizeCustomLabel(tabCustomLabels[String(tab.id)]);
}

function customLabelForClosedTabSnapshot(tab) {
  if (!Number.isInteger(tab?.id)) return '';
  if (archivedTabIds.has(tab.id)) {
    const itemId = pocketLiveItemIds[String(tab.id)];
    return normalizeCustomLabel(pocketItemById(itemId)?.customLabel);
  }
  return customLabelForLiveTabBeforePocket(tab);
}

async function transferLabelsIntoPocket(candidates, state, labelsBeforeArchive, archiveContexts) {
  for (const tab of candidates) {
    const customLabel = labelsBeforeArchive.get(tab.id) || '';
    const itemId = state.pocketLiveItemIds[String(tab.id)];
    const pocketItem = state.pocketItems.find(item => item.id === itemId);
    const existingPocketItemCustomLabel = normalizeCustomLabel(pocketItem?.customLabel);
    const archiveContext = archiveContexts.get(tab.id) || {};
    const reusedDormantPocketItem = archiveContext.reusePocketItemId === itemId;
    const customLabelSource = customLabel
      ? 'live-tab'
      : existingPocketItemCustomLabel ? 'existing-pocket-item' : 'none';
    const customLabelWritten = Boolean(customLabel && itemId
      && (reusedDormantPocketItem || !existingPocketItemCustomLabel));
    const previousLiveItemId = archiveContext.previousLiveItemId;
    tracePocketBind('archive-decision', {
      action: reusedDormantPocketItem || (previousLiveItemId && previousLiveItemId === itemId)
        ? 'reuse-existing-item' : 'create-new-item',
      tabId: tab.id,
      pocketItemId: itemId || null,
      customLabelSource,
      customLabelWritten,
    });
    // A pre-existing Pocket item owns its label. Archiving this live tab must
    // not replace it; explicit renames continue through the set-label path.
    if (customLabelWritten) {
      await requestPocketStateMutation('set-label', [], [itemId], customLabel);
    }
    const storedPocketItem = pocketItemById(itemId);
    tracePocketBind('archive-result', {
      tabId: tab.id,
      pocketItemId: itemId || null,
      storedPocketItem: storedPocketItem || null,
      liveBindingForItem: itemId ? pocketBoundTabId(itemId) : null,
    });
    captainKeepCustomLabelsByTabId.delete(tab.id);
    await removeSessionTabCustomLabel(tab.id);
  }
}

async function transferLabelsOutOfPocket(candidates) {
  for (const tab of candidates) {
    const itemId = pocketLiveItemIds[String(tab.id)];
    const customLabel = normalizeCustomLabel(pocketItemById(itemId)?.customLabel);
    if (customLabel) await setSessionTabCustomLabel(tab.id, customLabel);
  }
}

function snapshotPocketItemForHistory(item) {
  if (!item?.id || !item?.url) return null;
  return {
    id: item.id,
    url: item.url,
    title: typeof item.title === 'string' ? item.title : '',
    order: Number.isFinite(item.order) ? item.order : 0,
    ...(normalizeCustomLabel(item.customLabel) ? { customLabel: normalizeCustomLabel(item.customLabel) } : {}),
  };
}

async function updateArchiveMembership(
  tabIds,
  shouldArchive,
  { pocketTransitionsByTabId = new Map() } = {},
) {
  const wantedIds = new Set(normalizeTabIds(tabIds));
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter(tab => wantedIds.has(tab.id) && isManageableTab(tab));
  if (candidates.length === 0) {
    await syncArchivedTabIds(tabs.filter(isManageableTab));
    return [];
  }
  // Capture the authoritative live label before the Pocket mutation changes
  // archivedTabIds and Captain Keep membership interpretation.
  const labelsBeforeArchive = shouldArchive
    ? new Map(candidates.map(tab => [tab.id, customLabelForLiveTabBeforePocket(tab)]))
    : new Map();
  const archiveContexts = new Map();
  if (shouldArchive) {
    for (const tab of candidates) {
      const replayTransition = pocketTransitionsByTabId.get(tab.id);
      const replayItem = replayTransition?.pocketItemId
        ? pocketItemById(replayTransition.pocketItemId) : null;
      const matchedPocketItem = replayItem || dormantPocketItemMatchingUrl(tab.url, archivedTabIds);
      const existingBinding = matchedPocketItem ? pocketBoundTabId(matchedPocketItem.id) : null;
      archiveContexts.set(tab.id, {
        previousLiveItemId: pocketLiveItemIds[String(tab.id)] || '',
        reusePocketItemId: matchedPocketItem && !Number.isInteger(existingBinding)
          ? matchedPocketItem.id : '',
        pocketTransition: replayTransition || (matchedPocketItem && !Number.isInteger(existingBinding)
          ? {
            pocketItemId: matchedPocketItem.id,
            pocketItem: snapshotPocketItemForHistory(matchedPocketItem),
            preActionBinding: existingBinding,
          }
          : null),
        recordPocketTransition: false,
      });
      tracePocketBind('archive-start', {
        tabId: tab.id,
        url: tab.pendingUrl || tab.url || '',
        liveCustomLabel: labelsBeforeArchive.get(tab.id) || null,
        matchedPocketItemId: matchedPocketItem?.id || null,
        existingPocketItemCustomLabel: normalizeCustomLabel(matchedPocketItem?.customLabel) || null,
        existingBinding,
      });
    }
  }
  if (!shouldArchive) await transferLabelsOutOfPocket(candidates);
  let state;
  let changedIds;
  if (shouldArchive) {
    const reusedItemIds = new Set();
    const reusedCandidates = candidates.filter(tab => {
      const itemId = archiveContexts.get(tab.id)?.reusePocketItemId;
      if (!itemId || reusedItemIds.has(itemId)) return false;
      reusedItemIds.add(itemId);
      archiveContexts.get(tab.id).recordPocketTransition = true;
      return true;
    });
    const newCandidates = candidates.filter(tab => !reusedCandidates.includes(tab));
    const addedIds = [];
    for (const tab of reusedCandidates) {
      state = await requestPocketStateMutation(
        'bind',
        [tab.id],
        [archiveContexts.get(tab.id).reusePocketItemId],
      );
      addedIds.push(...state.addedTabIds);
    }
    if (newCandidates.length > 0) {
      state = await requestPocketStateMutation('add', newCandidates.map(tab => tab.id));
      addedIds.push(...state.addedTabIds);
    }
    changedIds = new Set(addedIds);
  } else {
    state = await requestPocketStateMutation('remove', candidates.map(tab => tab.id));
    changedIds = new Set(state.removedTabIds);
  }
  const changedCandidates = candidates.filter(tab => changedIds.has(tab.id));
  if (shouldArchive) {
    await transferLabelsIntoPocket(changedCandidates, state, labelsBeforeArchive, archiveContexts);
  }
  return changedCandidates.map(tab => {
    const archiveContext = archiveContexts.get(tab.id);
    return {
      id: tab.id,
      url: tab.pendingUrl || tab.url || '',
      wasArchived: !shouldArchive,
      ...(shouldArchive && archiveContext?.recordPocketTransition && archiveContext.pocketTransition
        ? { pocketTransition: archiveContext.pocketTransition }
        : {}),
    };
  });
}

/** Closes precisely the displayed tabs, without touching archived matches. */
async function closeTabsByIds(tabIds, tabsSnapshot, { traceDuplicateRemoval = false } = {}) {
  const idSet = new Set(normalizeTabIds(tabIds));
  if (idSet.size === 0) return [];

  const allTabs = Array.isArray(tabsSnapshot)
    ? tabsSnapshot
    : await chrome.tabs.query({});
  const tabsToClose = allTabs.filter(tab => idSet.has(tab.id));
  if (tabsToClose.length === 0) return [];

  const closingIds = tabsToClose.map(tab => tab.id);
  markTabsForLocalClose(closingIds);
  try {
    if (traceDuplicateRemoval) {
      traceDuplicateDelete('remove-request', { tabIds: closingIds });
    }
    await chrome.tabs.remove(closingIds);
    if (traceDuplicateRemoval) {
      traceDuplicateDelete('remove-result', { requestedTabIds: closingIds });
    }
  } catch (error) {
    unmarkTabsForLocalClose(closingIds);
    if (traceDuplicateRemoval) {
      traceDuplicateDelete('remove-error', {
        requestedTabIds: closingIds,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
  return tabsToClose;
}

function tabSnapshotForUndo(tab, wasArchived, customLabel = '') {
  return {
    id: tab.id,
    url: tab.url,
    windowId: tab.windowId,
    index: tab.index,
    pinned: Boolean(tab.pinned),
    wasArchived,
    ...(normalizeCustomLabel(customLabel)
      ? { customLabel: normalizeCustomLabel(customLabel) }
      : {}),
  };
}

function beginDeletionVisualFeedback(tabIds) {
  const requestedIds = new Set(normalizeTabIds(tabIds));
  const targets = [];

  document.querySelectorAll('.mission-card').forEach(card => {
    const allChips = [...card.querySelectorAll('.page-chip')];
    const affectedChips = allChips.filter(chip => {
      const tabId = Number(chip.dataset.tabId);
      return Number.isInteger(tabId) && requestedIds.has(tabId);
    });
    if (affectedChips.length === 0) return;

    // When a whole domain is being deleted, animate its frame once instead of
    // running an overlapping animation on every child chip. Dead Keep/Pending
    // placeholders have no tab id and must keep the Captain frame visible.
    if (affectedChips.length === allChips.length) {
      card.classList.add('is-delete-pending');
      targets.push(card);
      return;
    }

    affectedChips.forEach(chip => {
      chip.classList.add('is-delete-pending');
      targets.push(chip);
    });
  });

  return targets;
}

function clearDeletionVisualFeedback(targets) {
  targets.forEach(target => {
    const exitAnimation = target.getAnimations()
      .find(animation => animation.animationName === 'tabout-delete-exit');
    if (!exitAnimation || exitAnimation.playState === 'idle') {
      target.classList.remove('is-delete-pending');
      return;
    }

    // Reverse from the animation's current position so even a late browser
    // failure restores the card without snapping it back into place.
    exitAnimation.addEventListener('finish', () => {
      target.classList.remove('is-delete-pending');
    }, { once: true });
    exitAnimation.reverse();
  });
}

async function finishDeletionVisualFeedback(startedAt) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const remaining = 300 - (performance.now() - startedAt);
  if (remaining > 0) {
    await new Promise(resolve => window.setTimeout(resolve, remaining));
  }
}

function captureDeletionConfettiOrigins(tabIds) {
  const requestedIds = new Set(normalizeTabIds(tabIds));
  const origins = new Map();
  // The animation renders at most 12 bursts, so avoid forcing layout for
  // every matching chip in a large deletion.
  for (const card of document.querySelectorAll('.page-chip[data-tab-id]')) {
    if (origins.size >= 12) break;
    const tabId = Number(card.dataset.tabId);
    if (!requestedIds.has(tabId)) continue;
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    origins.set(tabId, {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  }
  return origins;
}

function celebrateDeletedTabs(closedTabs, origins) {
  const visibleOrigins = closedTabs
    .map(tab => origins.get(tab.id))
    .filter(Boolean)
    .slice(0, 12);
  if (visibleOrigins.length > 0) {
    visibleOrigins.forEach(origin => shootConfetti(origin.x, origin.y));
  } else {
    shootConfetti(window.innerWidth / 2, window.innerHeight / 2);
  }
}

function applyClosedTabsToDashboard(closedTabs) {
  const closedIds = new Set(closedTabs.map(tab => tab.id).filter(Number.isInteger));
  if (closedIds.size === 0) return;
  openTabs = openTabs.filter(tab => !closedIds.has(tab.id));
  archivedTabIds = new Set([...archivedTabIds].filter(tabId => !closedIds.has(tabId)));
  domainGroups = domainGroups
    .map(group => ({ ...group, tabs: group.tabs.filter(tab => !closedIds.has(tab.id)) }))
    .filter(group => group.tabs.length > 0);
  archivedDomainGroups = archivedDomainGroups
    .map(group => ({ ...group, tabs: group.tabs.filter(tab => !closedIds.has(tab.id)) }))
    .filter(group => group.tabs.length > 0);

  resetStableOpenGroupLayout();
  const openTabsMissionsEl = document.getElementById('openTabsMissions');
  if (openTabsMissionsEl) {
    if (domainGroups.length > 0) renderStableOpenGroupLayout(openTabsMissionsEl, domainGroups);
    else openTabsMissionsEl.replaceChildren();
  }
  const activeTabs = openTabs.filter(tab => isManageableTab(tab) && !archivedTabIds.has(tab.id));
  updateCandidateBatch(activeTabs);
  syncCandidateHeaderPrompt();
  syncKeyboardPromptProgression();
  syncDashboardAdaptiveLayout();
}

/** Closes tabs and records enough browser state to recreate them on undo. */
async function closeTabsWithUndo(
  tabIds,
  { recordHistory = true, traceDuplicateRemoval = false } = {},
) {
  beginDashboardRefreshSuppression();
  const deletionFeedbackTargets = beginDeletionVisualFeedback(tabIds);
  try {
    const confettiOrigins = captureDeletionConfettiOrigins(tabIds);
    traceCaptainKeepDedup('tabs-query-begin', { requestedTabIds: normalizeTabIds(tabIds) });
    const tabsBeforeClose = await chrome.tabs.query({});
    traceCaptainKeepDedup('tabs-query-complete', { browserTabCount: tabsBeforeClose.length });
    const archivedIdsBeforeClose = new Set(archivedTabIds);
    const captainLayoutBefore = captureCaptainLayoutState(tabsBeforeClose);
    traceCaptainKeepDedup('chrome-remove-begin');
    const closedTabs = await closeTabsByIds(tabIds, tabsBeforeClose, { traceDuplicateRemoval });
    traceCaptainKeepDedup('chrome-remove-complete', { closedTabIds: closedTabs.map(tab => tab.id) });
    if (closedTabs.length === 0) {
      clearDeletionVisualFeedback(deletionFeedbackTargets);
      return [];
    }

    celebrateDeletedTabs(closedTabs, confettiOrigins);
    // Chrome has confirmed the close. Reflow now; persistence and cleanup are
    // bookkeeping and must not keep a deleted card occupying the dashboard.
    applyClosedTabsToDashboard(closedTabs);

    const closedIds = new Set(closedTabs.map(tab => tab.id));
    void withRuntimeStateTimeout(
      requestPocketStateMutation('remove', [...closedIds]),
      'Pocket cleanup after tab deletion',
    ).then(() => {
      traceCaptainKeepDedup('pocket-cleanup-complete');
    }).catch(error => {
      // The browser tabs are already closed. A sleeping or stale worker must
      // not roll the visible dashboard back to its pre-delete state.
      console.warn('[tab-out] Deferred Pocket cleanup after tab deletion:', error);
    });
    const historyWrite = recordHistory ? (async () => {
      traceCaptainKeepDedup('history-write-begin');
      await pushUndoEntry({
        type: 'closed-tabs',
        tabs: closedTabs.map(tab => tabSnapshotForUndo(tab, archivedIdsBeforeClose.has(tab.id))),
        ...(closedTabs.some(tab => captainKeepAreaEnabledForTab(tab) && !archivedIdsBeforeClose.has(tab.id))
          ? { captainLayoutBefore }
          : {}),
      });
      traceCaptainKeepDedup('history-write-complete');
    })() : Promise.resolve();

    traceCaptainKeepDedup('history-wait-begin');
    await historyWrite;
    traceCaptainKeepDedup('history-wait-complete');
    return closedTabs;
  } catch (error) {
    clearDeletionVisualFeedback(deletionFeedbackTargets);
    throw error;
  } finally {
    endDashboardRefreshSuppression();
  }
}

async function changeArchiveMembershipWithUndo(
  tabIds,
  shouldArchive,
  { recordHistory = true } = {},
) {
  // Coalesce concurrent Pocket mutations until membership and its undo record
  // are authoritative, then immediately reclassify the current local model.
  beginDashboardRefreshSuppression();
  try {
    const captainLayoutBefore = captureCaptainLayoutState();
    const changes = await updateArchiveMembership(tabIds, shouldArchive);
    if (changes.length > 0) {
      // Pocket Captains are pinned before every loose/domain group. Discard a
      // stale in-page order as soon as Captain membership changes so the final
      // authoritative render moves the card immediately, not after refresh.
      if (changes.some(change => isCaptainTab({ url: change.url }))) {
        stableGroupDomains.archive = [];
      }
      if (shouldArchive) playCloseSound();
      const affectsCaptainLayout = changes.some(change =>
        captainLayoutBefore.order.includes(change.id)
        || captainKeepAreaEnabledForTab({ url: change.url }));
      if (recordHistory) {
        await pushUndoEntry({
          type: 'archive-membership',
          changes,
          ...(affectsCaptainLayout ? { captainLayoutBefore } : {}),
        });
      }
      commitCurrentDashboardState();
    }
    return changes;
  } finally {
    endDashboardRefreshSuppression();
  }
}

async function duplicateCopiesForArchiveRepresentatives(representativeIds) {
  const keepIds = new Set(normalizeTabIds(representativeIds));
  if (keepIds.size === 0) return [];
  const allTabs = await chrome.tabs.query({});
  const keepIdentityKeys = new Set(allTabs
    .filter(tab => keepIds.has(tab.id))
    .map(duplicateIdentityKey)
    .filter(Boolean));
  if (keepIdentityKeys.size === 0) return [];
  return normalizeTabIds(allTabs
    .filter(tab => !keepIds.has(tab.id)
      && keepIdentityKeys.has(duplicateIdentityKey(tab)))
    .map(tab => tab.id));
}

/** Archives duplicate-indicated chips and removes every same-URL copy. */
async function archiveTabsWithIndicatedDedup(tabIds, duplicateRepresentativeIds = []) {
  const ids = normalizeTabIds(tabIds);
  const duplicateIds = await duplicateCopiesForArchiveRepresentatives(
    duplicateRepresentativeIds,
  );
  if (duplicateIds.length === 0) {
    return {
      changes: await changeArchiveMembershipWithUndo(ids, true),
      closedDuplicates: [],
    };
  }

  const tabsBefore = await chrome.tabs.query({});
  const archivedIdsBefore = await getPocketTabIds(tabsBefore);
  const captainLayoutBefore = captureCaptainLayoutState(tabsBefore);
  const duplicateIdSet = new Set(duplicateIds);
  const duplicateCustomLabels = new Map(tabsBefore
    .filter(tab => duplicateIdSet.has(tab.id))
    .map(tab => [tab.id, customLabelForClosedTabSnapshot(tab)]));
  const closedDuplicates = await closeTabsWithUndo(duplicateIds, { recordHistory: false });
  const changes = await changeArchiveMembershipWithUndo(ids, true, { recordHistory: false });
  if (closedDuplicates.length > 0 || changes.length > 0) {
    await pushUndoEntry({
      type: 'dedupe-pocket',
      tabs: closedDuplicates.map(tab => tabSnapshotForUndo(
        tab,
        archivedIdsBefore.has(tab.id),
        duplicateCustomLabels.get(tab.id),
      )),
      changes,
      captainLayoutBefore,
    });
  }
  return { changes, closedDuplicates };
}

/* ----------------------------------------------------------------
   UNDO / REDO — browser-session history for reversible dashboard actions
   ---------------------------------------------------------------- */

const HISTORY_ENTRY_TYPES = new Set([
  'closed-tabs',
  'archive-membership',
  'dedupe-pocket',
  'captain-layout',
  'tab-label',
  'captain-keep-lifecycle',
  'captain-keep-order',
  'pocket-lifecycle',
  'captain-pending-dead-lifecycle',
]);

async function applyCaptainKeepOrder(orderedKeepIds) {
  const order = [...new Set((orderedKeepIds || []).filter(id => typeof id === 'string' && id))];
  if (order.length === 0) return 0;
  await requestCaptainKeepLifecycle('reorder', { keepItem: { orderedKeepIds: order } });
  for (const card of document.querySelectorAll('.captain-group-card[data-area="open"]')) {
    const list = card.querySelector('.captain-subgroup-retained > .mission-pages');
    if (!list) continue;
    for (const keepId of order) {
      const chip = card.querySelector(`.page-chip[data-captain-keep-id="${CSS.escape(keepId)}"]`);
      const row = chipRowElement(chip);
      if (row && row.parentElement === list) list.append(row);
    }
  }
  return 1;
}

function normalizeUndoHistory(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map(entry => {
      if (!entry || typeof entry !== 'object') return entry;
      const normalized = {
        ...entry,
        ...(entry.type === 'pdf-layout' ? { type: 'captain-layout' } : {}),
      };
      if (!normalized.captainLayoutBefore && entry.pdfLayoutBefore) {
        normalized.captainLayoutBefore = entry.pdfLayoutBefore;
      }
      delete normalized.pdfLayoutBefore;
      return normalized;
    })
    .filter(entry => entry && HISTORY_ENTRY_TYPES.has(entry.type))
    .slice(-MAX_UNDO_STEPS);
}

async function loadUndoHistory() {
  try {
    const keys = [UNDO_HISTORY_KEY, REDO_HISTORY_KEY];
    const stored = await chrome.storage.session.get(keys);
    const storedUndoHistory = stored[UNDO_HISTORY_KEY];
    const storedRedoHistory = stored[REDO_HISTORY_KEY];
    undoHistory = normalizeUndoHistory(storedUndoHistory);
    redoHistory = normalizeUndoHistory(storedRedoHistory);
    // History used to live in local storage. Never import it: the intended
    // lifecycle is one complete browser open/close session.
    chrome.storage.local.remove(keys).catch(() => {});
  } catch {
    // In-memory history remains available if extension storage is unavailable.
    undoHistory = [];
    redoHistory = [];
  }
}

async function persistUndoHistory() {
  try {
    const history = {
      [UNDO_HISTORY_KEY]: undoHistory,
      [REDO_HISTORY_KEY]: redoHistory,
    };
    await chrome.storage.session.set(history);
  } catch {
    // Keep the current page's in-memory history if storage is unavailable.
  }
}

async function pushUndoEntry(entry) {
  undoHistory = [...undoHistory, entry].slice(-MAX_UNDO_STEPS);
  // A new user action starts a new history branch.
  redoHistory = [];
  await persistUndoHistory();
}

function tabMatchesHistoryReference(tab, reference) {
  if (!tab || !Number.isInteger(reference?.id)) return false;
  const expectedUrl = typeof reference.url === 'string' ? reference.url : '';
  return !expectedUrl || (tab.pendingUrl || tab.url || '') === expectedUrl;
}

function tabMatchesPocketHistoryReference(tab, reference) {
  if (!tab || !Number.isInteger(reference?.id)) return false;
  const expectedUrl = getPocketIdentityUrl(reference.url);
  return !expectedUrl
    || getPocketIdentityUrl(tab.pendingUrl || tab.url || '') === expectedUrl;
}

async function restoreArchiveMembership(changes) {
  const idsToArchive = [];
  const idsToRestore = [];
  const reusedDormantTransitions = [];
  const liveTabsById = new Map((await chrome.tabs.query({})).map(tab => [tab.id, tab]));

  for (const change of changes || []) {
    if (!tabMatchesPocketHistoryReference(liveTabsById.get(change?.id), change)) continue;
    if (change.wasArchived) idsToArchive.push(change.id);
    else if (change.pocketTransition?.pocketItemId && change.pocketTransition?.pocketItem) {
      reusedDormantTransitions.push(change);
    }
    else idsToRestore.push(change.id);
  }

  const archived = await updateArchiveMembership(idsToArchive, true);
  const restored = await updateArchiveMembership(idsToRestore, false);
  let restoredDormant = 0;
  for (const change of reusedDormantTransitions) {
    const currentPocketItem = pocketItemById(change.pocketTransition.pocketItemId);
    const customLabel = normalizeCustomLabel(currentPocketItem?.customLabel)
      || normalizeCustomLabel(change.pocketTransition.pocketItem.customLabel);
    if (customLabel) await setSessionTabCustomLabel(change.id, customLabel);
    const state = await requestPocketStateMutation(
      'restore-dormant',
      [change.id],
      [change.pocketTransition.pocketItemId],
      '',
      change.pocketTransition.pocketItem,
    );
    restoredDormant += state.removedTabIds.includes(change.id) ? 1 : 0;
  }
  return archived.length + restored.length + restoredDormant;
}

async function recreateClosedTab(snapshot) {
  const baseOptions = { url: snapshot.url, active: false, pinned: Boolean(snapshot.pinned) };
  const positionedOptions = { ...baseOptions };

  if (Number.isInteger(snapshot.windowId)) {
    positionedOptions.windowId = snapshot.windowId;
    if (!snapshot.pinned && Number.isInteger(snapshot.index)) {
      positionedOptions.index = Math.max(0, snapshot.index);
    }
  }

  try {
    return await createDashboardTabWithOrigin('undo-restore', positionedOptions);
  } catch {
    // The source window may have been closed. Reopen in the current window.
    return createDashboardTabWithOrigin('undo-restore', baseOptions);
  }
}

function isTabOutPageUrl(url) {
  return url === chrome.runtime.getURL('index.html') || url === 'chrome://newtab/';
}

async function restoreClosedTabs(snapshots) {
  const sortedSnapshots = (snapshots || [])
    .filter(snapshot => typeof snapshot?.url === 'string'
      && snapshot.url.length > 0
      // Older startup-cleanup history may contain the dashboard itself.
      // Restoring it would run keepNewestTabOut() and close this active page.
      && !isTabOutPageUrl(snapshot.url))
    .sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
  const restoredArchivedTabIds = [];
  const recreatedTabIds = new Map();
  let restored = 0;

  for (const snapshot of sortedSnapshots) {
    try {
      const recreatedTab = await recreateClosedTab(snapshot);
      if (normalizeCustomLabel(snapshot.customLabel)) {
        await setSessionTabCustomLabel(recreatedTab.id, snapshot.customLabel);
      }
      restored++;
      if (Number.isInteger(snapshot.id)) recreatedTabIds.set(snapshot.id, recreatedTab.id);
      if (snapshot.wasArchived) restoredArchivedTabIds.push(recreatedTab.id);
    } catch {
      // A URL that Chrome refuses to open cannot be restored, but other tabs can.
    }
  }

  if (restoredArchivedTabIds.length > 0) {
    await updateArchiveMembership(restoredArchivedTabIds, true);
  } else {
    await syncArchivedTabIds((await chrome.tabs.query({})).filter(isManageableTab));
  }

  await fetchOpenTabs();
  return { restored, recreatedTabIds };
}

function remapHistoryEntryTabIds(entry, tabIdMap) {
  if (!(tabIdMap instanceof Map) || tabIdMap.size === 0) return entry;
  const remapId = id => tabIdMap.get(id) || id;
  const remappedCaptainLayoutBefore = entry.captainLayoutBefore
    ? remapCaptainLayoutState(entry.captainLayoutBefore, tabIdMap)
    : undefined;

  if (entry.type === 'archive-membership') {
    return {
      ...entry,
      changes: (entry.changes || []).map(change => ({ ...change, id: remapId(change.id) })),
      ...(remappedCaptainLayoutBefore ? { captainLayoutBefore: remappedCaptainLayoutBefore } : {}),
    };
  }
  if (entry.type === 'captain-layout') {
    return {
      ...entry,
      before: remapCaptainLayoutState(entry.before, tabIdMap),
      after: remapCaptainLayoutState(entry.after, tabIdMap),
    };
  }
  if (entry.type === 'closed-tabs') {
    return {
      ...entry,
      tabs: (entry.tabs || []).map(tab => ({ ...tab, id: remapId(tab.id) })),
      ...(remappedCaptainLayoutBefore ? { captainLayoutBefore: remappedCaptainLayoutBefore } : {}),
    };
  }
  if (entry.type === 'dedupe-pocket') {
    return {
      ...entry,
      tabs: (entry.tabs || []).map(tab => ({ ...tab, id: remapId(tab.id) })),
      changes: (entry.changes || []).map(change => ({ ...change, id: remapId(change.id) })),
      ...(remappedCaptainLayoutBefore ? { captainLayoutBefore: remappedCaptainLayoutBefore } : {}),
    };
  }
  if (entry.type === 'tab-label') {
    return { ...entry, tabId: remapId(entry.tabId) };
  }
  return entry;
}

function remapHistoryTabIds(tabIdMap) {
  if (!(tabIdMap instanceof Map) || tabIdMap.size === 0) return;
  undoHistory = undoHistory.map(entry => remapHistoryEntryTabIds(entry, tabIdMap));
  redoHistory = redoHistory.map(entry => remapHistoryEntryTabIds(entry, tabIdMap));
}

function redoEntryAfterUndo(entry, recreatedTabIds) {
  if (entry.type !== 'closed-tabs' && entry.type !== 'dedupe-pocket') return entry;
  const remapped = remapHistoryEntryTabIds(entry, recreatedTabIds);
  const recreatedIds = new Set(recreatedTabIds.values());
  return {
    ...remapped,
    // Only tabs that were successfully recreated can safely be closed again.
    tabs: (remapped.tabs || [])
      .filter(tab => recreatedIds.has(tab.id)),
  };
}

async function restoreUndoInitiatorFocus(tab) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(tab?.windowId)) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // The user may have deliberately closed the initiating dashboard.
  }
}

async function applyTabLabelHistoryEntry(entry, customLabel) {
  const nextLabel = normalizeCustomLabel(customLabel);
  if (typeof entry?.pocketItemId === 'string' && pocketItemById(entry.pocketItemId)) {
    await requestPocketStateMutation('set-label', [], [entry.pocketItemId], nextLabel);
    return 1;
  }

  if (!Number.isInteger(entry?.tabId)) return 0;
  const tab = await chrome.tabs.get(entry.tabId).catch(() => null);
  if (!tabMatchesHistoryReference(tab, { id: entry.tabId, url: entry.url })) return 0;

  const livePocketItemId = pocketLiveItemIds[String(entry.tabId)];
  if (archivedTabIds.has(entry.tabId) && livePocketItemId) {
    await requestPocketStateMutation('set-label', [], [livePocketItemId], nextLabel);
    return 1;
  }
  if (captainRetainedTabIds.has(entry.tabId)) {
    const response = await chrome.runtime.sendMessage(createRuntimeMessage(TAB_OUT_MESSAGES.SET_CAPTAIN_KEEP_LABEL, {
      tabId: entry.tabId,
      customLabel: nextLabel,
    }));
    if (!response?.ok) throw new Error(response?.error || 'Captain Keep label update failed');
    if (nextLabel) captainKeepCustomLabelsByTabId.set(entry.tabId, nextLabel);
    else captainKeepCustomLabelsByTabId.delete(entry.tabId);
    return 1;
  }
  await setSessionTabCustomLabel(entry.tabId, nextLabel);
  return 1;
}

async function undoLatestAction() {
  if (isUndoing || undoHistory.length === 0) return;

  const entry = undoHistory[undoHistory.length - 1];
  const initiatingTab = await chrome.tabs.getCurrent().catch(() => null);
  isUndoing = true;

  try {
    let count = 0;
    let recreatedTabIds = new Map();
    let oppositeEntry = entry;
    let skipDashboardRender = false;

    if (entry.type === 'closed-tabs') {
      const result = await restoreClosedTabs(entry.tabs);
      count = result.restored;
      recreatedTabIds = result.recreatedTabIds;
      // Chrome can activate a newly recreated tab while rebuilding a window.
      // Return immediately to the dashboard before applying the layout.
      await restoreUndoInitiatorFocus(initiatingTab);
      if (entry.captainLayoutBefore) {
        await applyCaptainLayoutState(remapCaptainLayoutState(entry.captainLayoutBefore, recreatedTabIds));
      }
    } else if (entry.type === 'archive-membership') {
      count = await restoreArchiveMembership(entry.changes);
      if (entry.captainLayoutBefore) {
        const layoutCount = await applyCaptainLayoutState(entry.captainLayoutBefore);
        count = Math.max(count, layoutCount);
      }
    } else if (entry.type === 'dedupe-pocket') {
      count = await restoreArchiveMembership(entry.changes);
      const result = await restoreClosedTabs(entry.tabs);
      count += result.restored;
      recreatedTabIds = result.recreatedTabIds;
      await restoreUndoInitiatorFocus(initiatingTab);
      if (entry.captainLayoutBefore) {
        await applyCaptainLayoutState(remapCaptainLayoutState(entry.captainLayoutBefore, recreatedTabIds));
      }
    } else if (entry.type === 'captain-layout') {
      count = await applyCaptainLayoutState(entry.before);
    } else if (entry.type === 'tab-label') {
      count = await applyTabLabelHistoryEntry(entry, entry.before);
    } else if (entry.type === 'captain-keep-lifecycle') {
      const result = await applyCaptainKeepHistory(entry, true);
      count = result.count;
      oppositeEntry = result.entry;
      skipDashboardRender = result.domPatched === true;
    } else if (entry.type === 'captain-keep-order') {
      count = await applyCaptainKeepOrder(entry.before);
      skipDashboardRender = count > 0;
    } else if (entry.type === 'pocket-lifecycle') {
      count = await applyPocketLifecycleHistory(entry, true);
    } else if (entry.type === 'captain-pending-dead-lifecycle') {
      count = await applyCaptainPendingDeadHistory(entry, true);
    }

    undoHistory = undoHistory.slice(0, -1);
    remapHistoryTabIds(recreatedTabIds);
    if (count > 0) {
      const redoEntry = redoEntryAfterUndo(oppositeEntry, recreatedTabIds);
      redoHistory = [...redoHistory, redoEntry].slice(-MAX_UNDO_STEPS);
    }
    await persistUndoHistory();
    if (!skipDashboardRender) await renderDashboard();
    await restoreUndoInitiatorFocus(initiatingTab);

    const englishMessage = entry.type === 'closed-tabs'
      ? count > 0
        ? `Reopened ${count} tab${count === 1 ? '' : 's'}`
        : 'No tabs could be reopened'
      : entry.type === 'archive-membership'
        ? count > 0
          ? `Undid ${count} tab move${count === 1 ? '' : 's'}`
          : 'No matching tabs remain to undo'
        : entry.type === 'dedupe-pocket'
          ? count > 0 ? 'Restored the duplicates and removed the kept tab from Pocket' : 'Nothing remains to undo'
        : entry.type === 'captain-layout'
          ? count > 0 ? 'Restored the previous Captain layout' : 'The Captain layout is already unchanged'
          : entry.type === 'tab-label'
            ? count > 0 ? 'Restored the previous tab name' : 'The tab is no longer available'
          : entry.type === 'captain-keep-lifecycle'
            ? count > 0 ? 'Restored the previous Keep state' : 'The Keep item is no longer available'
          : entry.type === 'pocket-lifecycle'
            ? count > 0 ? 'Restored the previous Pocket state' : 'The Pocket item is no longer available'
          : entry.type === 'captain-pending-dead-lifecycle'
            ? count > 0 ? 'Restored the dead Keep tab' : 'The Pending item is no longer available'
          : 'No matching action remains to undo';
    const chineseMessage = entry.type === 'closed-tabs'
      ? count > 0 ? `已重新打开 ${count} 个` : '没有可重新打开的标签页'
      : entry.type === 'archive-membership'
        ? count > 0 ? `已撤回` : '没有可撤回的匹配标签页'
        : entry.type === 'dedupe-pocket'
          ? count > 0 ? '已恢复了重复的，并移出「口袋」' : '没有可撤回的操作'
        : entry.type === 'captain-layout'
          ? count > 0 ? '已恢复排列' : '排列没有变化'
          : entry.type === 'tab-label'
            ? count > 0 ? '已恢复名称' : '该标签页已不可用'
          : entry.type === 'captain-keep-lifecycle'
            ? count > 0 ? '已恢复' : '该保留项已不可用'
          : entry.type === 'pocket-lifecycle'
            ? count > 0 ? '已恢复之前的「口袋」状态' : '该「口袋」项目已不可用'
          : '没有可撤回的操作';
    showToast(uiText(englishMessage, chineseMessage));
  } catch (err) {
    console.warn('[tab-out] Could not undo the latest action:', err);
    showToast(uiText('Could not undo the latest action', '无法撤回上一个操作'));
  } finally {
    isUndoing = false;
  }
}

async function reapplyArchiveMembership(changes) {
  const idsToArchive = [];
  const idsToRestore = [];
  const reusedDormantTransitions = [];
  const liveTabsById = new Map((await chrome.tabs.query({})).map(tab => [tab.id, tab]));

  for (const change of changes || []) {
    if (!tabMatchesPocketHistoryReference(liveTabsById.get(change?.id), change)) continue;
    if (change.wasArchived) idsToRestore.push(change.id);
    else if (change.pocketTransition?.pocketItemId && change.pocketTransition?.pocketItem) {
      reusedDormantTransitions.push(change);
    }
    else idsToArchive.push(change.id);
  }

  const archived = await updateArchiveMembership(idsToArchive, true);
  const restored = await updateArchiveMembership(idsToRestore, false);
  const rebound = [];
  for (const change of reusedDormantTransitions) {
    const pocketTransitionsByTabId = new Map([[change.id, change.pocketTransition]]);
    rebound.push(...await updateArchiveMembership([change.id], true, { pocketTransitionsByTabId }));
  }
  return [...archived, ...restored, ...rebound];
}

async function recloseTabsForRedo(entry, { pocketIdentity = false } = {}) {
  beginDashboardRefreshSuppression();
  let deletionFeedbackTargets = [];
  let deletionFeedbackStartedAt = 0;
  try {
    const snapshotsById = new Map((entry.tabs || [])
      .filter(tab => Number.isInteger(tab?.id))
      .map(tab => [tab.id, tab]));
    const tabsBeforeClose = await chrome.tabs.query({});
    const archiveIds = await getPocketTabIds(tabsBeforeClose);
    const matchesReference = pocketIdentity
      ? tabMatchesPocketHistoryReference : tabMatchesHistoryReference;
    const targets = tabsBeforeClose.filter(tab =>
      matchesReference(tab, snapshotsById.get(tab.id)));
    if (targets.length === 0) return { count: 0, undoEntry: null };
    const captainLayoutBefore = captureCaptainLayoutState(tabsBeforeClose);

    deletionFeedbackStartedAt = performance.now();
    deletionFeedbackTargets = beginDeletionVisualFeedback(targets.map(tab => tab.id));
    const confettiOrigins = captureDeletionConfettiOrigins(targets.map(tab => tab.id));
    const closedTabs = await closeTabsByIds(targets.map(tab => tab.id), tabsBeforeClose);
    if (closedTabs.length === 0) {
      clearDeletionVisualFeedback(deletionFeedbackTargets);
      return { count: 0, undoEntry: null };
    }
    celebrateDeletedTabs(closedTabs, confettiOrigins);
    const closedIds = new Set(closedTabs.map(tab => tab.id));
    await requestPocketStateMutation('remove', [...closedIds]);
    await finishDeletionVisualFeedback(deletionFeedbackStartedAt);

    return {
      count: closedTabs.length,
      undoEntry: {
        type: 'closed-tabs',
        tabs: closedTabs.map(tab => tabSnapshotForUndo(
          tab,
          archiveIds.has(tab.id),
          snapshotsById.get(tab.id)?.customLabel,
        )),
        ...(closedTabs.some(tab => captainKeepAreaEnabledForTab(tab) && !archiveIds.has(tab.id))
          ? { captainLayoutBefore }
          : {}),
      },
    };
  } catch (error) {
    clearDeletionVisualFeedback(deletionFeedbackTargets);
    throw error;
  } finally {
    endDashboardRefreshSuppression();
  }
}

async function redoLatestAction() {
  if (isUndoing || redoHistory.length === 0) return;

  const entry = redoHistory[redoHistory.length - 1];
  isUndoing = true;

  try {
    let count = 0;
    let undoEntry = null;
    let skipDashboardRender = false;

    if (entry.type === 'closed-tabs') {
      const result = await recloseTabsForRedo(entry);
      count = result.count;
      undoEntry = result.undoEntry;
      if (count > 0) playCloseSound();
    } else if (entry.type === 'archive-membership') {
      const captainLayoutBefore = captureCaptainLayoutState();
      const changes = await reapplyArchiveMembership(entry.changes);
      count = changes.length;
      if (count > 0) {
        const affectsCaptainLayout = changes.some(change =>
          captainLayoutBefore.order.includes(change.id)
          || captainKeepAreaEnabledForTab({ url: change.url }));
        undoEntry = {
          type: 'archive-membership',
          changes,
          ...(affectsCaptainLayout ? { captainLayoutBefore } : {}),
        };
      }
    } else if (entry.type === 'dedupe-pocket') {
      const captainLayoutBefore = captureCaptainLayoutState();
      const closedResult = await recloseTabsForRedo({
        type: 'closed-tabs',
        tabs: entry.tabs,
      }, { pocketIdentity: true });
      const changes = await reapplyArchiveMembership(entry.changes);
      count = closedResult.count + changes.length;
      if (count > 0) {
        undoEntry = {
          type: 'dedupe-pocket',
          tabs: closedResult.undoEntry?.tabs || [],
          changes,
          captainLayoutBefore,
        };
      }
    } else if (entry.type === 'captain-layout') {
      count = await applyCaptainLayoutState(entry.after);
      if (count > 0) undoEntry = entry;
    } else if (entry.type === 'tab-label') {
      count = await applyTabLabelHistoryEntry(entry, entry.after);
      if (count > 0) undoEntry = entry;
    } else if (entry.type === 'captain-keep-lifecycle') {
      const result = await applyCaptainKeepHistory(entry, false);
      count = result.count;
      if (count > 0) undoEntry = result.entry;
      skipDashboardRender = result.domPatched === true;
    } else if (entry.type === 'captain-keep-order') {
      count = await applyCaptainKeepOrder(entry.after);
      if (count > 0) undoEntry = entry;
      skipDashboardRender = count > 0;
    } else if (entry.type === 'pocket-lifecycle') {
      count = await applyPocketLifecycleHistory(entry, false);
      if (count > 0) undoEntry = entry;
    } else if (entry.type === 'captain-pending-dead-lifecycle') {
      count = await applyCaptainPendingDeadHistory(entry, false);
      if (count > 0) undoEntry = entry;
    }

    redoHistory = redoHistory.slice(0, -1);
    if (undoEntry) undoHistory = [...undoHistory, undoEntry].slice(-MAX_UNDO_STEPS);
    await persistUndoHistory();
    if (!skipDashboardRender) await renderDashboard();

    const englishMessage = entry.type === 'dedupe-pocket'
      ? count > 0 ? 'Removed duplicates and put one tab in Pocket again' : 'Nothing remains to redo'
      : entry.type === 'captain-layout'
      ? count > 0 ? 'Reapplied the Captain layout' : 'The Captain layout is already unchanged'
      : entry.type === 'tab-label'
      ? count > 0 ? 'Reapplied the tab name' : 'The tab is no longer available'
      : entry.type === 'captain-keep-lifecycle'
      ? count > 0 ? 'Reapplied the Keep state' : 'The Keep item is no longer available'
      : entry.type === 'pocket-lifecycle'
      ? count > 0 ? 'Reapplied the Pocket state' : 'The Pocket item is no longer available'
      : entry.type === 'captain-pending-dead-lifecycle'
      ? count > 0 ? 'Moved the dead Keep tab to Pending again' : 'The Pending item is no longer available'
      : count > 0
        ? `Redid ${count} tab action${count === 1 ? '' : 's'}`
        : 'No matching tabs remain to redo';
    const chineseMessage = entry.type === 'dedupe-pocket'
      ? count > 0 ? '已再次去除重复项，并将一份扔进「口袋」' : '没有可重做的操作'
      : entry.type === 'captain-layout'
      ? count > 0 ? '已重新应用「常用界面」排列' : '「常用界面」排列没有变化'
      : entry.type === 'tab-label'
      ? count > 0 ? '已重新应用标签名称' : '该标签页已不可用'
      : entry.type === 'captain-keep-lifecycle'
      ? count > 0 ? '已重新应用保留状态' : '该保留项已不可用'
      : entry.type === 'pocket-lifecycle'
      ? count > 0 ? '已重新应用「口袋」状态' : '该「口袋」项目已不可用'
      : count > 0 ? `已重做 ${count} 个标签页操作` : '没有可重做的匹配标签页';
    showToast(uiText(englishMessage, chineseMessage), 2500, entry.type === 'closed-tabs' && count > 0 ? 'destructive' : 'neutral');
  } catch (err) {
    console.warn('[tab-out] Could not redo the latest action:', err);
    showToast(uiText('Could not redo the latest action', '无法重做上一个操作'));
  } finally {
    isUndoing = false;
  }
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

async function focusTabById(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // The tab may have been closed while the dashboard was visible.
  }
}

/**
 * duplicateTabIds(tabs, keepOne)
 *
 * Finds duplicate tabs in the supplied domain group.
 * keepOne=true → keep one copy of each, return the rest.
 * keepOne=false → return all copies.
 */
async function duplicateTabIds(tabs, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const groupTabIds = new Set(tabs.map(tab => tab.id));
  const groupTabs = allTabs.filter(tab => groupTabIds.has(tab.id));
  const toClose = [];

  const tabsByUrl = new Map();
  for (const tab of groupTabs) {
    const identityKey = duplicateIdentityKey(tab);
    if (!identityKey) continue;
    const matching = tabsByUrl.get(identityKey) || [];
    matching.push(tab);
    tabsByUrl.set(identityKey, matching);
  }

  for (const matching of tabsByUrl.values()) {
    if (matching.length < 2) continue;
    if (keepOne) {
      // Duplicate buckets are already isolated by Captain and subgroup. Within
      // a Keep bucket, preserve a retained tab before considering activity/order.
      const keep = matching.find(tab =>
        captainRetainedTabIds.has(tab.id) && isCaptainTab(tab))
        || matching.find(t => t.active)
        || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  return toClose;
}

/** Returns the duplicate copies of one displayed tab, always keeping that tab. */
async function duplicateCopiesForTab(tabId, tabs) {
  const allTabs = await chrome.tabs.query({});
  const clickedTab = allTabs.find(tab => tab.id === tabId);
  if (!clickedTab) {
    traceDuplicateDelete('delete-resolve', {
      clickedTabId: tabId,
      matchedTabIds: [],
      matchedRawUrls: [],
      matchedIdentityUrls: [],
    });
    return [];
  }

  const groupTabIds = new Set(tabs.map(tab => tab.id));
  const clickedIdentityUrl = getPocketIdentityUrl(clickedTab.url);
  const clickedPartition = duplicatePartitionKey(clickedTab);
  const matchingTabs = allTabs.filter(tab =>
    groupTabIds.has(tab.id)
      && duplicatePartitionKey(tab) === clickedPartition
      && getPocketIdentityUrl(tab.url) === clickedIdentityUrl
      && tab.id !== tabId);
  traceDuplicateDelete('delete-resolve', {
    clickedTabId: tabId,
    matchedTabIds: matchingTabs.map(tab => tab.id),
    matchedRawUrls: matchingTabs.map(tab => tab.url || ''),
    matchedIdentityUrls: matchingTabs.map(tab => getPocketIdentityUrl(tab.url || '')),
  });
  return matchingTabs.map(tab => tab.id);
}

/* ----------------------------------------------------------------
   CANDIDATE BATCHES

   Double-Escape always operates on one visible candidate batch. Duplicate URLs
   have priority, followed by redundant ACM paper pages whose PDFs are open,
   followed by error-page candidates. HTTP, navigation, and explicit semantic
   signals are all definitive.
   ---------------------------------------------------------------- */

function acmPaperRoute(tab) {
  const rawUrl = tab?.pendingUrl || tab?.url || '';
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.toLowerCase() !== 'dl.acm.org') return null;
    let path = decodeURIComponent(parsed.pathname).replace(/\/+$/, '');
    let type = 'page';
    if (path.startsWith('/doi/pdf/')) {
      type = 'pdf';
      path = path.slice('/doi/pdf/'.length);
    } else if (path.startsWith('/doi/')) {
      path = path.slice('/doi/'.length);
    } else {
      return null;
    }
    const doi = path.trim().toLowerCase();
    if (!/^10\.\d{4,9}\/.+/.test(doi)) return null;
    return { type, doi };
  } catch {
    return null;
  }
}

function acmPaperPageTabIdsWithOpenPdf(tabs) {
  const routedTabs = (Array.isArray(tabs) ? tabs : [])
    .filter(tab => Number.isInteger(tab?.id))
    .map(tab => ({ tab, route: acmPaperRoute(tab) }))
    .filter(item => item.route);
  const openPdfDois = new Set(routedTabs
    .filter(item => item.route.type === 'pdf')
    .map(item => item.route.doi));
  return routedTabs
    .filter(item => item.route.type === 'page' && openPdfDois.has(item.route.doi))
    .map(item => item.tab.id);
}

function isCandidateBatchActive() {
  return ['duplicate', 'acm-paper', 'error'].includes(candidateBatchMode);
}

function errorSignalMatchesTab(signal, tab) {
  if (!signal?.url) return false;
  const tabUrl = tab?.pendingUrl || tab?.url || '';
  try {
    const signalUrl = new URL(signal.url);
    const currentUrl = new URL(tabUrl);
    signalUrl.hash = '';
    currentUrl.hash = '';
    return signalUrl.href === currentUrl.href;
  } catch {
    return signal.url === tabUrl;
  }
}

async function refreshDetectedErrorTabs(tabs) {
  try {
    const stored = await chrome.storage.session.get(ERROR_TAB_SIGNALS_KEY);
    const signals = stored[ERROR_TAB_SIGNALS_KEY];
    const nextIds = new Set();
    const tabsById = new Map((Array.isArray(tabs) ? tabs : [])
      .filter(tab => Number.isInteger(tab?.id))
      .map(tab => [String(tab.id), tab]));
    for (const [tabId, signal] of Object.entries(signals || {})) {
      const tab = tabsById.get(tabId);
      traceErrorDetect('dashboard-signal-evaluation', {
        tabId: Number(tabId),
        signalUrl: signal?.url || '',
        signalSources: signal?.sources || {},
        tabExists: Boolean(tab),
        tabUrl: tab?.url || '',
        pendingUrl: tab?.pendingUrl || '',
        title: tab?.title || '',
        urlMatches: Boolean(tab && errorSignalMatchesTab(signal, tab)),
      });
    }
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      const signal = signals?.[String(tab.id)];
      if (errorSignalMatchesTab(signal, tab)
        && Object.keys(signal.sources || {}).length > 0) {
        nextIds.add(tab.id);
      }
    }
    detectedErrorTabIds = nextIds;
    traceErrorDetect('dashboard-refresh-result', {
      storedSignalTabIds: Object.keys(signals || {}).map(Number),
      detectedErrorTabIds: [...detectedErrorTabIds],
    });
  } catch (error) {
    traceErrorDetect('dashboard-refresh-error', {
      error: error instanceof Error ? error.message : String(error),
    });
    detectedErrorTabIds = new Set();
  }
}

function isErrorTabCandidate(tab) {
  if (detectedErrorTabIds.has(tab?.id)) return true;
  const title = typeof tab?.title === 'string' ? tab.title.trim() : '';
  return Boolean(globalThis.TAB_OUT_ERROR_SEMANTICS?.match(title));
}

function updateCandidateBatch(tabs) {
  const liveTabs = (Array.isArray(tabs) ? tabs : [])
    .filter(tab => Number.isInteger(tab?.id));
  const urlCounts = new Map();

  for (const tab of liveTabs) {
    const identityKey = duplicateIdentityKey(tab);
    if (!identityKey) continue;
    urlCounts.set(identityKey, (urlCounts.get(identityKey) || 0) + 1);
  }

  const duplicateUrls = new Set([...urlCounts]
    .filter(([, count]) => count > 1)
    .map(([identityKey]) => identityKey));
  if (duplicateUrls.size > 0) {
    candidateBatchMode = 'duplicate';
    candidateTabIds = new Set(liveTabs
      .filter(tab => duplicateUrls.has(duplicateIdentityKey(tab)))
      .map(tab => tab.id));
    if (detectedErrorTabIds.size > 0) {
      traceErrorDetect('candidate-blocked-by-duplicates', {
        detectedErrorTabIds: [...detectedErrorTabIds],
        duplicateCandidateTabIds: [...candidateTabIds],
      });
    }
    return;
  }

  const acmPaperTabIds = acmPaperPageTabIdsWithOpenPdf(liveTabs);
  if (acmPaperTabIds.length > 0) {
    candidateBatchMode = 'acm-paper';
    candidateTabIds = new Set(acmPaperTabIds);
    return;
  }

  const errorTabs = liveTabs.filter(isErrorTabCandidate);
  candidateBatchMode = errorTabs.length > 0 ? 'error' : null;
  candidateTabIds = new Set(errorTabs.map(tab => tab.id));
  if (detectedErrorTabIds.size > 0 || errorTabs.length > 0) {
    traceErrorDetect('candidate-result', {
      mode: candidateBatchMode,
      detectedErrorTabIds: [...detectedErrorTabIds],
      candidateTabIds: [...candidateTabIds],
    });
  }
}

function isCandidateTab(tab) {
  return Number.isInteger(tab?.id) && candidateTabIds.has(tab.id);
}

function candidateHeaderPromptMessage() {
  if (candidateBatchMode === 'duplicate') {
    return keyboardPromptHtml(['Esc'], uiText('Delete All Duplicates', '去除所有重复标签页'), uiText('Double-tap', '双击'));
  }
  if (candidateBatchMode === 'acm-paper') {
    return keyboardPromptHtml(['Esc'], uiText('Delete ACM Pages with Open PDFs', '删除已打开 PDF 的 ACM 论文主页'), uiText('Double-tap', '双击'));
  }
  if (candidateBatchMode === 'error') {
    return keyboardPromptHtml(['Esc'], uiText('Delete All Errors', '删除所有出错页面'), uiText('Double-tap', '双击'));
  }
  return '';
}

function syncCandidateHeaderPrompt(animateNewRound = false) {
  const prompt = document.getElementById('candidateKeyboardPrompt');
  if (!prompt) return;

  const message = candidateHeaderPromptMessage();
  prompt.innerHTML = message;
  prompt.hidden = !message;
  if (!message) {
    prompt.classList.remove('is-new-round');
    if (candidateHeaderShimmerTimer !== null) {
      window.clearTimeout(candidateHeaderShimmerTimer);
      candidateHeaderShimmerTimer = null;
    }
    return;
  }
  if (!animateNewRound) return;

  // Removing and restoring the class makes the shimmer replay when a later
  // candidate type becomes the active double-Escape round.
  prompt.classList.remove('is-new-round');
  void prompt.offsetWidth;
  prompt.classList.add('is-new-round');
  if (candidateHeaderShimmerTimer !== null) {
    window.clearTimeout(candidateHeaderShimmerTimer);
  }
  candidateHeaderShimmerTimer = window.setTimeout(() => {
    prompt.classList.remove('is-new-round');
    candidateHeaderShimmerTimer = null;
  }, 1700);
}

function syncArchiveLooseTabsHeaderPrompt() {
  clearLooseTabsPromptPreview();
  const prompt = document.getElementById('archiveLooseTabsKeyboardPrompt');
  if (!prompt) return;
  const archivePrompt = readLaterEnabled
    ? `<span class="prompt-stage-item">${keyboardPromptKeysHtml(['Enter'], uiText('', '按'))}<span class="prompt-label">${uiText('Put all ', '把所有')}<strong class="prompt-strong" data-bulk-preview="archive">${uiText('loose tabs', '零落标签')}</strong>${uiText(' in Pocket', '扔进「口袋」')}</span></span>`
    : '';
  const deletePrompt = `<span class="prompt-stage-item">${keyboardPromptKeysHtml(['Backspace'], uiText('', '按'))}<span class="prompt-label">${uiText('Delete all ', '删除所有')}<strong class="prompt-strong" data-bulk-preview="delete">${uiText('loose tabs', '零落标签')}</strong></span></span>`;
  prompt.innerHTML = [archivePrompt, deletePrompt].filter(Boolean).join('');
}

function clearLooseTabsPromptPreview() {
  document.querySelectorAll('.page-chip.is-loose-prompt-target').forEach(chip => {
    chip.classList.remove(
      'is-loose-prompt-target',
      'is-loose-prompt-archive-target',
      'is-loose-prompt-delete-target',
    );
  });
}

function showLooseTabsPromptPreview(action) {
  clearLooseTabsPromptPreview();
  const targetIds = new Set(domainGroups
    .flatMap(group => group.tabs || [])
    .filter(tab => !captainKeepAreaEnabledForTab(tab))
    .map(tab => tab.id));
  const actionClass = action === 'archive'
    ? 'is-loose-prompt-archive-target'
    : 'is-loose-prompt-delete-target';
  document.querySelectorAll('.page-chip[data-tab-id]').forEach(chip => {
    if (!targetIds.has(Number(chip.dataset.tabId))) return;
    chip.classList.add('is-loose-prompt-target', actionClass);
  });
}

document.addEventListener('pointerover', event => {
  const target = event.target.closest?.('.keyboard-prompts .prompt-strong');
  if (!target || target.contains(event.relatedTarget)) return;
  showLooseTabsPromptPreview(target.dataset.bulkPreview);
});

document.addEventListener('pointerout', event => {
  const target = event.target.closest?.('.keyboard-prompts .prompt-strong');
  if (!target || target.contains(event.relatedTarget)) return;
  clearLooseTabsPromptPreview();
});

window.addEventListener('blur', clearLooseTabsPromptPreview);

/** Shows exactly one shortcut, advancing from cleanup to bulk action to Undo. */
function syncKeyboardPromptProgression() {
  const selectionPrompt = document.getElementById('selectionKeyboardPrompt');
  const candidatePrompt = document.getElementById('candidateKeyboardPrompt');
  const bulkPrompt = document.getElementById('archiveLooseTabsKeyboardPrompt');
  const undoPrompt = document.getElementById('undoKeyboardPrompt');
  const hasMarqueeSelection = Boolean(document.querySelector('.page-chip.is-marquee-selected'));
  const hasCandidateBatch = isCandidateBatchActive();
  const hasOpenNonCaptainTabs = domainGroups.some(group =>
    (group.tabs || []).some(tab => !captainKeepAreaEnabledForTab(tab)));
  const hasPocketTabs = archivedDomainGroups.some(group =>
    (group.tabs || []).length > 0);
  const hasBulkTarget = hasOpenNonCaptainTabs;

  if (selectionPrompt) {
    const archiveSelection = readLaterEnabled
      ? keyboardPromptHtml(['Enter'], uiText('put in Pocket', '扔进「口袋」'), uiText('', '按'))
      : '';
    const deleteSelection = keyboardPromptHtml(['Backspace'], uiText('delete', '删除'), uiText('', '按'));
    selectionPrompt.innerHTML = [archiveSelection, deleteSelection]
      .filter(Boolean)
      .map(item => `<span class="selection-shortcut">${item}</span>`)
      .join('');
  }

  if (undoPrompt) {
    const undoHtml = keyboardPromptHtml(
      ['⌘', 'Z'],
      uiText('Withdraw', '撤回'),
      uiText('', '按'),
    );
    const pocketLeadHtml = readLaterEnabled && hasPocketTabs
      ? keyboardPromptHtml(
        ['Shift'],
        pocketVisible
          ? uiText('hide Pocket', '隐藏「口袋」')
          : uiText('show Pocket', '显示「口袋」'),
        uiText('', '按'),
      )
      : '';
    undoPrompt.innerHTML = [pocketLeadHtml, undoHtml]
      .filter(Boolean)
      .map(item => `<span class="prompt-stage-item">${item}</span>`)
      .join('');
  }

  if (selectionPrompt) selectionPrompt.hidden = !hasMarqueeSelection;
  if (candidatePrompt) candidatePrompt.hidden = hasMarqueeSelection || !hasCandidateBatch;
  if (bulkPrompt) bulkPrompt.hidden = hasMarqueeSelection || hasCandidateBatch || !hasBulkTarget;
  if (undoPrompt) undoPrompt.hidden = hasMarqueeSelection || hasCandidateBatch || hasBulkTarget;
}

/**
 * keepNewestTabOut()
 *
 * Keeps the most recently created Tab Out page and closes every older one.
 *
 * Ctrl/Cmd+T is handled by Chrome, so Chrome creates and focuses a new tab
 * (including its native omnibox) before this extension page loads. By keeping
 * that newest tab rather than navigating back to an older one, we preserve
 * the native address-bar focus while ensuring only one Tab Out page remains.
 *
 * Tab ids are allocated in creation order during a browser session. Choosing
 * the highest id also makes fast, repeated Ctrl/Cmd+T presses deterministic:
 * older pages can never close a newer page that is still initializing.
 */
async function keepNewestTabOut() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const currentTab = await chrome.tabs.getCurrent();
  if (!currentTab || typeof currentTab.id !== 'number') return true;

  const allTabs = await chrome.tabs.query({});
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  const newestTab = tabOutTabs.reduce(
    (newest, tab) => !newest || tab.id > newest.id ? tab : newest,
    null
  );

  // This page lost a race to a newer Ctrl/Cmd+T tab. Close only itself; the
  // newer page performs the cleanup, so it remains the focused new tab.
  if (newestTab && newestTab.id !== currentTab.id) {
    await chrome.tabs.remove(currentTab.id);
    return false;
  }

  const olderTabIds = tabOutTabs
    .filter(tab => tab.id !== currentTab.id)
    .map(tab => tab.id);
  if (olderTabIds.length > 0) await chrome.tabs.remove(olderTabIds);

  return true;
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

// Each confetti burst uses every hue once (brown is intentionally excluded).
// Three randomly selected hues use their light tone; the rest use the dark tone.
const CONFETTI_COLOR_PAIRS = Object.freeze([
  Object.freeze({ dark: '#787774', light: '#F1F1EF' }), // gray
  Object.freeze({ dark: '#CC782F', light: '#F8ECDF' }), // orange
  Object.freeze({ dark: '#C29343', light: '#FAF3DD' }), // yellow
  Object.freeze({ dark: '#548164', light: '#EEF3ED' }), // green
  Object.freeze({ dark: '#487CA5', light: '#E9F3F7' }), // blue
  Object.freeze({ dark: '#8A67AB', light: '#F6F3F8' }), // purple
  Object.freeze({ dark: '#B35488', light: '#F9F2F5' }), // pink
  Object.freeze({ dark: '#C4554D', light: '#FAECEC' }), // red
]);

function shuffledCopy(items) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const swapIndex = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[i]];
  }
  return shuffled;
}

function createConfettiPalette() {
  const randomizedTones = shuffledCopy(CONFETTI_COLOR_PAIRS)
    .map((pair, index) => index < 3 ? pair.light : pair.dark);
  return shuffledCopy(randomizedTones);
}

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  globalThis.TabOutAudio?.playCloseSwoosh();
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = createConfettiPalette();
  const particleCount = colors.length;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[i];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
let toastHideTimer = null;

function resetToast() {
  const toast = document.getElementById('toast');
  if (!toast) return;
  if (toastHideTimer !== null) window.clearTimeout(toastHideTimer);
  toastHideTimer = null;
  toast.classList.remove('visible');
  toast.classList.remove('is-destructive');
  toast.hidden = true;
  const text = document.getElementById('toastText');
  if (text) text.textContent = '';
}

function showToast(message, duration = 2500, tone = 'neutral') {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  if (toastHideTimer !== null) window.clearTimeout(toastHideTimer);
  toast.classList.toggle('is-destructive', tone === 'destructive');
  toast.hidden = false;
  toast.classList.add('visible');
  toastHideTimer = window.setTimeout(() => {
    toast.classList.remove('visible');
    toastHideTimer = null;
  }, duration);
}

function pocketRestoreToastMessage(count) {
  return uiText(
    `You took ${count} tab${count === 1 ? '' : 's'} out of Pocket`,
    `你从「口袋」掏出了 ${count} 个`,
  );
}

/* Tab URLs use a deliberate tooltip instead of the browser-native title
   attribute, whose timing and hit area cannot be controlled. */
let tabTooltipTimer = null;
let tabTooltipTarget = null;
let tabTooltipElement = null;

function hideTabUrlTooltip() {
  if (tabTooltipTimer !== null) window.clearTimeout(tabTooltipTimer);
  tabTooltipTimer = null;
  tabTooltipTarget = null;
  tabTooltipElement?.remove();
  tabTooltipElement = null;
}

function showTabUrlTooltip(target) {
  if (!target?.isConnected || target !== tabTooltipTarget) return;
  const url = target.dataset.tooltipUrl;
  if (!url) return;

  const tooltip = document.createElement('div');
  tooltip.className = 'tab-url-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  const urlEl = document.createElement('div');
  urlEl.className = 'tab-url-tooltip__url';
  urlEl.textContent = url;
  const copyHintEl = document.createElement('div');
  copyHintEl.className = 'tab-url-tooltip__copy-hint';
  copyHintEl.textContent = uiText('Press C to copy', '按 C 复制');
  tooltip.append(urlEl, copyHintEl);
  document.body.append(tooltip);

  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const edge = 8;
  const left = Math.min(
    window.innerWidth - tooltipRect.width - edge,
    Math.max(edge, targetRect.left),
  );
  const above = targetRect.top - tooltipRect.height - 7;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${above >= edge ? above : targetRect.bottom + 7}px`;
  tooltip.classList.add('visible');
  tabTooltipElement = tooltip;
  tabTooltipTimer = null;
}

document.addEventListener('pointerover', event => {
  const target = event.target.closest?.('.chip-text[data-tooltip-url]');
  if (!target || target === tabTooltipTarget) return;
  hideTabUrlTooltip();
  tabTooltipTarget = target;
  tabTooltipTimer = window.setTimeout(() => showTabUrlTooltip(target), 600);
});

document.addEventListener('pointerout', event => {
  if (!tabTooltipTarget) return;
  if (event.target.closest?.('.chip-text[data-tooltip-url]') !== tabTooltipTarget) return;
  if (tabTooltipTarget.contains(event.relatedTarget)) return;
  hideTabUrlTooltip();
});

document.addEventListener('pointerdown', hideTabUrlTooltip);
window.addEventListener('blur', hideTabUrlTooltip);
window.addEventListener('scroll', hideTabUrlTooltip, true);

document.addEventListener('keydown', async event => {
  if (!tabTooltipElement?.classList.contains('visible') || !tabTooltipTarget) return;
  if (event.key.toLowerCase() !== 'c' || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement
    && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;

  const url = tabTooltipTarget.dataset.tooltipUrl;
  if (!url) return;
  event.preventDefault();
  try {
    await navigator.clipboard.writeText(url);
  } catch (error) {
    console.warn('[tab-out] Could not copy the tab URL:', error);
  }
});

const ARCHIVE_TOOLTIP_SELECTOR = [
  '[data-action="archive-tab"]',
  '[data-action="archive-domain-tabs"]',
  '[data-action="archive-captain-pending"]',
].join(',');
let archiveTooltipTimer = null;
let archiveTooltipTarget = null;
let archiveTooltipElement = null;

function hideArchiveActionTooltip() {
  if (archiveTooltipTimer !== null) window.clearTimeout(archiveTooltipTimer);
  archiveTooltipTimer = null;
  archiveTooltipTarget = null;
  archiveTooltipElement?.remove();
  archiveTooltipElement = null;
}

function showArchiveActionTooltip(target) {
  if (!target?.isConnected || target !== archiveTooltipTarget) return;

  const tooltip = document.createElement('div');
  tooltip.className = 'tab-url-tooltip archive-action-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = uiText('Put in Pocket?', '扔进「口袋」？');
  document.body.append(tooltip);

  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const edge = 8;
  const left = Math.min(
    window.innerWidth - tooltipRect.width - edge,
    Math.max(edge, targetRect.left + (targetRect.width - tooltipRect.width) / 2),
  );
  const above = targetRect.top - tooltipRect.height - 7;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${above >= edge ? above : targetRect.bottom + 7}px`;
  tooltip.classList.add('visible');
  archiveTooltipElement = tooltip;
  archiveTooltipTimer = null;
}

document.addEventListener('pointerover', event => {
  const target = event.target.closest?.(ARCHIVE_TOOLTIP_SELECTOR);
  if (!target || target === archiveTooltipTarget) return;
  hideArchiveActionTooltip();
  archiveTooltipTarget = target;
  archiveTooltipTimer = window.setTimeout(() => showArchiveActionTooltip(target), 1100);
});

document.addEventListener('pointerout', event => {
  if (!archiveTooltipTarget) return;
  if (event.target.closest?.(ARCHIVE_TOOLTIP_SELECTOR) !== archiveTooltipTarget) return;
  if (archiveTooltipTarget.contains(event.relatedTarget)) return;
  hideArchiveActionTooltip();
});

document.addEventListener('pointerdown', hideArchiveActionTooltip);
window.addEventListener('blur', hideArchiveActionTooltip);
window.addEventListener('scroll', hideArchiveActionTooltip, true);

/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'bambu':                'Bambu Lab',
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (isFeishuHostname(hostname)) return 'Feishu Docs';

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Keep domain normalization in the ordinary domain-group-key path. Bambu's
// country TLDs and their subdomains represent one product surface here.
function domainGroupKey(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  const bambuRoots = ['bambu.com', 'bambu.cn', 'bambulab.com', 'bambulab.cn'];
  if (bambuRoots.some(root => normalized === root || normalized.endsWith(`.${root}`))) {
    return 'bambu';
  }
  return hostname;
}

function isFeishuHostname(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z\d+.-]*:\/\//, '')
    .split(/[/?#]/, 1)[0]
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  return normalized === 'feishu.cn' || normalized.endsWith('.feishu.cn');
}

function parsedUrlForDisplay(url) {
  try {
    return new URL(url);
  } catch {
    if (typeof url !== 'string' || !url.trim() || /^[a-z][a-z\d+.-]*:/i.test(url.trim())) return null;
    try { return new URL(`https://${url.trim()}`); } catch { return null; }
  }
}

function isBambuWikiUrl(url) {
  const parsed = parsedUrlForDisplay(url);
  return Boolean(parsed && /^wiki\.bambu(?:lab)?\.(?:com|cn)$/i.test(parsed.hostname));
}

function isBambuUrl(url) {
  const parsed = parsedUrlForDisplay(url);
  return Boolean(parsed && domainGroupKey(parsed.hostname) === 'bambu');
}

function isFeishuDocumentUrl(url) {
  const parsed = parsedUrlForDisplay(url);
  return Boolean(parsed
    && isFeishuHostname(parsed.hostname)
    && /^\/(?:wiki|docx|sheets|base|minutes)\//i.test(parsed.pathname));
}

function chipFaviconUrl(tab, domain, groupDomain) {
  const urls = [tab.url, tab.pendingUrl].filter(Boolean);
  if (urls.some(isBambuWikiUrl)) return 'assets/images/Bambuwiki.png';
  if (urls.some(isBambuUrl)) return 'assets/images/Bambu.png';
  if (urls.some(isFeishuDocumentUrl)) return 'assets/icons/Docs.svg';
  return domain && groupDomain !== '__browser_internal__'
    ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16`
    : '';
}

function isMediaDomainGroup(domain) {
  const hostname = String(domain || '').toLowerCase();
  return ['bilibili.com', 'youtube.com', 'ikanbot.com']
    .some(root => hostname === root || hostname.endsWith(`.${root}`));
}

function domainGroupIconName(domain) {
  if (domain === 'bambu') return 'bambu';
  return isMediaDomainGroup(domain) ? 'movie' : '';
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  const parsedUrl = parsedUrlForDisplay(url);
  if (!parsedUrl) return title || '';
  const { pathname, hostname } = parsedUrl;

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if (isBambuWikiUrl(url)) {
    return title.replace(/\s*\|\s*Bambu Lab Wiki\s*$/i, '').trim() || title;
  }

  if (isFeishuDocumentUrl(url)) {
    const withoutFeishuSuffix = title.replace(/\s*[-\u2010-\u2015]\s*Feishu Docs\s*$/i, '').trim();
    if (withoutFeishuSuffix) return withoutFeishuSuffix;
  }

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];
let archivedDomainGroups = [];
const stableGroupDomains = {
  open: [],
  archive: [],
};
const stableOpenGroupLayout = {
  columnCount: 0,
  columns: [],
  reservedHeights: new Map(),
};

const DASHBOARD_LAYOUT_MAX_WIDTH = 960;
const DASHBOARD_LAYOUT_DEFAULT_HORIZONTAL_PADDING = 64;
const DASHBOARD_LAYOUT_COMPACT_HORIZONTAL_PADDING = 24;
const DASHBOARD_LAYOUT_COLUMN_GAP = 18;
const DASHBOARD_CARD_MIN_WIDTH = 205;
const DASHBOARD_POCKET_CLEARANCE = 12;
const DASHBOARD_EDGE_GUTTER = 24;
const DASHBOARD_SPLIT_WINDOW_RATIO = 0.62;

function dashboardLayoutMetrics() {
  const viewportWidth = Math.max(0, document.documentElement.clientWidth || window.innerWidth);
  const pocket = document.getElementById('archiveSection');
  const pocketHasContent = !document.body.classList.contains('pocket-empty');
  const reservePocketOverlay = readLaterEnabled && pocketHasContent && Boolean(pocket);
  let safeStart = 0;
  let safeEnd = viewportWidth;

  if (reservePocketOverlay) {
    const pocketWidth = pocket.getBoundingClientRect().width
      || Number.parseFloat(getComputedStyle(document.body).getPropertyValue('--pocket-side-width'))
      || 0;
    if (pocketPosition === 'left') {
      safeStart = Math.min(viewportWidth, pocketWidth + DASHBOARD_POCKET_CLEARANCE);
      safeEnd = Math.max(safeStart, viewportWidth - DASHBOARD_EDGE_GUTTER);
    } else {
      safeStart = Math.min(viewportWidth, DASHBOARD_EDGE_GUTTER);
      safeEnd = Math.max(safeStart, viewportWidth - pocketWidth - DASHBOARD_POCKET_CLEARANCE);
    }
  }

  const safeWidth = Math.max(0, safeEnd - safeStart);
  const viewportCenter = viewportWidth / 2;
  const centeredClearWidth = reservePocketOverlay
    ? Math.max(0, 2 * Math.min(viewportCenter - safeStart, safeEnd - viewportCenter))
    : viewportWidth;
  const minimumSingleColumnWidth = DASHBOARD_LAYOUT_DEFAULT_HORIZONTAL_PADDING
    + DASHBOARD_CARD_MIN_WIDTH;
  const availableScreenWidth = Math.max(viewportWidth, window.screen?.availWidth || 0);
  const isCompactSplitWindow = viewportWidth
    <= availableScreenWidth * DASHBOARD_SPLIT_WINDOW_RATIO;
  const compactTwoColumnWidth = DASHBOARD_LAYOUT_COMPACT_HORIZONTAL_PADDING
    + (DASHBOARD_CARD_MIN_WIDTH * 2)
    + DASHBOARD_LAYOUT_COLUMN_GAP;
  const centeredCanKeepTwoColumns = dashboardColumnCount < 2
    || centeredClearWidth >= compactTwoColumnWidth;
  const sideLaneCanKeepTwoColumns = dashboardColumnCount >= 2
    && safeWidth >= compactTwoColumnWidth;
  const shouldUseSideLane = reservePocketOverlay && (
    isCompactSplitWindow
    || (!centeredCanKeepTwoColumns && sideLaneCanKeepTwoColumns)
    || centeredClearWidth < minimumSingleColumnWidth
  );
  const keepViewportCentered = !shouldUseSideLane;
  const layoutAvailableWidth = keepViewportCentered ? centeredClearWidth : safeWidth;
  const defaultTwoColumnWidth = DASHBOARD_LAYOUT_DEFAULT_HORIZONTAL_PADDING
    + (DASHBOARD_CARD_MIN_WIDTH * 2)
    + DASHBOARD_LAYOUT_COLUMN_GAP;
  const useCompactPadding = reservePocketOverlay
    && layoutAvailableWidth < defaultTwoColumnWidth;
  const horizontalPadding = useCompactPadding
    ? DASHBOARD_LAYOUT_COMPACT_HORIZONTAL_PADDING
    : DASHBOARD_LAYOUT_DEFAULT_HORIZONTAL_PADDING;
  let columnCount = dashboardColumnCount;
  while (columnCount > 1) {
    const requiredWidth = horizontalPadding
      + (DASHBOARD_CARD_MIN_WIDTH * columnCount)
      + (DASHBOARD_LAYOUT_COLUMN_GAP * (columnCount - 1));
    if (layoutAvailableWidth >= requiredWidth) break;
    columnCount -= 1;
  }
  if (window.matchMedia('(max-width: 520px)').matches) columnCount = 1;

  const areaWidth = Math.min(
    DASHBOARD_LAYOUT_MAX_WIDTH,
    layoutAvailableWidth || viewportWidth,
  );
  const areaLeft = keepViewportCentered
    ? Math.max(0, (viewportWidth - areaWidth) / 2)
    : safeStart + Math.max(0, (safeWidth - areaWidth) / 2);
  return { columnCount, areaLeft, areaWidth, horizontalPadding };
}

function syncDashboardAdaptiveLayout(metrics = dashboardLayoutMetrics()) {
  document.body.classList.add('dashboard-adaptive-layout');
  document.body.style.setProperty('--dashboard-area-left', `${metrics.areaLeft}px`);
  document.body.style.setProperty('--dashboard-area-width', `${metrics.areaWidth}px`);
  document.body.style.setProperty(
    '--dashboard-side-padding',
    `${metrics.horizontalPadding / 2}px`,
  );
  return metrics;
}

function openGroupColumnCount() {
  return dashboardLayoutMetrics().columnCount;
}

function resetStableOpenGroupLayout() {
  stableOpenGroupLayout.columnCount = 0;
  stableOpenGroupLayout.columns = [];
  stableOpenGroupLayout.reservedHeights.clear();
}


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns every tab the extension can manage at the browser-tab layer.
 * Browser-internal pages are included; Tab Out itself and blank tabs are not.
 */
function getRealTabs() {
  return openTabs.filter(isManageableTab);
}

function buildDomainGroups(tabs) {
  const landingPatterns = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',            pathExact: ['/home'] },
    { hostname: 'www.linkedin.com', pathExact: ['/'] },
    { hostname: 'github.com',       pathExact: ['/'] },
    { hostname: 'www.youtube.com',  pathExact: ['/'] },
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];
  const groupMap = {};
  const landingTabs = [];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return landingPatterns.some(pattern => {
        const hostnameMatch = pattern.hostname
          ? parsed.hostname === pattern.hostname
          : pattern.hostnameEndsWith
            ? parsed.hostname.endsWith(pattern.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (pattern.test) return pattern.test(parsed.pathname, url);
        if (pattern.pathPrefix) return parsed.pathname.startsWith(pattern.pathPrefix);
        if (pattern.pathExact) return pattern.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(rule => {
        const hostMatch = rule.hostname
          ? parsed.hostname === rule.hostname
          : rule.hostnameEndsWith
            ? parsed.hostname.endsWith(rule.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        return !rule.pathPrefix || parsed.pathname.startsWith(rule.pathPrefix);
      }) || null;
    } catch { return null; }
  }

  for (const tab of tabs) {
    try {
      const captainIndex = captainIndexForTab(tab);
      if (captainIndex >= 0) {
        const config = captainConfigs[captainIndex];
        const groupKey = captainGroupKey(captainIndex);
        if (!groupMap[groupKey]) {
          groupMap[groupKey] = {
            domain: groupKey,
            label: captainTitle(config),
            tabs: [],
          };
        }
        groupMap[groupKey].tabs.push(tab);
        continue;
      }

      // PDFs remain grouped together when another domain is Captain, but no
      // longer receive Captain placement, split, or native-group behavior.
      if (isPdfTab(tab)) {
        if (!groupMap.__pdf__) {
          groupMap.__pdf__ = { domain: '__pdf__', label: 'PDF', tabs: [] };
        }
        groupMap.__pdf__.tabs.push(tab);
        continue;
      }

      if (isBrowserInternalUrl(tab.url)) {
        if (!groupMap.__browser_internal__) {
          groupMap.__browser_internal__ = { domain: '__browser_internal__', label: 'Chrome', tabs: [] };
        }
        groupMap.__browser_internal__.tabs.push(tab);
        continue;
      }

      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      const hostname = tab.url?.startsWith('file://') ? 'local-files' : new URL(tab.url).hostname;
      if (!hostname) continue;
      const groupKey = domainGroupKey(hostname);
      if (!groupMap[groupKey]) groupMap[groupKey] = { domain: groupKey, tabs: [] };
      groupMap[groupKey].tabs.push(tab);
    } catch {
      // Skip malformed URLs.
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  const landingHostnames = new Set(landingPatterns.map(pattern => pattern.hostname).filter(Boolean));
  const landingSuffixes = landingPatterns.map(pattern => pattern.hostnameEndsWith).filter(Boolean);
  const isLandingDomain = domain =>
    landingHostnames.has(domain) || landingSuffixes.some(suffix => domain.endsWith(suffix));

  return Object.values(groupMap).sort((a, b) => {
    const aCaptainIndex = captainIndexForGroupKey(a.domain);
    const bCaptainIndex = captainIndexForGroupKey(b.domain);
    if (aCaptainIndex >= 0 || bCaptainIndex >= 0) {
      if (aCaptainIndex < 0) return 1;
      if (bCaptainIndex < 0) return -1;
      return aCaptainIndex - bCaptainIndex;
    }

    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });
}

function buildPocketGroups(tabs) {
  if (pocketGroupLooseTabs) return applyPocketManualOrder(buildDomainGroups(tabs));

  const captainTabs = tabs.filter(tab => isCaptainTab(tab));
  const looseTabs = tabs.filter(tab => !isCaptainTab(tab));
  const groups = buildDomainGroups(captainTabs);
  if (looseTabs.length > 0) {
    groups.push({
      domain: POCKET_LOOSE_GROUP_KEY,
      label: uiText('Loose tabs', '零落标签'),
      tabs: looseTabs,
    });
  }
  return applyPocketManualOrder(groups);
}

function buildPocketDisplayTabs(liveTabs) {
  const liveTabsById = new Map(liveTabs.map(tab => [tab.id, tab]));
  const liveTabIdByItemId = new Map();
  for (const [tabId, itemId] of Object.entries(pocketLiveItemIds)) {
    const numericTabId = Number(tabId);
    if (liveTabsById.has(numericTabId)) liveTabIdByItemId.set(itemId, numericTabId);
  }

  const representedLiveTabIds = new Set();
  const displayTabs = pocketItems
    .slice()
    .sort((a, b) => a.order - b.order)
    .map(item => {
      const liveTabId = item.state === 'live' ? liveTabIdByItemId.get(item.id) : null;
      const liveTab = Number.isInteger(liveTabId) ? liveTabsById.get(liveTabId) : null;
      const boundTabId = Number.isInteger(liveTabId) ? liveTabId : pocketBoundTabId(item.id);
      tracePocketBind('render-state', {
        pocketItemId: item.id,
        url: item.url,
        customLabel: normalizeCustomLabel(item.customLabel) || null,
        boundTabId,
        boundTabExists: Boolean(liveTab),
        renderedDormant: !liveTab,
      });
      if (liveTab) {
        representedLiveTabIds.add(liveTab.id);
        return {
          ...liveTab,
          pocketItemId: item.id,
          pocketOrder: item.order,
          pocketDormant: false,
          pocketState: 'live',
          ...(normalizeCustomLabel(item.customLabel) ? { customLabel: item.customLabel } : {}),
        };
      }
      return {
        url: item.url,
        title: item.title,
        pocketItemId: item.id,
        pocketOrder: item.order,
        pocketDormant: true,
        pocketState: 'dead',
        ...(normalizeCustomLabel(item.customLabel) ? { customLabel: item.customLabel } : {}),
      };
    });

  // A just-added tab can render before the storage event carrying its link.
  // Keep it visible as live for that one pass; the worker's next prune binds
  // it to a persistent item.
  for (const tab of liveTabs) {
    if (!representedLiveTabIds.has(tab.id)) displayTabs.push(tab);
  }
  return displayTabs;
}

function dormantPocketItemIds(tabs) {
  return [...new Set((tabs || [])
    .filter(tab => tab?.pocketDormant && typeof tab.pocketItemId === 'string')
    .map(tab => tab.pocketItemId))];
}

function livePocketTabIds(tabs) {
  return normalizeTabIds((tabs || [])
    .filter(tab => !tab?.pocketDormant)
    .map(tab => tab.id));
}

function pocketItemById(itemId) {
  return pocketItems.find(item => item.id === itemId) || null;
}

function pocketBoundTabId(itemId) {
  const entry = Object.entries(pocketLiveItemIds)
    .find(([, boundItemId]) => boundItemId === itemId);
  const tabId = entry ? Number(entry[0]) : NaN;
  return Number.isInteger(tabId) ? tabId : null;
}

function dormantPocketItemMatchingUrl(url, livePocketTabIds = new Set()) {
  const identityUrl = getPocketIdentityUrl(url);
  return pocketItems.find(item => {
    if (getPocketIdentityUrl(item.url) !== identityUrl) return false;
    const boundTabId = pocketBoundTabId(item.id);
    return !Number.isInteger(boundTabId) || !livePocketTabIds.has(boundTabId);
  }) || null;
}

async function openDormantPocketItem(itemId) {
  const item = pocketItemById(itemId);
  if (!item?.url) return null;
  beginDashboardRefreshSuppression();
  pocketLifecycleMutationDepth += 1;
  try {
    const tab = await createDashboardTabWithOrigin('dormant-pocket-open', {
      url: item.url,
      active: true,
    });
    await requestPocketStateMutation('bind', [tab.id], [item.id]);
    return tab;
  } finally {
    pocketLifecycleMutationDepth = Math.max(0, pocketLifecycleMutationDepth - 1);
    endDashboardRefreshSuppression();
  }
}

function patchPocketItemChip(itemId, state, tab = null) {
  const chip = document.querySelector(`.page-chip[data-pocket-item-id="${CSS.escape(itemId)}"]`);
  const item = pocketItemById(itemId);
  const actions = chip?.querySelector('.chip-actions');
  if (!chip || !item || !actions) return false;
  const itemAttribute = ` data-pocket-item-id="${escapeHtmlAttribute(itemId)}"`;
  if (state === 'dead') {
    chip.classList.add('is-dormant-pocket');
    chip.classList.remove('chip-has-dupes', 'cleanup-item', 'candidate');
    delete chip.dataset.tabId;
    delete chip.dataset.dragTabId;
    chip.dataset.dragPocketItemId = itemId;
    chip.closest('.page-chip-wrapper')?.classList.remove('has-duplicate-stack');
    chip.querySelector('.chip-dupe-indicator')?.remove();
    actions.innerHTML = `<button class="restore-tab-button icon-button" data-action="restore-tab"${itemAttribute} aria-label="${uiText('Restore to open tabs', '恢复到打开的标签页')}">${buttonIcon('restore')}</button>
      <button class="chip-action chip-close icon-button" data-action="close-single-tab"${itemAttribute} data-tab-url="${escapeHtmlAttribute(item.url)}" aria-label="${uiText('Remove this dead tab from Pocket', '从「口袋」彻底移除此 dead 标签页')}">${buttonIcon('close')}</button>`;
    for (const group of archivedDomainGroups) {
      group.tabs = group.tabs.map(candidate => candidate.pocketItemId === itemId ? {
        url: item.url,
        title: item.title,
        pocketItemId: item.id,
        pocketOrder: item.order,
        pocketDormant: true,
        pocketState: 'dead',
        ...(normalizeCustomLabel(item.customLabel) ? { customLabel: item.customLabel } : {}),
      } : candidate);
    }
  } else if (Number.isInteger(tab?.id)) {
    chip.classList.remove('is-dormant-pocket');
    chip.dataset.tabId = String(tab.id);
    chip.dataset.dragTabId = String(tab.id);
    delete chip.dataset.dragPocketItemId;
    actions.innerHTML = `<button class="restore-tab-button icon-button" data-action="restore-tab" data-tab-id="${tab.id}"${itemAttribute} aria-label="${uiText('Restore to open tabs', '恢复到打开的标签页')}">${buttonIcon('restore')}</button>
      <button class="chip-action chip-close chip-kill icon-button" data-action="kill-pocket-item" data-tab-id="${tab.id}"${itemAttribute} aria-label="${uiText('Kill this Pocket tab but keep its place', '关闭此「口袋」标签页但保留其位置')}">${buttonIcon('kill')}</button>`;
    for (const group of archivedDomainGroups) {
      group.tabs = group.tabs.map(candidate => candidate.pocketItemId === itemId ? {
        ...tab,
        pocketItemId: item.id,
        pocketOrder: item.order,
        pocketDormant: false,
        pocketState: 'live',
        ...(normalizeCustomLabel(item.customLabel) ? { customLabel: item.customLabel } : {}),
      } : candidate);
    }
  }
  const killButton = document.getElementById('killArchiveButton');
  if (killButton) {
    killButton.disabled = !pocketItems.some(candidate => candidate.state === 'live');
  }
  return true;
}

async function restoreDormantPocketItems(itemIds, { recordHistory = true } = {}) {
  const items = [...new Set(itemIds || [])]
    .map(pocketItemById)
    .filter(item => item?.url);
  if (items.length === 0) return [];

  const restored = [];
  for (const item of items) {
    try {
      const tab = await createDashboardTabWithOrigin('dormant-pocket-restore', {
        url: item.url,
        active: false,
      });
      restored.push({ item, tab });
    } catch {
      // Keep an item that Chrome refuses to reopen so it remains recoverable.
    }
  }
  if (restored.length === 0) return [];

  for (const { item, tab } of restored) {
    if (normalizeCustomLabel(item.customLabel)) {
      await setSessionTabCustomLabel(tab.id, item.customLabel);
    }
  }
  await requestPocketStateMutation('discard-items', [], restored.map(({ item }) => item.id));
  const changes = restored.map(({ tab }) => ({
    id: tab.id,
    url: tab.pendingUrl || tab.url || '',
    wasArchived: true,
  }));
  if (recordHistory) {
    await pushUndoEntry({ type: 'archive-membership', changes });
  }
  return changes;
}

async function discardDormantPocketItems(itemIds) {
  const ids = [...new Set((itemIds || []).filter(itemId => typeof itemId === 'string'))];
  if (ids.length === 0) return 0;
  await requestPocketStateMutation('discard-items', [], ids);
  return ids.length;
}

async function killPocketItems(itemIds, { recordHistory = true } = {}) {
  const ids = [...new Set((itemIds || []).filter(itemId => typeof itemId === 'string'))];
  const snapshots = pocketItems.filter(item => ids.includes(item.id) && item.state === 'live');
  if (snapshots.length === 0) return 0;
  const targetItemIds = new Set(snapshots.map(item => item.id));
  const liveTabIds = Object.entries(pocketLiveItemIds)
    .filter(([, itemId]) => targetItemIds.has(itemId))
    .map(([tabId]) => Number(tabId))
    .filter(Number.isInteger);
  const confettiOrigins = captureDeletionConfettiOrigins(liveTabIds);
  beginDashboardRefreshSuppression();
  pocketLifecycleMutationDepth += 1;
  markTabsForLocalClose(liveTabIds);
  try {
    const result = await requestPocketStateMutation('kill-items', [], snapshots.map(item => item.id));
    if (recordHistory) {
      await pushUndoEntry({ type: 'pocket-lifecycle', transition: 'kill', items: snapshots });
    }
    snapshots.forEach(item => patchPocketItemChip(item.id, 'dead'));
    if (result.killedTabs.length > 0) {
      playCloseSound();
      celebrateDeletedTabs(result.killedTabs, confettiOrigins);
    }
    return result.killedTabs.length;
  } catch (error) {
    unmarkTabsForLocalClose(liveTabIds);
    throw error;
  } finally {
    pocketLifecycleMutationDepth = Math.max(0, pocketLifecycleMutationDepth - 1);
    endDashboardRefreshSuppression();
  }
}

async function revivePocketItems(items) {
  let count = 0;
  for (const snapshot of items || []) {
    const item = pocketItemById(snapshot.id);
    if (!item?.url || item.state === 'live') continue;
    const tab = await createDashboardTabWithOrigin('pocket-revive', { url: item.url, active: false });
    if (normalizeCustomLabel(item.customLabel)) await setSessionTabCustomLabel(tab.id, item.customLabel);
    await requestPocketStateMutation('bind', [tab.id], [item.id]);
    count += 1;
  }
  return count;
}

async function applyPocketLifecycleHistory(entry, reverse) {
  const items = Array.isArray(entry?.items) ? entry.items : [];
  if (entry.transition === 'kill') {
    return reverse
      ? revivePocketItems(items)
      : killPocketItems(items.map(item => item.id), { recordHistory: false });
  }
  if (entry.transition === 'revive') {
    return reverse
      ? killPocketItems(items.map(item => item.id), { recordHistory: false })
      : revivePocketItems(items);
  }
  if (entry.transition === 'remove-dead') {
    if (!reverse) {
      const existingIds = items.filter(item => pocketItemById(item.id)).map(item => item.id);
      await discardDormantPocketItems(existingIds);
      return existingIds.length;
    }
    let restored = 0;
    for (const item of items) {
      await requestPocketStateMutation('restore-dormant', [], [item.id], '', item);
      restored += 1;
    }
    return restored;
  }
  return 0;
}

/**
 * Keeps group ordering stable for the lifetime of this dashboard page.
 * Initial load still uses buildDomainGroups' priority/count sort. Later tab
 * mutations update group contents without letting changed counts reshuffle
 * existing groups. A real page refresh recreates this order from scratch.
 */
function preserveGroupOrder(groups, area) {
  const order = stableGroupDomains[area];
  const known = new Set(order);

  for (const group of groups) {
    if (known.has(group.domain)) continue;

    if (isCaptainGroupKey(group.domain)) {
      const captainIndex = captainIndexForGroupKey(group.domain);
      order.splice(Math.min(captainIndex, order.length), 0, group.domain);
    } else if (group.domain === '__landing-pages__') {
      const lastCaptainIndex = order.reduce((lastIndex, domain, index) =>
        isCaptainGroupKey(domain) ? index : lastIndex, -1);
      order.splice(lastCaptainIndex >= 0 ? lastCaptainIndex + 1 : 0, 0, group.domain);
    } else {
      order.push(group.domain);
    }
    known.add(group.domain);
  }

  const rank = new Map(order.map((domain, index) => [domain, index]));
  return [...groups].sort((a, b) => rank.get(a.domain) - rank.get(b.domain));
}

/**
 * Packs Open groups into balanced vertical columns once per page lifecycle.
 * Their column and reserved height then remain stable while the user removes
 * tabs, preventing neighbouring groups from jumping around. A real refresh
 * recreates this in-memory plan and compacts the columns from current heights.
 */
function renderStableOpenGroupLayout(container, groups) {
  const columnCount = syncDashboardAdaptiveLayout().columnCount;
  const captainGroups = captainConfigs
    .map((_config, index) => ({
      index,
      domain: captainGroupKey(index),
    }))
    .map(captain => ({
      ...captain,
      group: groups.find(group => group.domain === captain.domain),
      cardId: groupCardId({ domain: captain.domain }, 'open'),
    }));
  const presentCaptainGroups = captainGroups
    .filter(captain => captain.group)
    .map((captain, visibleIndex) => ({ ...captain, visibleIndex }));
  container.classList.add('is-stable-column-layout');
  container.style.setProperty('--dashboard-columns', String(columnCount));
  delete container.dataset.layoutColumns;
  delete container.dataset.visibleColumns;
  container.style.removeProperty('--visible-dashboard-columns');
  container.innerHTML = groups.map(group => renderDomainCard(group, 'open')).join('');

  const shellsById = new Map();
  for (const shell of container.querySelectorAll(':scope > .domain-card-shell')) {
    const card = shell.querySelector('.mission-card[data-domain-id]');
    if (!card?.dataset.domainId) continue;
    shellsById.set(card.dataset.domainId, shell);
  }

  const measuredHeights = new Map([...shellsById].map(([id, shell]) => [
    id,
    Math.max(1, Math.ceil(shell.getBoundingClientRect().height)),
  ]));
  const needsFreshLayout = stableOpenGroupLayout.columnCount !== columnCount
    || stableOpenGroupLayout.columns.length !== columnCount;

  if (needsFreshLayout) {
    stableOpenGroupLayout.columnCount = columnCount;
    stableOpenGroupLayout.columns = Array.from({ length: columnCount }, () => []);
    stableOpenGroupLayout.reservedHeights.clear();

    const columnHeights = Array(columnCount).fill(0);
    for (const captain of presentCaptainGroups) {
      const captainColumn = Math.min(captain.visibleIndex, columnCount - 1);
      const height = measuredHeights.get(captain.cardId) || 1;
      stableOpenGroupLayout.columns[captainColumn].push(captain.cardId);
      stableOpenGroupLayout.reservedHeights.set(captain.cardId, height);
      columnHeights[captainColumn] += height + 10;
    }
    for (const group of groups) {
      if (isCaptainGroupKey(group.domain)) continue;
      const id = groupCardId(group, 'open');
      const height = measuredHeights.get(id) || 1;
      const columnIndex = columnHeights.indexOf(Math.min(...columnHeights));
      stableOpenGroupLayout.columns[columnIndex].push(id);
      stableOpenGroupLayout.reservedHeights.set(id, height);
      columnHeights[columnIndex] += height + 10;
    }
  } else {
    // Captain slots are based on the Captains that actually exist right now,
    // not empty configured positions.
    for (const captain of captainGroups) {
      for (const column of stableOpenGroupLayout.columns) {
        const slotIndex = column.indexOf(captain.cardId);
        if (slotIndex >= 0) column.splice(slotIndex, 1);
      }
    }
    for (const captain of [...presentCaptainGroups].reverse()) {
      const captainColumn = Math.min(captain.visibleIndex, columnCount - 1);
      stableOpenGroupLayout.columns[captainColumn].unshift(captain.cardId);
    }

    const assignedIds = new Set(stableOpenGroupLayout.columns.flat());

    // Slots may grow when a group gains content, but never shrink during the
    // current page lifecycle. This is what prevents deletion-time jumping.
    for (const [id, height] of measuredHeights) {
      const reserved = stableOpenGroupLayout.reservedHeights.get(id) || 0;
      if (height > reserved) stableOpenGroupLayout.reservedHeights.set(id, height);
    }

    const columnHeights = stableOpenGroupLayout.columns.map(column =>
      column.reduce((total, id) =>
        total + (stableOpenGroupLayout.reservedHeights.get(id) || 1) + 10, 0));
    for (const group of groups) {
      const id = groupCardId(group, 'open');
      if (assignedIds.has(id)) continue;
      const height = measuredHeights.get(id) || 1;
      const columnIndex = columnHeights.indexOf(Math.min(...columnHeights));
      stableOpenGroupLayout.columns[columnIndex].push(id);
      stableOpenGroupLayout.reservedHeights.set(id, height);
      columnHeights[columnIndex] += height + 10;
      assignedIds.add(id);
    }
  }

  const columns = stableOpenGroupLayout.columns.map((slotIds, columnIndex) => {
    const column = document.createElement('div');
    column.className = 'open-group-layout-column';
    column.dataset.layoutColumn = String(columnIndex);

    for (const id of slotIds) {
      const reservedHeight = stableOpenGroupLayout.reservedHeights.get(id) || 1;
      const shell = shellsById.get(id);
      if (shell) {
        shell.style.minHeight = `${reservedHeight}px`;
        column.append(shell);
        continue;
      }

      // Keep a removed group's slot until refresh. This is deliberately an
      // inert spacer: Undo can put the group back without shifting its peers.
      const placeholder = document.createElement('div');
      placeholder.className = 'open-group-layout-placeholder';
      placeholder.style.height = `${reservedHeight}px`;
      placeholder.setAttribute('aria-hidden', 'true');
      column.append(placeholder);
    }
    return column;
  });

  // Removed groups leave inert placeholders behind so Undo can restore them
  // without reordering neighbouring cards. Placeholder-only columns should
  // not, however, reserve horizontal space: when one or two real columns are
  // left, the existing width rules can then shrink and centre the layout.
  const visibleColumns = columns.filter(column =>
    column.querySelector(':scope > .domain-card-shell'));
  container.dataset.layoutColumns = String(columnCount);
  container.dataset.visibleColumns = String(visibleColumns.length);
  container.style.setProperty('--visible-dashboard-columns', String(visibleColumns.length));
  container.replaceChildren(...visibleColumns);
}

/* ----------------------------------------------------------------
   POCKET RENDERER
   ---------------------------------------------------------------- */

function renderArchiveSection(tabs, groups) {
  const listEl = document.getElementById('archiveTabs');
  const emptyEl = document.getElementById('archiveEmpty');
  const clearButton = document.getElementById('clearArchiveButton');
  const killButton = document.getElementById('killArchiveButton');
  const restoreButton = document.getElementById('restoreArchiveButton');
  if (!listEl || !emptyEl || !clearButton || !killButton || !restoreButton) return;

  const isEmpty = tabs.length === 0;
  document.body.classList.toggle('pocket-empty', isEmpty);
  clearButton.disabled = isEmpty;
  killButton.disabled = !tabs.some(tab => !tab.pocketDormant && Number.isInteger(tab.id));
  restoreButton.disabled = isEmpty;
  // An empty Pocket is represented by the absence of the entire region, not
  // by an empty-state sentence inside an otherwise interactive container.
  emptyEl.hidden = true;
  listEl.innerHTML = groups.map(group => renderDomainCard(group, 'archive')).join('');
}

/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function groupCardId(group, area) {
  return `${area}-domain-` + group.domain.replace(/[^a-z0-9]/g, '-');
}

function groupsForArea(area) {
  return area === 'archive' ? archivedDomainGroups : domainGroups;
}

function renderDomainCard(group, area = 'open') {
  const tabs      = group.tabs || [];
  const isLanding = group.domain === '__landing-pages__';
  const isPocketLoose = area === 'archive' && group.domain === POCKET_LOOSE_GROUP_KEY;
  const isCaptainCard = isCaptainGroupKey(group.domain);
  const groupCaptainConfig = captainConfigForGroupKey(group.domain);
  const groupCaptainTitle = groupCaptainConfig ? captainTitle(groupCaptainConfig) : '';
  const stableId  = groupCardId(group, area);
  const isArchive = area === 'archive';
  const hasCaptainKeepArea = isCaptainCard && !isArchive
    && captainUsesKeepArea(groupCaptainConfig);
  const captainColorClass = groupCaptainConfig
    ? ` captain-color-${groupCaptainConfig.groupColor}`
    : '';
  const displayTabs = hasCaptainKeepArea ? orderedOpenCaptainTabs(tabs) : tabs;

  // Count duplicates by the shared Pocket URL identity.
  const urlCounts = {};
  for (const tab of tabs) {
    if (tab.captainDead || tab.captainPendingDead) continue;
    const identityUrl = getPocketIdentityUrl(tab.url);
    const partition = hasCaptainKeepArea ? duplicatePartitionKey(tab) : 'all';
    const countKey = `${partition}\n${identityUrl}`;
    urlCounts[countKey] = (urlCounts[countKey] || 0) + 1;
  }

  // Deduplicate for display: show each identity once, with a red dot if copies exist.
  function uniqueTabsByUrl(tabList) {
    const seen = new Set();
    return tabList.filter(tab => {
      const identityUrl = tab.captainPendingDead
        ? `dead-pending:${tab.captainPendingDeadId}`
        : getPocketIdentityUrl(tab.url);
      const partition = hasCaptainKeepArea ? duplicatePartitionKey(tab) : 'all';
      const displayIdentity = `${partition}\n${identityUrl}`;
      if (seen.has(displayIdentity)) return false;
      seen.add(displayIdentity);
      return true;
    });
  }

  const renderPageChip = tab => {
    const isDormantPocket = isArchive && tab.pocketDormant === true;
    const isDeadCaptainKeep = !isArchive && tab.captainDead === true;
    const isDeadCaptainPending = !isArchive && tab.captainPendingDead === true;
    const isLiveCaptainKeep = hasCaptainKeepArea && isLiveCaptainKeepTab(tab);
    let titleHostname = group.domain;
    if ((isCaptainCard && groupCaptainConfig?.type === 'task') || isPocketLoose) {
      try { titleHostname = new URL(tab.pendingUrl || tab.url).hostname; } catch {}
    }
    let label = displayTabTitle(tab, titleHostname);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const customLabel = customLabelForTab(tab);
    const displayedLabel = customLabel || label;
    const paper = paperTitleDescriptor(tab);
    const paperTitleAttribute = paper && !customLabel
      ? ` data-auto-paper-title-source="${paper.source}" data-auto-paper-title-id="${escapeHtmlAttribute(paper.id)}"`
      : '';
    const partition = hasCaptainKeepArea ? duplicatePartitionKey(tab) : 'all';
    const count = urlCounts[`${partition}\n${getPocketIdentityUrl(tab.url)}`];
    const dupeIndicator = !isDormantPocket && !isDeadCaptainKeep && !isDeadCaptainPending && count > 1
      ? `<span class="chip-dupe-indicator" aria-hidden="true">${count}X</span>`
      : '';
    const isErrorItem = area === 'open'
      && !isDormantPocket
      && !isDeadCaptainKeep
      && !isDeadCaptainPending
      && isErrorTabCandidate(tab);
    const isCleanupItem = area === 'open'
      && !isDormantPocket
      && !isDeadCaptainKeep
      && !isDeadCaptainPending
      && (count > 1 || isErrorItem);
    const chipClass = `${!isDormantPocket && !isDeadCaptainKeep && !isDeadCaptainPending && count > 1 ? ' chip-has-dupes' : ''}${isCleanupItem ? ' cleanup-item' : ''}${isErrorItem ? ' chip-error' : ''}${!isDormantPocket && !isDeadCaptainPending && isCandidateTab(tab) ? ' candidate' : ''}${isDormantPocket ? ' is-dormant-pocket' : ''}${isDeadCaptainKeep || isDeadCaptainPending ? ' is-dead-captain-keep' : ''}`;
    const safeUrl   = escapeHtmlAttribute(tab.url || '');
    const titleRequestAttribute = !customLabel && (paper || Number.isInteger(tab.id))
      ? ` data-auto-title-request="true"${Number.isInteger(tab.id)
        ? ` data-auto-title-tab-id="${tab.id}" data-auto-title-url="${safeUrl}"`
        : ''}`
      : '';
    const pocketItemAttribute = typeof tab.pocketItemId === 'string'
      ? ` data-pocket-item-id="${escapeHtmlAttribute(tab.pocketItemId)}"`
      : '';
    const captainKeepEntry = isLiveCaptainKeep
      ? captainKeepManifestSnapshot?.tabs.find(item => item.state !== 'dead'
        && (item.tabId === tab.id || (item.captainIndex === captainIndexForTab(tab) && item.url === captainTabUrl(tab))))
      : null;
    const captainKeepId = isDeadCaptainKeep ? tab.captainKeepId : captainKeepEntry?.keepId;
    const captainKeepAttribute = captainKeepId
      ? ` data-captain-keep-id="${escapeHtmlAttribute(captainKeepId)}"`
      : '';
    const captainPendingDeadAttribute = isDeadCaptainPending
      ? ` data-captain-pending-dead-id="${escapeHtmlAttribute(tab.captainPendingDeadId)}"`
      : '';
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = chipFaviconUrl(tab, domain, group.domain);
    const hasDuplicates = !isDormantPocket && !isDeadCaptainKeep && !isDeadCaptainPending && count > 1;
    const chipDragEnabled = true;
    const cardDragAttributes = chipDragEnabled
      ? isDormantPocket
        ? ` draggable="true" data-drag-pocket-item-id="${escapeHtmlAttribute(tab.pocketItemId)}"`
        : isDeadCaptainKeep
          ? ` draggable="true" data-drag-captain-keep-id="${escapeHtmlAttribute(captainKeepId)}"`
          : isDeadCaptainPending
            ? ` draggable="true" data-drag-captain-pending-dead-id="${escapeHtmlAttribute(tab.captainPendingDeadId)}"`
          : ` draggable="true" data-drag-tab-id="${tab.id}"`
      : '';
    const tabIdAttribute = Number.isInteger(tab.id) ? ` data-tab-id="${tab.id}"` : '';
    const trailingAction = isDeadCaptainKeep
      ? `<button class="chip-action chip-close icon-button" data-action="close-dead-captain-keep"${captainKeepAttribute} aria-label="${uiText('Remove this dead tab from Keep', '从保留区彻底移除此失效标签页')}">${buttonIcon('close')}</button>`
      : isDeadCaptainPending
      ? `<button class="chip-action chip-close icon-button" data-action="close-dead-captain-pending"${captainPendingDeadAttribute} aria-label="${uiText('Remove this dead Pending tab', '从待处理区彻底移除此 dead 标签页')}">${buttonIcon('close')}</button>`
      : hasDuplicates
      ? `<button class="chip-action chip-close chip-dedup icon-button" data-action="dedup-tab"${tabIdAttribute} data-tab-url="${safeUrl}" aria-label="${uiText('Remove duplicate copies', '去除重复副本')}">${buttonIcon('minus')}</button>`
      : isArchive && !isDormantPocket
      ? `<button class="chip-action chip-close chip-kill icon-button" data-action="kill-pocket-item"${tabIdAttribute}${pocketItemAttribute} aria-label="${uiText('Kill this Pocket tab but keep its place', '关闭此「口袋」标签页但保留其位置')}">${buttonIcon('kill')}</button>`
      : isLiveCaptainKeep
      ? `<button class="chip-action chip-close chip-kill icon-button" data-action="kill-captain-keep"${tabIdAttribute}${captainKeepAttribute} aria-label="${uiText('Kill this tab but keep its place', '关闭此标签页但保留其位置')}">${buttonIcon('kill')}</button>`
      : `<button class="chip-action chip-close icon-button" data-action="close-single-tab"${tabIdAttribute}${pocketItemAttribute} data-tab-url="${safeUrl}" aria-label="${uiText('Close this tab', '关闭此标签页')}">${buttonIcon('close')}</button>`;
    const chipAction = isDeadCaptainKeep ? 'revive-captain-keep'
      : isDeadCaptainPending ? 'revive-captain-pending-dead' : 'focus-tab';
    return `<div class="page-chip-wrapper${hasDuplicates && !isErrorItem ? ' has-duplicate-stack' : ''}"><div class="page-chip clickable${chipClass}" data-action="${chipAction}"${tabIdAttribute}${pocketItemAttribute}${captainKeepAttribute}${captainPendingDeadAttribute}${paperTitleAttribute}${titleRequestAttribute} data-tab-url="${safeUrl}"${cardDragAttributes}>
      ${dupeIndicator}
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" draggable="false">` : ''}
      <span class="chip-text${chipDragEnabled ? ' tab-drag-handle' : ''}" data-chip-label data-tooltip-url="${safeUrl}">${escapeHtmlAttribute(displayedLabel)}</span>
      <div class="chip-actions">
        ${isDeadCaptainKeep || isDeadCaptainPending
          ? `${readLaterEnabled
            ? `<button class="archive-tab-button icon-button" data-action="archive-dead-captain"${captainKeepAttribute}${captainPendingDeadAttribute} aria-label="${uiText('Put this dead tab in Pocket', '将此 dead 标签页扔进「口袋」')}">${buttonIcon('archive')}</button>`
            : ''}
             ${trailingAction}`
          : isArchive
          ? `<button class="restore-tab-button icon-button" data-action="restore-tab"${tabIdAttribute}${pocketItemAttribute} aria-label="${uiText('Restore to open tabs', '恢复到打开的标签页')}">${buttonIcon('restore')}</button>
             ${trailingAction}`
          : `<button class="archive-tab-button icon-button" data-action="archive-tab" data-tab-id="${tab.id}" aria-label="${uiText('Put in Pocket', '扔进「口袋」')}">${buttonIcon('archive')}</button>
             ${trailingAction}`}
      </div>
    </div></div>`;
  };

  const renderTabList = tabList => {
    const uniqueTabs = uniqueTabsByUrl(tabList);
    return uniqueTabs.map(renderPageChip).join('');
  };

  let pagesHtml;
  let pendingCaptainTabs = [];
  if (hasCaptainKeepArea) {
    const retainedCaptainTabs = displayTabs.filter(tab => tab.captainDead || isLiveCaptainKeepTab(tab));
    pendingCaptainTabs = displayTabs.filter(tab => {
      if (tab.captainDead) return false;
      return !isLiveCaptainKeepTab(tab);
    });
    const pendingDisabled = pendingCaptainTabs.length === 0 ? ' disabled' : '';
    pagesHtml = `
      <div class="captain-subgroup captain-subgroup-retained${retainedCaptainTabs.length === 0 ? ' is-empty' : ''}" aria-label="${escapeHtmlAttribute(uiText(`${groupCaptainTitle} Keep area`, `${groupCaptainTitle} 保留区`))}">
        <div class="mission-pages">${renderTabList(retainedCaptainTabs)}</div>
      </div>
      <div class="captain-subgroup-divider">
        <span class="captain-subgroup-divider-dot" aria-hidden="true"></span>
        <span class="captain-subgroup-divider-line" aria-hidden="true"></span>
        <div class="group-card-actions captain-subgroup-actions">
          <button class="group-card-action group-archive-button captain-pending-archive-button icon-button" data-action="archive-captain-pending" data-captain-group="${group.domain}" aria-label="${uiText('Put every pending Captain tab in Pocket', '将待处理区全部扔进「口袋」')}"${pendingDisabled}>${buttonIcon('archive')}</button>
          <button class="group-card-action group-close-button captain-pending-delete-button icon-button" data-action="delete-captain-pending" data-captain-group="${group.domain}" aria-label="${uiText('Delete every pending Captain tab', '删除待处理区全部标签页')}"${pendingDisabled}>${buttonIcon('close')}</button>
        </div>
      </div>
      <div class="captain-subgroup captain-subgroup-pending${pendingCaptainTabs.length === 0 ? ' is-empty' : ''}" aria-label="${escapeHtmlAttribute(uiText(`${groupCaptainTitle} Pending area`, `${groupCaptainTitle} 待处理区`))}">
        <div class="mission-pages">${renderTabList(pendingCaptainTabs)}</div>
      </div>
      <span class="captain-subgroup-drop-indicator" aria-hidden="true"></span>`;
  } else {
    pagesHtml = `<div class="mission-pages">${renderTabList(displayTabs)}</div>`;
  }

  if (isPocketLoose) {
    return `
      <div class="domain-card-shell pocket-loose-shell">
        <div class="mission-card domain-card pocket-loose-card" data-domain-id="${stableId}" data-group-key="${group.domain}" data-area="${area}">
          <div class="mission-content">${pagesHtml}</div>
        </div>
      </div>`;
  }

  const groupArchiveButton = !isArchive && !hasCaptainKeepArea
    ? `<button class="group-card-action group-archive-button icon-button" data-action="archive-domain-tabs" data-area="${area}" data-domain-id="${stableId}" aria-label="${uiText('Put this group in Pocket', '将此组扔进「口袋」')}">${buttonIcon('archive')}</button>`
    : '';
  const groupRestoreButton = isArchive
    ? `<button class="group-card-action group-restore-button icon-button" data-action="restore-domain-tabs" data-area="${area}" data-domain-id="${stableId}" aria-label="${uiText('Restore all tabs in this group', '恢复此组全部标签页')}">${buttonIcon('restore')}</button>`
    : '';
  const groupCloseButton = `<button class="group-card-action group-close-button icon-button" data-action="close-domain-tabs" data-area="${area}" data-domain-id="${stableId}" aria-label="${uiText('Close all tabs in this group', '关闭此组全部标签页')}">${buttonIcon('close')}</button>`;
  const groupControls = `<div class="group-card-actions">
    ${isArchive ? groupRestoreButton : groupArchiveButton}
    ${groupCloseButton}
  </div>`;
  const plainGroupTitle = isLanding
    ? uiText('Homepages', '主页')
    : (group.label || friendlyDomain(group.domain));
  const groupIconDomain = groupCaptainConfig?.type === 'task'
    ? domainGroupKey(groupCaptainConfig.domain)
    : group.domain;
  const groupIconName = domainGroupIconName(groupIconDomain);
  const customGroupIconClass = groupIconName
    ? ` has-custom-domain-icon domain-group-icon--${groupIconName}`
    : '';
  const groupIcon = groupIconName
    ? `<span class="domain-group-icon${customGroupIconClass}" aria-hidden="true"></span>`
    : '<span class="domain-group-icon" aria-hidden="true"></span>';
  const captainIconName = groupCaptainConfig?.icon || 'circle';
  const captainIcon = `<span class="captain-group-icon task-group-icon--${captainIconName}" aria-hidden="true"></span>`;
  const groupTitle = isCaptainCard
    ? `<span class="captain-group-title">${captainIcon}<span>${escapeHtmlAttribute(groupCaptainTitle)}</span></span>`
    : `<span class="domain-group-title">${groupIcon}<span>${escapeHtmlAttribute(plainGroupTitle)}</span></span>`;
  // Ordinary groups and flat Captains remain draggable as a whole instead of
  // falling through to marquee selection.
  const groupDragAttributes = (!isCaptainCard || isArchive || !hasCaptainKeepArea
    || groupCaptainConfig?.type === 'task')
    ? ` draggable="true" data-drag-domain-id="${stableId}" data-drag-area="${area}"`
    : '';

  return `
    <div class="domain-card-shell">
      <div class="mission-card domain-card${isCaptainCard ? ' captain-group-card' : ''}${captainColorClass}${isArchive && tabs.length > 0 && tabs.every(tab => tab.pocketDormant) ? ' is-dormant-pocket-card' : ''}" data-domain-id="${stableId}" data-group-key="${group.domain}" data-area="${area}">
        <div class="mission-content">
          <div class="mission-top"${groupDragAttributes}>
            <span class="mission-name">${groupTitle}</span>
            ${groupControls}
          </div>
          ${pagesHtml}
        </div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

function commitDashboardView(activeTabs, liveArchivedTabs) {
  // Duplicate identity for Captain tabs includes their Keep/Pending partition.
  updateCandidateBatch(activeTabs);
  const pocketDisplayTabs = buildPocketDisplayTabs(liveArchivedTabs);
  archivedDomainGroups = preserveGroupOrder(buildPocketGroups(pocketDisplayTabs), 'archive');
  domainGroups = preserveGroupOrder(buildDomainGroups([
    ...activeTabs,
    ...deadCaptainKeepTabs(),
    ...deadCaptainPendingTabs(),
  ]), 'open');
  if (captainKeepReviveTrace) {
    const trackedTabId = captainKeepReviveTrace.createdTabId;
    const trackedTab = activeTabs.find(tab => tab.id === trackedTabId) || null;
    traceCaptainKeepRevive('render-classification', {
      trackedTabId,
      trackedTabPresent: Boolean(trackedTab),
      isLiveKeep: trackedTab ? isLiveCaptainKeepTab(trackedTab) : false,
      inRetainedIds: captainRetainedTabIds.has(trackedTabId),
      duplicatePartition: trackedTab ? duplicatePartitionKey(trackedTab) : null,
      manifestEntry: captainKeepManifestSnapshot?.tabs.find(item =>
        item.keepId === captainKeepReviveTrace.keepId) || null,
    });
  }
  renderArchiveSection(pocketDisplayTabs, archivedDomainGroups);
  syncDashboardAdaptiveLayout();

  const openTabsSection = document.getElementById('openTabsSection');
  const openTabsMissionsEl = document.getElementById('openTabsMissions');
  if (!openTabsSection || !openTabsMissionsEl) return;
  // Height-based column packing must run after the section participates in
  // layout; measuring while its initial inline display:none is active yields 0.
  openTabsSection.classList.add('is-rendered');

  if (domainGroups.length > 0) {
    renderStableOpenGroupLayout(openTabsMissionsEl, domainGroups);
  } else {
    openTabsMissionsEl.classList.remove('is-stable-column-layout');
    openTabsMissionsEl.replaceChildren();
  }
  hydrateRenderedPaperTitles();
}

/** Reclassifies the current in-memory tab snapshot after a successful mutation. */
function commitCurrentDashboardState() {
  const realTabs = getRealTabs();
  const liveArchivedTabs = realTabs.filter(tab => archivedTabIds.has(tab.id));
  const activeTabs = realTabs.filter(tab => !archivedTabIds.has(tab.id));
  commitDashboardView(activeTabs, liveArchivedTabs);
  syncCandidateHeaderPrompt();
  syncArchiveLooseTabsHeaderPrompt();
  syncKeyboardPromptProgression();
}

async function readCaptainStateFallback() {
  try {
    const [local, session] = await Promise.all([
      chrome.storage.local.get([
        CAPTAIN_RETAINED_TAB_IDS_KEY,
        CAPTAIN_TAB_ORDER_KEY,
        CAPTAIN_KEEP_MANIFEST_KEY,
      ]),
      chrome.storage.session.get(CAPTAIN_PENDING_DEAD_ITEMS_KEY),
    ]);
    captainRetainedTabIds = new Set(normalizeTabIds(local[CAPTAIN_RETAINED_TAB_IDS_KEY]));
    captainTabOrder = normalizeTabIds(local[CAPTAIN_TAB_ORDER_KEY]);
    captainKeepManifestSnapshot = normalizeCaptainKeepManifest(local[CAPTAIN_KEEP_MANIFEST_KEY]);
    captainPendingDeadItems = normalizeCaptainPendingDeadItems(
      session[CAPTAIN_PENDING_DEAD_ITEMS_KEY],
    );
  } catch {
    // Existing in-memory values still provide a usable first paint.
  }
}

/** Paints from Chrome tabs and cached state without waiting for worker writes. */
async function renderCachedDashboard() {
  await fetchOpenTabs();
  const realTabs = getRealTabs();
  const [liveArchivedTabIds] = await Promise.all([
    readPocketStateFallback(realTabs),
    readCaptainStateFallback(),
    refreshDetectedErrorTabs(realTabs),
  ]);
  const liveArchivedTabs = realTabs.filter(tab => liveArchivedTabIds.has(tab.id));
  const activeTabs = realTabs.filter(tab => !liveArchivedTabIds.has(tab.id));
  commitDashboardView(activeTabs, liveArchivedTabs);
  syncCandidateHeaderPrompt();
  syncArchiveLooseTabsHeaderPrompt();
  syncKeyboardPromptProgression();
}

/** Fetches live tabs, separates Pocket membership, and renders both areas. */
async function renderStaticDashboard() {
  await fetchOpenTabs();
  try {
    await migrateLegacyPocketMembership(getRealTabs());
  } catch (error) {
    console.warn('[tab-out] Pocket migration skipped during render:', error);
  }
  await fetchOpenTabs();
  const realTabs = getRealTabs();
  await refreshDetectedErrorTabs(realTabs);
  let liveArchivedTabIds;
  try {
    liveArchivedTabIds = await syncArchivedTabIds(realTabs);
  } catch (error) {
    console.warn('[tab-out] Pocket cache sync skipped during render:', error);
    liveArchivedTabIds = await getPocketTabIds(realTabs);
  }
  const liveArchivedTabs = realTabs.filter(tab => liveArchivedTabIds.has(tab.id));
  const activeTabs = realTabs.filter(tab => !liveArchivedTabIds.has(tab.id));
  for (const tab of activeTabs) {
    const matchedPocketItem = dormantPocketItemMatchingUrl(tab.url, liveArchivedTabIds);
    if (!matchedPocketItem) continue;
    const currentBoundTabId = pocketBoundTabId(matchedPocketItem.id);
    tracePocketBind('live-match', {
      tabId: tab.id,
      url: tab.url,
      liveCustomLabel: customLabelForLiveTabBeforePocket(tab) || null,
      matchedPocketItemId: matchedPocketItem.id,
      pocketItemCustomLabel: normalizeCustomLabel(matchedPocketItem.customLabel) || null,
      pocketItemIsBound: Number.isInteger(currentBoundTabId),
      currentBoundTabId,
    });
  }
  try {
    await syncCaptainSubgroupState(activeTabs);
  } catch (error) {
    // Captain persistence is auxiliary state. A storage/session migration
    // failure must never prevent ordinary browser tabs from rendering.
    console.warn('[tab-out] Captain Keep state sync skipped during render:', error);
    const liveCaptainIds = new Set(activeTabs.filter(captainKeepAreaEnabledForTab).map(tab => tab.id));
    captainRetainedTabIds = new Set([...captainRetainedTabIds].filter(id => liveCaptainIds.has(id)));
    captainTabOrder = captainTabOrder.filter(id => liveCaptainIds.has(id));
  }
  commitDashboardView(activeTabs, liveArchivedTabs);
}

async function renderDashboardPass() {
  const previousCandidateMode = candidateBatchMode;
  await renderStaticDashboard();
  const startedNewCandidateRound = Boolean(candidateBatchMode
    && candidateBatchMode !== previousCandidateMode);
  syncCandidateHeaderPrompt(startedNewCandidateRound);
  syncArchiveLooseTabsHeaderPrompt();
  syncKeyboardPromptProgression();
}

let dashboardRenderInFlight = null;
let dashboardRenderRequested = false;

/** Prevents concurrent full DOM rebuilds and coalesces callers into one pass. */
function renderDashboard() {
  cancelScheduledDashboardRefresh();
  if (dashboardRenderInFlight) {
    dashboardRenderRequested = true;
    return dashboardRenderInFlight;
  }

  dashboardRenderInFlight = (async () => {
    do {
      dashboardRenderRequested = false;
      await renderDashboardPass();
    } while (dashboardRenderRequested);
  })().finally(() => {
    dashboardRenderInFlight = null;
  });
  return dashboardRenderInFlight;
}

/* ----------------------------------------------------------------
   LONG-PRESS "OTHER" ACTIONS
   ---------------------------------------------------------------- */

const LONG_PRESS_DELAY = 3000;
const LONG_PRESS_INTENT_DELAY = 250;
const suppressedActionClicks = new Set();
let longPressTimer = null;
let longPressIntentTimer = null;
let longPressGesture = null;
let pendingOtherAction = null;
let longPressClickGuard = null;
let otherActionSourceCard = null;
let longPressPrompt = null;
let longPressPromptFrame = null;

function removeLongPressPrompt() {
  if (longPressPromptFrame !== null) cancelAnimationFrame(longPressPromptFrame);
  longPressPromptFrame = null;
  longPressPrompt?.element.remove();
  longPressPrompt = null;
}

function positionLongPressPrompt(prompt, button) {
  if (!prompt.isConnected || !button.isConnected) return;

  const buttonRect = button.getBoundingClientRect();
  const promptRect = prompt.getBoundingClientRect();
  const horizontalPadding = 8;
  const left = Math.min(
    Math.max(horizontalPadding, buttonRect.left + (buttonRect.width - promptRect.width) / 2),
    window.innerWidth - promptRect.width - horizontalPadding,
  );
  const above = buttonRect.top - promptRect.height - 8;
  const top = above >= horizontalPadding ? above : buttonRect.bottom + 8;

  prompt.style.left = `${left}px`;
  prompt.style.top = `${top}px`;
}

function showLongPressPrompt(button, descriptor, startedAt) {
  removeLongPressPrompt();

  const prompt = document.createElement('div');
  const intent = descriptor.kind === 'delete'
    ? uiText('Delete all others? Keep holding.', '删除所有其他？保持手指发力。')
    : uiText('Put all others in Pocket? Keep holding.', '把所有其他扔进「口袋」？保持手指发力。');
  prompt.className = 'long-press-prompt';
  prompt.setAttribute('role', 'status');
  prompt.setAttribute('aria-live', 'polite');
  prompt.innerHTML = `
    <span class="long-press-prompt__timer" aria-hidden="true"></span>
    <span class="long-press-prompt__text">${intent}</span>`;
  document.body.append(prompt);

  const timer = prompt.querySelector('.long-press-prompt__timer');
  longPressPrompt = { element: prompt, button, startedAt, timer };
  positionLongPressPrompt(prompt, button);

  const updateTimer = () => {
    if (!longPressPrompt || longPressPrompt.element !== prompt) return;
    const progress = Math.min(1, (performance.now() - startedAt) / LONG_PRESS_DELAY);
    timer?.style.setProperty('--long-press-progress', `${progress * 360}deg`);
    if (progress < 1) longPressPromptFrame = requestAnimationFrame(updateTimer);
  };
  longPressPromptFrame = requestAnimationFrame(updateTimer);
}

function otherActionDescriptor(button) {
  const action = button?.dataset?.action;
  if (action === 'close-domain-tabs' && button.dataset.area === 'open') {
    return { kind: 'delete', scope: 'groups', domainId: button.dataset.domainId };
  }
  if (action === 'archive-domain-tabs' && button.dataset.area === 'open') {
    return { kind: 'archive', scope: 'groups', domainId: button.dataset.domainId };
  }

  const card = button?.closest('.mission-card');
  if (!card || card.dataset.area !== 'open') return null;
  const tabId = Number(button.dataset.tabId);
  if (!Number.isInteger(tabId)) return null;

  if (action === 'close-single-tab') {
    return { kind: 'delete', scope: 'tabs', domainId: card.dataset.domainId, tabId };
  }
  if (action === 'archive-tab') {
    return { kind: 'archive', scope: 'tabs', domainId: card.dataset.domainId, tabId };
  }
  return null;
}

function otherActionTabIds(descriptor) {
  const groups = groupsForArea('open');
  if (descriptor.scope === 'groups') {
    return groups
      .filter(group => groupCardId(group, 'open') !== descriptor.domainId)
      .flatMap(group => group.tabs.map(tab => tab.id));
  }

  const group = groups.find(item => groupCardId(item, 'open') === descriptor.domainId);
  return group ? group.tabs.filter(tab => tab.id !== descriptor.tabId).map(tab => tab.id) : [];
}

function clearOtherActionTargetFeedback() {
  document.querySelectorAll('.page-chip.is-other-action-target').forEach(card => {
    card.classList.remove(
      'is-other-action-target',
      'is-other-action-delete-target',
      'is-other-action-archive-target'
    );
  });
}

function showOtherActionTargetFeedback(descriptor) {
  clearOtherActionTargetFeedback();
  const targetIds = new Set(otherActionTabIds(descriptor));
  const actionClass = descriptor.kind === 'delete'
    ? 'is-other-action-delete-target'
    : 'is-other-action-archive-target';

  document.querySelectorAll('.mission-card[data-area="open"] .page-chip[data-tab-id]').forEach(card => {
    if (!targetIds.has(Number(card.dataset.tabId))) return;
    card.classList.add('is-other-action-target', actionClass);
  });
}

function clearOtherActionFeedback() {
  clearOtherActionTargetFeedback();
  otherActionSourceCard?.classList.remove('is-other-action-source');
  otherActionSourceCard = null;
  pendingOtherAction = null;
}

function beginOtherActionFeedback(button, descriptor) {
  const tabIds = otherActionTabIds(descriptor);
  if (tabIds.length === 0) return false;

  pendingOtherAction = descriptor;
  otherActionSourceCard = button.closest('.page-chip');
  otherActionSourceCard?.classList.add('is-other-action-source');
  showOtherActionTargetFeedback(descriptor);
  return true;
}

async function completeOtherAction() {
  const descriptor = pendingOtherAction;
  if (!descriptor) return;
  const tabIds = otherActionTabIds(descriptor);
  clearOtherActionFeedback();
  if (tabIds.length === 0) return;

  if (descriptor.kind === 'delete') {
    const closedTabs = await closeTabsWithUndo(tabIds);
    if (closedTabs.length === 0) return;
    playCloseSound();
    scheduleDashboardRefresh();
    showToast(uiText(
      `Deleted ${closedTabs.length} other ${descriptor.scope === 'groups' ? 'group tabs' : 'tabs'}`,
      `已删除其他 ${closedTabs.length} 个标签页`,
    ), 2500, 'destructive');
    return;
  }

  const changes = await changeArchiveMembershipWithUndo(tabIds, true);
  if (changes.length === 0) return;
  scheduleDashboardRefresh();
  showToast(uiText(
    `Put ${changes.length} other ${descriptor.scope === 'groups' ? 'group tabs' : 'tabs'} in Pocket`,
    `已将其他 ${changes.length} 个扔进「口袋」`,
  ));
}

let isProcessingCandidateBatch = false;

async function closeCurrentCandidateBatch() {
  if (isProcessingCandidateBatch) return;
  isProcessingCandidateBatch = true;

  try {
    await fetchOpenTabs();
    const realTabs = getRealTabs();
    const activeTabs = realTabs.filter(tab => !archivedTabIds.has(tab.id));
    updateCandidateBatch(activeTabs);
    const processedMode = candidateBatchMode;
    if (!processedMode) return;

    let tabIds;
    if (processedMode === 'duplicate') {
      tabIds = await duplicateTabIds(activeTabs, true);
    } else if (processedMode === 'acm-paper') {
      tabIds = acmPaperPageTabIdsWithOpenPdf(activeTabs);
    } else {
      tabIds = [...candidateTabIds];
    }
    if (tabIds.length === 0) return;

    const closedTabs = await closeTabsWithUndo(tabIds);
    if (closedTabs.length === 0) return;

    playCloseSound();
    scheduleDashboardRefresh();

    showToast(uiText(`Deleted ${closedTabs.length} tab${closedTabs.length === 1 ? '' : 's'}`, `已删除 ${closedTabs.length} 个标签页`), 2500, 'destructive');
  } finally {
    isProcessingCandidateBatch = false;
  }
}

async function archiveAllOpenTabs() {
  await fetchOpenTabs();
  const cachedArchiveTabIds = new Set(archivedTabIds);
  const tabIds = openTabs
    .filter(tab => isManageableTab(tab)
      && !captainKeepAreaEnabledForTab(tab)
      && !cachedArchiveTabIds.has(tab.id))
    .map(tab => tab.id);
  if (tabIds.length === 0) return;

  const changes = await changeArchiveMembershipWithUndo(tabIds, true);
  if (changes.length === 0) return;

  scheduleDashboardRefresh();
  showToast(uiText(
    `Pocketed ${changes.length} tab${changes.length === 1 ? '' : 's'} outside Keep areas`,
    `已将保留区外的 ${changes.length} 个扔进「口袋」`,
  ));
}

async function deleteAllOpenLooseTabs() {
  await fetchOpenTabs();
  const tabIds = openTabs
    .filter(tab => {
      if (!isManageableTab(tab)) return false;
      const isInPocket = archivedTabIds.has(tab.id);
      if (isInPocket) return false;
      return !captainKeepAreaEnabledForTab(tab);
    })
    .map(tab => tab.id);
  if (tabIds.length === 0) return;

  const closedTabs = await closeTabsWithUndo(tabIds);
  if (closedTabs.length === 0) return;

  playCloseSound();
  scheduleDashboardRefresh();
  showToast(uiText(
    `Deleted ${closedTabs.length} tab${closedTabs.length === 1 ? '' : 's'} outside Keep areas`,
    `已删除保留区外的 ${closedTabs.length} 个`,
  ), 2500, 'destructive');
}

document.addEventListener(TAB_OUT_EVENTS.POCKET_VISIBILITY_CHANGE, async event => {
  const visible = event.detail?.visible === true;
  if (pocketVisible === visible) return;
  const selectedTabIds = normalizeTabIds([...document.querySelectorAll(
    '.page-chip.is-marquee-selected[data-tab-id]',
  )].map(chip => Number(chip.dataset.tabId)));
  try {
    await setCoinPocketVisibility(visible);
    resetStableOpenGroupLayout();
    await renderDashboard();
    restoreMarqueeSelection(selectedTabIds);
  } catch (error) {
    console.warn('[tab-out] Could not apply the coin Pocket visibility:', error);
  }
});

document.addEventListener(TAB_OUT_EVENTS.CANDIDATE_ACTION, () => {
  closeCurrentCandidateBatch().catch(error => {
    console.warn('[tab-out] Could not close the current candidate batch:', error);
  });
});

/* ----------------------------------------------------------------
   MARQUEE TAB SELECTION

   Drag from empty dashboard space to select every intersecting tab chip.
   The rectangle is direction-agnostic, so all four diagonal directions work.
   ---------------------------------------------------------------- */

let marqueeSelection = null;
let marqueeElement = null;

function restoreMarqueeSelection(tabIds) {
  const selectedIds = new Set(normalizeTabIds(tabIds));
  if (selectedIds.size === 0) return;
  document.querySelectorAll('.page-chip[data-tab-id]').forEach(chip => {
    if (selectedIds.has(Number(chip.dataset.tabId))) {
      chip.classList.add('is-marquee-selected');
    }
  });
  syncKeyboardPromptProgression();
}

function clearMarqueeSelection() {
  document.querySelectorAll('.page-chip.is-marquee-selected').forEach(chip => {
    chip.classList.remove(
      'is-marquee-selected',
      'is-marquee-archive-preview',
      'is-marquee-delete-preview',
    );
  });
  syncKeyboardPromptProgression();
}

function clearMarqueeActionPreview() {
  document.querySelectorAll('.page-chip.is-marquee-archive-preview, .page-chip.is-marquee-delete-preview')
    .forEach(chip => chip.classList.remove('is-marquee-archive-preview', 'is-marquee-delete-preview'));
}

function tabIdsRepresentedByChip(chip) {
  const representativeId = Number(chip?.dataset.tabId);
  if (!Number.isInteger(representativeId)) return [];
  if (!chip.classList.contains('chip-has-dupes')) return [representativeId];

  const card = chip.closest('.mission-card[data-area][data-group-key]');
  const area = card?.dataset.area;
  const group = groupsForArea(area).find(candidate => candidate.domain === card?.dataset.groupKey);
  const representative = group?.tabs?.find(tab => tab.id === representativeId);
  if (!representative) return [representativeId];

  const identityUrl = getPocketIdentityUrl(representative.pendingUrl || representative.url || '');
  const hasKeepArea = area === 'open' && isCaptainGroupKey(group.domain)
    && captainUsesKeepArea(captainConfigForGroupKey(group.domain));
  const partition = hasKeepArea ? duplicatePartitionKey(representative) : 'all';
  return normalizeTabIds(group.tabs.filter(tab => {
    if (!Number.isInteger(tab?.id) || tab.captainDead || tab.captainPendingDead) return false;
    const tabIdentityUrl = getPocketIdentityUrl(tab.pendingUrl || tab.url || '');
    const tabPartition = hasKeepArea ? duplicatePartitionKey(tab) : 'all';
    return tabIdentityUrl === identityUrl && tabPartition === partition;
  }).map(tab => tab.id));
}

function selectedMarqueeTabIds(selector = '.page-chip.is-marquee-selected[data-tab-id]') {
  return normalizeTabIds([...document.querySelectorAll(selector)]
    .flatMap(tabIdsRepresentedByChip));
}

function marqueeSelectedTabIdsForChip(sourceChip) {
  if (!sourceChip?.classList.contains('is-marquee-selected')) return [];
  const area = sourceChip.closest('.mission-card')?.dataset.area;
  if (!area) return [];
  return selectedMarqueeTabIds(
    `.mission-card[data-area="${area}"] .page-chip.is-marquee-selected[data-tab-id]`,
  );
}

function selectedTabIdsForChipAction(actionEl) {
  const sourceChip = actionEl.closest('.page-chip[data-tab-id]');
  const sourceId = Number(sourceChip?.dataset.tabId || actionEl.dataset.tabId);
  if (!sourceChip?.classList.contains('is-marquee-selected')) {
    return Number.isInteger(sourceId) ? [sourceId] : [];
  }
  return marqueeSelectedTabIdsForChip(sourceChip);
}

function duplicateRepresentativeIdsForChipAction(actionEl) {
  const sourceChip = actionEl.closest('.page-chip[data-tab-id]');
  if (!sourceChip) return [];
  if (!sourceChip.classList.contains('is-marquee-selected')) {
    const sourceId = Number(sourceChip.dataset.tabId);
    return sourceChip.classList.contains('chip-has-dupes') && Number.isInteger(sourceId)
      ? [sourceId]
      : [];
  }
  const area = sourceChip.closest('.mission-card')?.dataset.area;
  if (!area) return [];
  return normalizeTabIds([...document.querySelectorAll(
    `.mission-card[data-area="${area}"] .page-chip.is-marquee-selected.chip-has-dupes[data-tab-id]`,
  )].map(chip => Number(chip.dataset.tabId)));
}

function marqueeRect(selection, clientX, clientY) {
  const left = Math.min(selection.startX, clientX);
  const top = Math.min(selection.startY, clientY);
  return {
    left,
    top,
    right: Math.max(selection.startX, clientX),
    bottom: Math.max(selection.startY, clientY),
    width: Math.abs(clientX - selection.startX),
    height: Math.abs(clientY - selection.startY),
  };
}

function rectsIntersect(first, second) {
  return first.left < second.right && first.right > second.left
    && first.top < second.bottom && first.bottom > second.top;
}

function removeMarqueeElement() {
  marqueeElement?.remove();
  marqueeElement = null;
}

function cancelMarqueeSelection(clearSelection = false) {
  const selection = marqueeSelection;
  marqueeSelection = null;
  removeMarqueeElement();
  document.body.classList.remove('is-marquee-selecting');
  if (selection?.captureTarget?.hasPointerCapture?.(selection.pointerId)) {
    selection.captureTarget.releasePointerCapture(selection.pointerId);
  }
  if (clearSelection) clearMarqueeSelection();
}

function marqueeZoneAtPoint(clientX, clientY) {
  const openZone = document.getElementById('openTabsSection');
  const archiveZone = document.getElementById('archiveSection');
  if (!openZone) return null;

  // The visible dashboard background extends beyond the centered container.
  // Pocket rails are separated from the dashboard on the X axis.
  if (archiveZone && getComputedStyle(archiveZone).display !== 'none') {
    const rect = archiveZone.getBoundingClientRect();
    const insidePocketAxis = pocketPosition === 'left'
      ? clientX <= rect.right
      : clientX >= rect.left;
    if (insidePocketAxis) return archiveZone;
  }
  return openZone;
}

document.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.isPrimary === false) return;
  // Hovering a chip means its existing focus/action/drag interaction wins.
  // Any actual dashboard background means marquee selection, including the
  // broad page space outside the centered content container.
  if (event.target.closest('.page-chip, [draggable="true"], button, .tabout-coin, .ambience-mixer')) return;
  if (event.target.closest('.dashboard-top, .toast, .long-press-prompt')) return;
  const activeRenameInput = document.querySelector('.chip-rename-input');
  if (activeRenameInput) {
    activeRenameInput.blur();
    return;
  }
  const zone = event.target.closest('#openTabsSection, #archiveSection')
    || marqueeZoneAtPoint(event.clientX, event.clientY);
  if (!zone) return;
  const scope = zone.id === 'archiveSection'
    ? document.getElementById('archiveTabs')
    : document.getElementById('openTabsMissions');
  if (!scope) return;

  event.preventDefault();
  clearMarqueeSelection();
  removeMarqueeElement();
  // Capture at the document root so crossing a group frame, the centered
  // container, or the initial zone's visual bounds never terminates selection.
  const captureTarget = document.documentElement;
  captureTarget.setPointerCapture?.(event.pointerId);
  marqueeSelection = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scope,
    captureTarget,
    active: false,
  };
  document.body.classList.add('is-marquee-selecting');
});

document.addEventListener('pointermove', event => {
  const selection = marqueeSelection;
  if (!selection || selection.pointerId !== event.pointerId) return;
  if ((event.buttons & 1) !== 1) {
    cancelMarqueeSelection();
    return;
  }
  const rect = marqueeRect(selection, event.clientX, event.clientY);
  if (!selection.active && Math.hypot(rect.width, rect.height) < 5) return;
  if (!selection.active) {
    selection.active = true;
    marqueeElement = document.createElement('div');
    marqueeElement.className = 'tab-marquee-selection';
    document.body.append(marqueeElement);
  }
  event.preventDefault();
  marqueeElement.style.left = `${rect.left}px`;
  marqueeElement.style.top = `${rect.top}px`;
  marqueeElement.style.width = `${rect.width}px`;
  marqueeElement.style.height = `${rect.height}px`;

  selection.scope.querySelectorAll('.page-chip[data-tab-id]').forEach(chip => {
    chip.classList.toggle('is-marquee-selected', rectsIntersect(rect, chip.getBoundingClientRect()));
  });
  syncKeyboardPromptProgression();
});

function finishMarqueeSelection(event) {
  if (!marqueeSelection || marqueeSelection.pointerId !== event.pointerId) return;
  cancelMarqueeSelection();
}

document.addEventListener('pointerup', finishMarqueeSelection);
document.addEventListener('pointercancel', event => {
  if (!marqueeSelection || marqueeSelection.pointerId !== event.pointerId) return;
  cancelMarqueeSelection(true);
});

window.addEventListener('blur', () => cancelMarqueeSelection(true));

document.addEventListener('pointerover', event => {
  const button = event.target.closest('[data-action]');
  const sourceChip = button?.closest('.page-chip.is-marquee-selected');
  if (!button || !sourceChip) return;
  const action = button.dataset.action;
  const previewClass = action === 'close-single-tab'
    ? 'is-marquee-delete-preview'
    : action === 'archive-tab' || action === 'restore-tab'
      ? 'is-marquee-archive-preview'
      : '';
  if (!previewClass) return;
  clearMarqueeActionPreview();
  const area = sourceChip.closest('.mission-card')?.dataset.area;
  document.querySelectorAll(`.mission-card[data-area="${area}"] .page-chip.is-marquee-selected`)
    .forEach(chip => chip.classList.add(previewClass));
});

document.addEventListener('pointerout', event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.contains(event.relatedTarget)) return;
  if (button.closest('.page-chip.is-marquee-selected')) clearMarqueeActionPreview();
});

const CHIP_SINGLE_CLICK_DELAY_MS = 360;
const pendingChipActivations = new Map();
const suppressedChipActivations = new WeakSet();

function traceTabLabel(stage, chip, detail = {}) {
  console.info(`[tab-out tab-label] ${stage}`, {
    tabId: Number.isInteger(Number(chip?.dataset?.tabId))
      ? Number(chip.dataset.tabId) : null,
    pocketItemId: chip?.dataset?.pocketItemId || null,
    ...detail,
  });
}

function cancelPendingChipActivation(chip = null) {
  if (chip) {
    const pending = pendingChipActivations.get(chip);
    if (!pending) return;
    clearTimeout(pending);
    pendingChipActivations.delete(chip);
    return;
  }
  for (const pending of pendingChipActivations.values()) clearTimeout(pending);
  pendingChipActivations.clear();
}

async function activateTabChip(chip) {
  if (!chip?.isConnected) return;
  const tabId = Number(chip.dataset.tabId);
  const tabUrl = chip.dataset.tabUrl;
  const pocketItemId = chip.dataset.pocketItemId;
  if (Number.isInteger(tabId)) {
    await focusTabById(tabId);
  } else if (pocketItemId) {
    try {
      const pocketItem = pocketItemById(pocketItemId);
      const tab = await openDormantPocketItem(pocketItemId);
      if (pocketItem) {
        await pushUndoEntry({ type: 'pocket-lifecycle', transition: 'revive', items: [pocketItem] });
      }
      if (!patchPocketItemChip(pocketItemId, 'live', tab)) await renderDashboard();
    } catch (error) {
      console.warn('[tab-out] Could not open dormant Pocket item:', error);
      showToast(uiText('Could not open this Pocket item', '无法打开这个「口袋」项目'));
    }
  } else if (tabUrl) {
    await focusTab(tabUrl);
  }
}

function replaceChipLabel(chip, text) {
  const input = chip?.querySelector('.chip-rename-input');
  const label = document.createElement('span');
  label.className = 'chip-text tab-drag-handle';
  label.dataset.chipLabel = '';
  label.dataset.tooltipUrl = chip?.dataset.tabUrl || '';
  label.textContent = text;
  input?.replaceWith(label);
  chip?.classList.remove('is-renaming');
}

function beginChipRename(chip) {
  if (!chip?.isConnected || chip.classList.contains('is-renaming')) return;
  cancelPendingChipActivation(chip);
  const label = chip.querySelector('[data-chip-label]');
  if (!label) return;
  const displayedName = label.textContent || '';
  const previousCustomLabel = customLabelForChip(chip);
  traceTabLabel('rename-start', chip, { displayedName });
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chip-rename-input';
  input.value = displayedName;
  input.setAttribute('aria-label', uiText('Rename tab', '重命名标签页'));
  input.autocomplete = 'off';
  input.spellcheck = false;
  chip.classList.add('is-renaming');
  label.replaceWith(input);

  let finished = false;
  const finish = async commit => {
    if (finished) return;
    finished = true;
    const nextLabel = normalizeCustomLabel(input.value);
    if (!commit) {
      traceTabLabel('rename-cancel', chip);
      replaceChipLabel(chip, displayedName);
      return;
    }
    try {
      await setChipCustomLabel(chip, nextLabel);
      if (nextLabel !== previousCustomLabel) {
        const tabId = Number(chip.dataset.tabId);
        const pocketItemId = chip.dataset.pocketItemId;
        await pushUndoEntry({
          type: 'tab-label',
          ...(Number.isInteger(tabId) ? { tabId } : {}),
          ...(pocketItemId ? { pocketItemId } : {}),
          url: chip.dataset.tabUrl || '',
          before: previousCustomLabel,
          after: nextLabel,
          renamedAt: Date.now(),
        });
      }
      traceTabLabel('rename-save', chip, {
        customLabel: nextLabel || null,
        cleared: !nextLabel,
      });
      await renderDashboard();
    } catch (error) {
      traceTabLabel('rename-save-failed', chip, {
        error: String(error?.message || error),
      });
      console.warn('[tab-out] Could not save tab label:', error);
      replaceChipLabel(chip, displayedName);
      showToast(uiText('Could not save this tab name', '无法保存这个标签名称'));
    }
  };

  input.addEventListener('pointerdown', event => event.stopPropagation());
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('dblclick', event => event.stopPropagation());
  input.addEventListener('dragstart', event => event.preventDefault());
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      void finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void finish(false);
    }
  });
  input.addEventListener('blur', () => { void finish(true); }, { once: true });
  input.focus();
  input.select();
}

function queueTabChipActivation(chip) {
  if (suppressedChipActivations.has(chip)) {
    suppressedChipActivations.delete(chip);
    return;
  }
  if (pendingChipActivations.has(chip)) {
    cancelPendingChipActivation(chip);
    beginChipRename(chip);
    return;
  }
  const pending = setTimeout(() => {
    pendingChipActivations.delete(chip);
    void activateTabChip(chip);
  }, CHIP_SINGLE_CLICK_DELAY_MS);
  pendingChipActivations.set(chip, pending);
}

document.addEventListener('dblclick', event => {
  if (event.target.closest('.chip-rename-input')) {
    event.stopPropagation();
    return;
  }
  const chip = event.target.closest('.page-chip[data-action="focus-tab"]');
  if (!chip || event.target.closest('.chip-actions')) return;
  event.preventDefault();
  event.stopPropagation();
}, true);


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  // A completed long press still produces a native click on pointer release.
  // Consume that click so it cannot also trigger the ordinary one-item action.
  if (suppressedActionClicks.has(actionEl)) {
    suppressedActionClicks.delete(actionEl);
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  const action = actionEl.dataset.action;

  const card = actionEl.closest('.mission-card');

  if (action === 'dedup-tab') {
    e.preventDefault();
    e.stopPropagation();
    const tabChip = actionEl.closest('.page-chip');
    const tabId = Number(actionEl.dataset.tabId);
    const rawUrl = actionEl.dataset.tabUrl || '';
    const captainKeepId = actionEl.dataset.captainKeepId
      || tabChip?.dataset.captainKeepId
      || '';
    const isCaptainKeepDedup = Boolean(captainKeepId
      && Number.isInteger(tabId)
      && isLiveCaptainKeepTab(openTabs.find(tab => tab.id === tabId)));
    if (isCaptainKeepDedup) {
      traceCaptainKeepDedup('start', {
        clickedTabId: tabId,
        captainKeepId,
        rawUrl,
        identityUrl: getPocketIdentityUrl(rawUrl),
      });
    }
    traceDuplicateDelete('delete-start', {
      clickedTabId: Number.isInteger(tabId) ? tabId : null,
      clickedRawUrl: rawUrl,
      clickedIdentityUrl: getPocketIdentityUrl(rawUrl),
    });
    const groupCard = tabChip?.closest('.mission-card');
    const area = groupCard?.dataset.area;
    const group = groupsForArea(area)
      .find(item => groupCardId(item, area) === groupCard?.dataset.domainId);
    let optimisticUiPatched = false;
    try {
      const duplicateIds = Number.isInteger(tabId) && group
        ? await duplicateCopiesForTab(tabId, group.tabs)
        : [];
      if (isCaptainKeepDedup && captainKeepDedupTrace) {
        captainKeepDedupTrace.targetTabIds = [...duplicateIds];
        traceCaptainKeepDedup('duplicates-resolved', {
          targetTabIds: duplicateIds,
          groupKey: group?.domain || null,
          groupTabCount: group?.tabs?.length || 0,
        });
        traceCaptainKeepDedup('close-begin', { targetTabIds: duplicateIds });
        optimisticUiPatched = optimisticallyResolveCaptainKeepDuplicates(
          captainKeepId,
          tabId,
          duplicateIds,
        );
      }
      const closedTabs = await closeTabsWithUndo(duplicateIds, { traceDuplicateRemoval: true });
      if (isCaptainKeepDedup) {
        traceCaptainKeepDedup('close-complete', {
          closedTabIds: closedTabs.map(tab => tab.id),
          closedCount: closedTabs.length,
        });
      }
      if (closedTabs.length === 0) {
        if (optimisticUiPatched) scheduleDashboardRefresh();
        if (isCaptainKeepDedup) traceCaptainKeepDedup('complete', { result: 'nothing-closed' });
        return;
      }

      playCloseSound();
      scheduleDashboardRefresh();
      if (isCaptainKeepDedup) {
        traceCaptainKeepDedup('model-reconciled', {
          optimisticUiPatched,
          remainingOpenTabCount: openTabs.length,
        });
      }
      showToast(uiText(
        `Closed ${closedTabs.length} duplicate tab${closedTabs.length === 1 ? '' : 's'}`,
        `已关闭 ${closedTabs.length} 个重复标签页`,
      ), 2500, 'destructive');
      if (isCaptainKeepDedup) traceCaptainKeepDedup('complete', { result: 'success' });
    } catch (error) {
      if (isCaptainKeepDedup) {
        if (optimisticUiPatched) {
          traceCaptainKeepDedup('rollback-render-begin');
          await renderDashboard().catch(() => {});
          traceCaptainKeepDedup('rollback-render-complete');
        }
        traceCaptainKeepDedup('error', {
          error: String(error?.stack || error?.message || error),
        });
        showToast(uiText('Could not remove duplicate tabs', '无法去除重复标签页'));
        return;
      }
      throw error;
    }
    return;
  }

  if (action === 'cycle-pocket-position') {
    const positions = ['left', 'right'];
    pocketPosition = positions[(positions.indexOf(pocketPosition) + 1) % positions.length];
    applyPocketPosition();
    await chrome.storage.local.set({ [POCKET_POSITION_KEY]: pocketPosition });
    return;
  }

  if (action === 'kill-archive-live') {
    const liveItems = pocketItems.filter(item => item.state === 'live');
    const count = await killPocketItems(liveItems.map(item => item.id));
    if (count === 0) return;
    showToast(uiText(
      `Closed ${count} tab${count === 1 ? '' : 's'}`,
      `已关闭 ${count} 个标签页`,
    ), 2500, 'destructive');
    return;
  }

  // ---- Close every Pocket item ----
  if (action === 'clear-archive') {
    const pocketTabs = archivedDomainGroups.flatMap(group => group.tabs || []);
    const tabIds = livePocketTabIds(pocketTabs);
    const dormantItemIds = dormantPocketItemIds(pocketTabs);
    if (tabIds.length === 0 && dormantItemIds.length === 0) return;

    const closedTabs = await closeTabsWithUndo(tabIds);
    const discardedDormantCount = await discardDormantPocketItems(dormantItemIds);
    const count = closedTabs.length + discardedDormantCount;
    if (count === 0) return;

    playCloseSound();
    scheduleDashboardRefresh();
    showToast(uiText(`Deleted ${count} tab${count !== 1 ? 's' : ''} from Pocket`, `已删除「口袋」中的 ${count} 个标签页`), 2500, 'destructive');
    return;
  }

  // ---- Restore every Pocket item from Pocket ----
  if (action === 'restore-archive') {
    const pocketTabs = archivedDomainGroups.flatMap(group => group.tabs || []);
    const tabIds = livePocketTabIds(pocketTabs);
    const dormantItemIds = dormantPocketItemIds(pocketTabs);
    if (tabIds.length === 0 && dormantItemIds.length === 0) return;

    const changes = await changeArchiveMembershipWithUndo(tabIds, false);
    const restoredDormant = await restoreDormantPocketItems(dormantItemIds);
    const count = changes.length + restoredDormant.length;
    if (count === 0) return;

    scheduleDashboardRefresh();
    showToast(pocketRestoreToastMessage(count));
    return;
  }

  if (action === 'kill-captain-keep') {
    e.preventDefault();
    e.stopPropagation();
    const tabId = Number(actionEl.dataset.tabId);
    const keepId = actionEl.dataset.captainKeepId || '';
    if (!keepId || captainKeepLifecycleInFlight.has(keepId)) return;
    const keepItem = captainKeepItemSnapshot(keepId);
    if (!keepItem || !Number.isInteger(tabId)) return;
    captainKeepLifecycleInFlight.add(keepId);
    beginDashboardRefreshSuppression();
    markTabsForLocalClose([tabId]);
    const confettiOrigins = captureDeletionConfettiOrigins([tabId]);
    const closingTab = openTabs.find(tab => tab.id === tabId) || { id: tabId };
    try {
      await requestCaptainKeepLifecycle('kill', { keepId, tabId });
      await pushUndoEntry({ type: 'captain-keep-lifecycle', transition: 'kill', keepItem, tabId });
      playCloseSound();
      celebrateDeletedTabs([closingTab], confettiOrigins);
      openTabs = openTabs.filter(tab => tab.id !== tabId);
      if (!patchCaptainKeepChip(keepId, 'dead')) await renderDashboard();
      showToast(uiText('Closed 1 tab', '已关闭 1 个标签页'), 2500, 'destructive');
    } catch (error) {
      unmarkTabsForLocalClose([tabId]);
      console.warn('[tab-out] Could not kill the Captain Keep tab:', error);
      showToast(uiText('Could not kill this tab', '无法关闭此标签页'));
    } finally {
      endDashboardRefreshSuppression();
      captainKeepLifecycleInFlight.delete(keepId);
    }
    return;
  }

  if (action === 'revive-captain-keep') {
    if (e.target.closest('.chip-actions')) return;
    const keepId = actionEl.dataset.captainKeepId || '';
    if (!keepId || captainKeepLifecycleInFlight.has(keepId)) return;
    const keepItem = captainKeepItemSnapshot(keepId);
    if (!keepItem) return;
    traceCaptainKeepRevive('start', {
      keepId,
      keepItem,
      refreshPending: dashboardRefreshPending,
      suppressionDepth: dashboardRefreshSuppressionDepth,
    });
    captainKeepLifecycleInFlight.add(keepId);
    beginDashboardRefreshSuppression();
    try {
      const response = await openDeadCaptainKeep(keepId, keepItem);
      await pushUndoEntry({
        type: 'captain-keep-lifecycle',
        transition: 'revive',
        keepItem,
        tabId: response.createdTab?.id ?? null,
      });
      if (response.createdTab) {
        openTabs = [...openTabs.filter(tab => tab.id !== response.createdTab.id), response.createdTab];
      }
      const domPatched = patchCaptainKeepChip(keepId, 'live', response.createdTab);
      traceCaptainKeepRevive('dom-patch', {
        createdTabId: response.createdTab?.id ?? null,
        domPatched,
        isLiveKeep: response.createdTab ? isLiveCaptainKeepTab(response.createdTab) : false,
        refreshPending: dashboardRefreshPending,
        suppressionDepth: dashboardRefreshSuppressionDepth,
      });
      if (!domPatched) await renderDashboard();
      showToast(uiText('Tab reopened', '标签页已重新打开'));
    } catch (error) {
      traceCaptainKeepRevive('error', { error: String(error?.stack || error?.message || error) });
      console.warn('[tab-out] Could not reopen the dead Captain Keep tab:', error);
      showToast(uiText('Could not reopen this tab', '无法重新打开此标签页'));
    } finally {
      endDashboardRefreshSuppression();
      captainKeepLifecycleInFlight.delete(keepId);
      traceCaptainKeepRevive('workflow-end', {
        refreshPending: dashboardRefreshPending,
        refreshTimerScheduled: dashboardRefreshTimer !== null,
        suppressionDepth: dashboardRefreshSuppressionDepth,
      });
    }
    return;
  }

  if (action === 'close-dead-captain-keep') {
    e.preventDefault();
    e.stopPropagation();
    const keepId = actionEl.dataset.captainKeepId || '';
    if (!keepId || captainKeepLifecycleInFlight.has(keepId)) return;
    const keepItem = captainKeepItemSnapshot(keepId);
    if (!keepItem) return;
    captainKeepLifecycleInFlight.add(keepId);
    try {
      await requestCaptainKeepLifecycle('remove-dead', { keepId });
      await pushUndoEntry({ type: 'captain-keep-lifecycle', transition: 'remove-dead', keepItem });
      if (!removeCaptainKeepChip(keepId)) await renderDashboard();
      showToast(uiText('Removed dead tab from Keep', '已从保留区移除失效标签页'), 2500, 'destructive');
    } catch (error) {
      console.warn('[tab-out] Could not remove the dead Captain Keep tab:', error);
      showToast(uiText('Could not remove this dead tab', '无法移除此失效标签页'));
    } finally {
      captainKeepLifecycleInFlight.delete(keepId);
    }
    return;
  }

  if (action === 'revive-captain-pending-dead') {
    if (e.target.closest('.chip-actions')) return;
    const pendingItemId = actionEl.dataset.captainPendingDeadId || '';
    if (!pendingItemId || captainKeepLifecycleInFlight.has(pendingItemId)) return;
    const pendingItem = captainPendingDeadItemSnapshot(pendingItemId);
    if (!pendingItem?.url) return;
    captainKeepLifecycleInFlight.add(pendingItemId);
    beginDashboardRefreshSuppression();
    try {
      const response = await openDeadCaptainPending(pendingItemId, pendingItem);
      if (response.createdTab) openTabs = [...openTabs, response.createdTab];
      await renderDashboard();
      showToast(uiText('Pending tab reopened', '待处理标签页已重新打开'));
    } catch (error) {
      console.warn('[tab-out] Could not reopen dead Pending tab:', error);
      showToast(uiText('Could not reopen this Pending tab', '无法重新打开此待处理标签页'));
    } finally {
      endDashboardRefreshSuppression();
      captainKeepLifecycleInFlight.delete(pendingItemId);
    }
    return;
  }

  if (action === 'close-dead-captain-pending') {
    e.preventDefault();
    e.stopPropagation();
    const pendingItemId = actionEl.dataset.captainPendingDeadId || '';
    if (!pendingItemId || captainKeepLifecycleInFlight.has(pendingItemId)) return;
    captainKeepLifecycleInFlight.add(pendingItemId);
    try {
      await requestCaptainKeepLifecycle('remove-pending-dead', { keepItem: { pendingItemId } });
      await renderDashboard();
      showToast(uiText('Removed dead Pending tab', '已移除 dead 待处理标签页'), 2500, 'destructive');
    } catch (error) {
      console.warn('[tab-out] Could not remove dead Pending tab:', error);
      showToast(uiText('Could not remove this Pending tab', '无法移除此待处理标签页'));
    } finally {
      captainKeepLifecycleInFlight.delete(pendingItemId);
    }
    return;
  }

  if (action === 'archive-dead-captain') {
    e.preventDefault();
    e.stopPropagation();
    if (!readLaterEnabled) return;
    const keepId = actionEl.dataset.captainKeepId || '';
    const pendingItemId = actionEl.dataset.captainPendingDeadId || '';
    const lifecycleId = keepId || pendingItemId;
    if (!lifecycleId || captainKeepLifecycleInFlight.has(lifecycleId)) return;
    captainKeepLifecycleInFlight.add(lifecycleId);
    try {
      const result = await moveDeadCaptainItemToPocket({ keepId, pendingItemId });
      if (!result.moved) return;
      await renderDashboard();
      showToast(uiText('Moved dead tab to Pocket', '已将 dead 标签页移到「口袋」'));
    } catch (error) {
      console.warn('[tab-out] Could not move dead Captain tab to Pocket:', error);
      showToast(uiText('Could not move this dead tab to Pocket', '无法将此 dead 标签页移到「口袋」'));
    } finally {
      captainKeepLifecycleInFlight.delete(lifecycleId);
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    if (e.target.closest('.chip-rename-input')) return;
    if (actionEl.classList.contains('is-dormant-pocket')) {
      // Dead Pocket entries have no live tab to disambiguate or rename, so
      // opening them should not wait for the live-tab double-click delay.
      await activateTabChip(actionEl);
      return;
    }
    queueTabChipActivation(actionEl);
    return;
  }

  // ---- Restore one archived tab to the domain-grouped area ----
  if (action === 'restore-tab') {
    e.stopPropagation();
    const pocketItemId = actionEl.dataset.pocketItemId;
    if (pocketItemId && !Number.isInteger(Number(actionEl.dataset.tabId))) {
      const changes = await restoreDormantPocketItems([pocketItemId]);
      if (changes.length === 0) return;
      await renderDashboard();
      showToast(pocketRestoreToastMessage(1));
      return;
    }
    const tabIds = selectedTabIdsForChipAction(actionEl);
    if (tabIds.length === 0) return;
    clearMarqueeSelection();

    const changes = await changeArchiveMembershipWithUndo(tabIds, false);
    if (changes.length === 0) return;

    scheduleDashboardRefresh();
    showToast(pocketRestoreToastMessage(changes.length));
    return;
  }

  if (action === 'kill-pocket-item') {
    e.stopPropagation();
    const pocketItemId = actionEl.dataset.pocketItemId || '';
    const count = await killPocketItems([pocketItemId]);
    if (count === 0) return;
    showToast(uiText(
      `Closed ${count} tab${count === 1 ? '' : 's'}`,
      `已关闭 ${count} 个标签页`,
    ), 2500, 'destructive');
    return;
  }

  // ---- Apply the selected action to only the Captain Pending subgroup ----
  if (action === 'archive-captain-pending' || action === 'delete-captain-pending') {
    e.stopPropagation();
    const captainGroupKeyValue = actionEl.dataset.captainGroup;
    const captainGroup = domainGroups.find(group => group.domain === captainGroupKeyValue);
    const actionCaptainConfig = captainConfigForGroupKey(captainGroupKeyValue);
    const actionCaptainTitle = actionCaptainConfig ? captainTitle(actionCaptainConfig) : uiText('Captain', '「常用界面」');
    const tabIds = (captainGroup?.tabs || [])
      .filter(tab => Number.isInteger(tab.id) && !isLiveCaptainKeepTab(tab))
      .map(tab => tab.id);
    if (tabIds.length === 0) return;

    if (action === 'archive-captain-pending') {
      const changes = await changeArchiveMembershipWithUndo(tabIds, true);
      if (changes.length === 0) return;
      scheduleDashboardRefresh();
      showToast(uiText(`Put ${changes.length} pending ${actionCaptainTitle} tab${changes.length === 1 ? '' : 's'} in Pocket`, `已将 ${actionCaptainTitle} 待处理区的 ${changes.length} 个标签页扔进「口袋」`));
      return;
    }

    const closedTabs = await closeTabsWithUndo(tabIds);
    if (closedTabs.length === 0) return;
    playCloseSound();
    scheduleDashboardRefresh();
    showToast(uiText(`Deleted ${closedTabs.length} pending ${actionCaptainTitle} tab${closedTabs.length === 1 ? '' : 's'}`, `已删除 ${actionCaptainTitle} 待处理区的 ${closedTabs.length} 个标签页`), 2500, 'destructive');
    return;
  }

  // ---- Archive one open tab; this is equivalent to dragging it upward ----
  if (action === 'archive-tab') {
    e.stopPropagation();
    const tabIds = selectedTabIdsForChipAction(actionEl);
    const duplicateRepresentativeIds = duplicateRepresentativeIdsForChipAction(actionEl);
    if (tabIds.length === 0) return;
    clearMarqueeSelection();

    const { changes, closedDuplicates } = await archiveTabsWithIndicatedDedup(
      tabIds,
      duplicateRepresentativeIds,
    );
    if (changes.length === 0 && closedDuplicates.length === 0) return;

    scheduleDashboardRefresh();
    showToast(closedDuplicates.length > 0
      ? uiText(
        `Removed ${closedDuplicates.length} duplicate tab${closedDuplicates.length === 1 ? '' : 's'} and put ${changes.length === 1 ? 'one tab' : `${changes.length} tabs`} in Pocket`,
        `已去除 ${closedDuplicates.length} 个重复标签页，并将${changes.length === 1 ? '一份' : `${changes.length} 份`}扔进「口袋」`,
      )
      : uiText(
        `Put ${changes.length} tab${changes.length === 1 ? '' : 's'} in Pocket`,
        `已将 ${changes.length} 个扔进「口袋」`,
      ));
    return;
  }

  // ---- Archive every tab from one Open tabs group ----
  if (action === 'archive-domain-tabs') {
    const area = actionEl.dataset.area || 'open';
    const domainId = actionEl.dataset.domainId;
    const group = groupsForArea(area).find(item => groupCardId(item, area) === domainId);
    if (!group) return;

    const changes = await changeArchiveMembershipWithUndo(group.tabs.map(tab => tab.id), true);
    if (changes.length === 0) return;

    scheduleDashboardRefresh();
    const groupCaptainConfig = captainConfigForGroupKey(group.domain);
    const groupLabel = groupCaptainConfig
      ? captainTitle(groupCaptainConfig)
      : group.domain === '__landing-pages__'
        ? uiText('Homepages', '主页')
        : (group.label || friendlyDomain(group.domain));
    showToast(uiText(`Put ${changes.length} tab${changes.length !== 1 ? 's' : ''} from ${groupLabel} in Pocket`, `已将 ${groupLabel} 中的 ${changes.length} 个扔进「口袋」`));
    return;
  }

  // ---- Restore every tab from one Pocket group ----
  if (action === 'restore-domain-tabs') {
    const area = actionEl.dataset.area || 'archive';
    const domainId = actionEl.dataset.domainId;
    const group = groupsForArea(area).find(item => groupCardId(item, area) === domainId);
    if (!group) return;

    const changes = await changeArchiveMembershipWithUndo(livePocketTabIds(group.tabs), false);
    const restoredDormant = await restoreDormantPocketItems(dormantPocketItemIds(group.tabs));
    const count = changes.length + restoredDormant.length;
    if (count === 0) return;

    scheduleDashboardRefresh();
    showToast(pocketRestoreToastMessage(count));
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const sourceChip = actionEl.closest('.page-chip');
    const selectedTabIds = selectedTabIdsForChipAction(actionEl);
    const tabId = Number(actionEl.dataset.tabId);
    const tabUrl = actionEl.dataset.tabUrl;
    const pocketItemId = actionEl.dataset.pocketItemId;
    let closedTabs = [];

    if (pocketItemId && !Number.isInteger(tabId)) {
      const pocketItem = pocketItemById(pocketItemId);
      await discardDormantPocketItems([pocketItemId]);
      if (pocketItem) {
        await pushUndoEntry({ type: 'pocket-lifecycle', transition: 'remove-dead', items: [pocketItem] });
      }
      await renderDashboard();
      showToast(uiText('Closed 1 tab', '已关闭 1 个标签页'), 2500, 'destructive');
      return;
    }
    if (sourceChip?.classList.contains('is-marquee-selected')
      && selectedTabIds.length > 0) {
      clearMarqueeSelection();
      closedTabs = await closeTabsWithUndo(selectedTabIds);
    }
    else if (Number.isInteger(tabId)) {
      closedTabs = await closeTabsWithUndo([tabId]);
    }
    else if (tabUrl) {
      const allTabs = await chrome.tabs.query({});
      const match = allTabs.find(t => t.url === tabUrl);
      if (match) closedTabs = await closeTabsWithUndo([match.id]);
    } else return;
    if (closedTabs.length === 0) return;

    playCloseSound();

    scheduleDashboardRefresh();
    showToast(uiText(
      `Closed ${closedTabs.length} tab${closedTabs.length === 1 ? '' : 's'}`,
      `已关闭 ${closedTabs.length} 个标签页`,
    ), 2500, 'destructive');
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const area = actionEl.dataset.area;
    const group = groupsForArea(area).find(item => groupCardId(item, area) === domainId);
    if (!group) return;

    const tabIds = livePocketTabIds(group.tabs);
    const closedTabs = await closeTabsWithUndo(tabIds);
    const discardedDormantCount = await discardDormantPocketItems(dormantPocketItemIds(group.tabs));
    const count = closedTabs.length + discardedDormantCount;
    if (count === 0) return;

    playCloseSound();
    scheduleDashboardRefresh();

    const groupCaptainConfig = captainConfigForGroupKey(group.domain);
    const groupLabel = groupCaptainConfig
      ? captainTitle(groupCaptainConfig)
      : group.domain === '__landing-pages__'
        ? uiText('Homepages', '主页')
        : (group.label || friendlyDomain(group.domain));
    showToast(uiText(`Closed ${count} tab${count !== 1 ? 's' : ''} from ${groupLabel}`, `已关闭 ${groupLabel} 中的 ${count} 个标签页`), 2500, 'destructive');

    return;
  }

});

function cancelOtherActionLongPress() {
  if (longPressTimer !== null) clearTimeout(longPressTimer);
  if (longPressIntentTimer !== null) clearTimeout(longPressIntentTimer);
  longPressTimer = null;
  longPressIntentTimer = null;
  longPressGesture = null;
  removeLongPressPrompt();
}

function pointIsInsidePressBounds(bounds, x, y) {
  return Number.isFinite(x)
    && Number.isFinite(y)
    && x >= bounds.left
    && x <= bounds.right
    && y >= bounds.top
    && y <= bounds.bottom;
}

function guardCancelledPressClick(gesture) {
  if (longPressClickGuard) suppressedActionClicks.delete(longPressClickGuard.button);
  suppressedActionClicks.add(gesture.button);
  longPressClickGuard = {
    pointerId: gesture.pointerId,
    button: gesture.button
  };
}

// Once a pending press leaves its original button, that pointer sequence is
// permanently invalid. Returning to the button cannot restart or complete it.
function cancelOtherActionPress(pointerId, suppressClick = false) {
  const gesture = longPressGesture;
  if (!gesture || gesture.pointerId !== pointerId) return false;
  if (suppressClick) guardCancelledPressClick(gesture);
  cancelOtherActionLongPress();
  clearOtherActionFeedback();
  return true;
}

// A normal click continues to use the delegated handler above. Holding for
// three seconds performs the corresponding "other groups/tabs" action.
document.addEventListener('pointerdown', (e) => {
  const button = e.target.closest('button[data-action]');
  const descriptor = otherActionDescriptor(button);
  if (!descriptor || e.button !== 0) {
    if (pendingOtherAction) clearOtherActionFeedback();
    return;
  }

  // A pointer that left the document may not have delivered pointerup. Do not
  // let that stale guard affect a later, independent press.
  if (longPressClickGuard) suppressedActionClicks.delete(longPressClickGuard.button);
  longPressClickGuard = null;
  clearOtherActionFeedback();
  cancelOtherActionLongPress();
  if (otherActionTabIds(descriptor).length === 0) return;

  longPressGesture = {
    button,
    pointerId: e.pointerId,
    startedAt: performance.now(),
    bounds: button.getBoundingClientRect(),
    x: e.clientX,
    y: e.clientY
  };
  // A normal click must affect only its own tab. Reveal the "other" targets
  // only after the pointer has crossed the long-press intent threshold.
  longPressIntentTimer = window.setTimeout(() => {
    longPressIntentTimer = null;
    const gesture = longPressGesture;
    if (!gesture
      || !gesture.button.isConnected
      || !pointIsInsidePressBounds(gesture.bounds, gesture.x, gesture.y)) return;
    if (!beginOtherActionFeedback(button, descriptor)) return;
    showLongPressPrompt(button, descriptor, gesture.startedAt);
  }, LONG_PRESS_INTENT_DELAY);
  longPressTimer = window.setTimeout(() => {
    longPressTimer = null;
    const gesture = longPressGesture;
    if (!gesture) return;

    // Do not trust the timer alone: revalidate the pointer position at the
    // exact completion boundary before allowing the destructive batch action.
    if (!gesture.button.isConnected
      || !pointIsInsidePressBounds(gesture.bounds, gesture.x, gesture.y)) {
      cancelOtherActionPress(gesture.pointerId, true);
      return;
    }
    longPressGesture = null;
    removeLongPressPrompt();

    // Keep the native click blocked for the full lifetime of this pointer.
    // A fixed timeout is unsafe because users may hold before releasing.
    guardCancelledPressClick(gesture);
    void completeOtherAction();
  }, LONG_PRESS_DELAY);
});

document.addEventListener('pointermove', (e) => {
  const gesture = longPressGesture;
  if (!gesture || gesture.pointerId !== e.pointerId) return;

  gesture.x = e.clientX;
  gesture.y = e.clientY;
  const primaryButtonIsDown = (e.buttons & 1) === 1;
  if (!primaryButtonIsDown || !pointIsInsidePressBounds(gesture.bounds, e.clientX, e.clientY)) {
    cancelOtherActionPress(e.pointerId, true);
  }
});

// Covers leaving the document without a window blur event. This is also a
// permanent cancellation for the current pointer sequence.
document.addEventListener('pointerout', (e) => {
  if (e.relatedTarget === null) cancelOtherActionPress(e.pointerId, true);
});

document.addEventListener('pointerup', (e) => {
  const incompleteGesture = longPressGesture;
  if (incompleteGesture?.pointerId === e.pointerId) {
    const heldFor = performance.now() - incompleteGesture.startedAt;
    // A quick release remains an ordinary click. Once the press intent
    // threshold has been crossed, releasing before three seconds is a
    // cancelled long press and must not fall through to the normal click.
    if (heldFor >= LONG_PRESS_INTENT_DELAY) {
      cancelOtherActionPress(e.pointerId, true);
    }
  }

  if (longPressClickGuard?.pointerId === e.pointerId) {
    const guardedButton = longPressClickGuard.button;
    longPressClickGuard = null;
    // Native click is dispatched after pointerup and before this timer.
    window.setTimeout(() => suppressedActionClicks.delete(guardedButton), 0);
  }
  cancelOtherActionLongPress();
  clearOtherActionFeedback();
});

document.addEventListener('pointercancel', () => {
  if (longPressClickGuard) suppressedActionClicks.delete(longPressClickGuard.button);
  longPressClickGuard = null;
  cancelOtherActionLongPress();
  clearOtherActionFeedback();
});
window.addEventListener('blur', () => {
  if (longPressClickGuard) suppressedActionClicks.delete(longPressClickGuard.button);
  longPressClickGuard = null;
  cancelOtherActionLongPress();
  clearOtherActionFeedback();
});

// Keep the familiar browser/editor undo and redo shortcuts available on the dashboard.
// Editable fields retain their native text undo behavior should they be added
// to this page in the future.
let escapeShortcutHeld = false;
let lastEscapeShortcutAt = 0;
let keyboardActionInFlight = false;
const DOUBLE_ESCAPE_WINDOW_MS = 500;

async function runKeyboardAction(name, action) {
  if (keyboardActionInFlight) return;
  keyboardActionInFlight = true;
  const startedAt = performance.now();
  globalThis.TabOutDiagnostics?.mark('keyboard:action-start', { name });
  try {
    await action();
    globalThis.TabOutDiagnostics?.mark('keyboard:action-complete', {
      name,
      durationMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    globalThis.TabOutDiagnostics?.mark('keyboard:action-error', {
      name,
      durationMs: Math.round(performance.now() - startedAt),
      error: String(error?.message || error),
    });
    console.error(`[tab-out] Keyboard action failed (${name}):`, error);
    showToast(uiText('That keyboard action could not be completed', '无法完成该键盘操作'));
  } finally {
    keyboardActionInFlight = false;
  }
}
window.addEventListener('keyup', event => {
  if (event.key === 'Escape') escapeShortcutHeld = false;
});
window.addEventListener('blur', () => {
  escapeShortcutHeld = false;
  lastEscapeShortcutAt = 0;
});
document.addEventListener('keydown', async (e) => {
  const target = e.target;
  const isEditing = target instanceof HTMLElement
    && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  if (e.key === 'Escape') {
    escapeShortcutHeld = true;
    if (isEditing || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    const pressedAt = performance.now();
    if (pressedAt - lastEscapeShortcutAt <= DOUBLE_ESCAPE_WINDOW_MS) {
      lastEscapeShortcutAt = 0;
      await runKeyboardAction('candidate-delete', closeCurrentCandidateBatch);
    } else {
      lastEscapeShortcutAt = pressedAt;
    }
    return;
  }
  const selectedTabIds = selectedMarqueeTabIds();

  const isPlainEnter = e.key === 'Enter'
    && !e.ctrlKey
    && !e.metaKey
    && !e.altKey
    && !e.shiftKey;
  const isPlainBackspace = e.key === 'Backspace'
    && !e.ctrlKey
    && !e.metaKey
    && !e.altKey
    && !e.shiftKey;

  if (isPlainEnter) {
    if (isEditing || e.repeat || escapeShortcutHeld) return;
    if (!readLaterEnabled) return;
    e.preventDefault();
    if (selectedTabIds.length === 0) {
      await runKeyboardAction('archive-loose-tabs', archiveAllOpenTabs);
      return;
    }
    await runKeyboardAction('archive-selected-tabs', async () => {
      const changes = await changeArchiveMembershipWithUndo(selectedTabIds, true);
      clearMarqueeSelection();
      if (changes.length === 0) return;
      scheduleDashboardRefresh();
      showToast(uiText(
        `Put ${changes.length} selected tab${changes.length === 1 ? '' : 's'} in Pocket`,
        `已将选中的 ${changes.length} 个扔进「口袋」`,
      ));
    });
    return;
  }

  if (isPlainBackspace) {
    if (isEditing || e.repeat || escapeShortcutHeld) return;
    e.preventDefault();
    if (selectedTabIds.length === 0) {
      await runKeyboardAction('delete-loose-tabs', deleteAllOpenLooseTabs);
      return;
    }
    await runKeyboardAction('delete-selected-tabs', async () => {
      const closedTabs = await closeTabsWithUndo(selectedTabIds);
      clearMarqueeSelection();
      if (closedTabs.length === 0) return;
      playCloseSound();
      scheduleDashboardRefresh();
      showToast(uiText(
        `Closed ${closedTabs.length} selected tab${closedTabs.length === 1 ? '' : 's'}`,
        `已关闭选中的 ${closedTabs.length} 个标签页`,
      ), 2500, 'destructive');
    });
    return;
  }

  const isHistoryShortcut = (e.ctrlKey || e.metaKey)
    && !e.altKey
    && e.key.toLowerCase() === 'z';
  if (!isHistoryShortcut || e.repeat) return;

  if (isEditing || isUndoing) return;

  const isRedoShortcut = e.shiftKey;
  const history = isRedoShortcut ? redoHistory : undoHistory;
  if (history.length === 0) return;

  e.preventDefault();
  await runKeyboardAction(isRedoShortcut ? 'redo' : 'undo',
    isRedoShortcut ? redoLatestAction : undoLatestAction);
});

/* ----------------------------------------------------------------
   DRAG AND DROP
   ---------------------------------------------------------------- */

function tabIdsFromDragEvent(e) {
  const rawIds = e.dataTransfer?.getData('text/tab-out-tab-ids')
    || e.dataTransfer?.getData('text/plain')
    || '';
  return normalizeTabIds(rawIds.split(',').map(Number));
}

function clearDropHighlights(exceptCaptainCard = null) {
  document.querySelectorAll('.captain-group-card.is-captain-drop-target').forEach(card => {
    if (card === exceptCaptainCard) return;
    card.classList.remove('is-captain-drop-target');
    card.style.removeProperty('--captain-drop-indicator-top');
    delete card.dataset.captainDropDestination;
  });
  document.querySelectorAll('.is-pocket-reorder-before, .is-pocket-reorder-after')
    .forEach(element => element.classList.remove('is-pocket-reorder-before', 'is-pocket-reorder-after'));
}

let dragPreview = null;
let dragPreviewContext = null;
let nativeDragImage = null;
let draggedTabIds = [];
let draggedCaptainKeepIds = [];
let draggedCaptainPendingDeadIds = [];
let draggedPocketItemIds = [];
let draggedDuplicateRepresentativeIds = [];
let draggedCaptainGroupKey = '';
let draggedDomainId = '';
let dragSourceArea = '';
let dragKind = '';
let captainDragEligible = false;
let captainDragPreviewMoved = false;
let pocketDragPreviewMoved = false;
let captainDropHandled = false;
let dashboardDropHandled = false;
let pendingCaptainDragPoint = null;
let captainDragFrame = null;
let pendingPocketDragPoint = null;
let pocketDragFrame = null;
let pocketDragOriginalPlacements = [];
let dashboardDragCleanupPromise = null;
let lastDragDebugZone = '';
const captainReflowAnimations = new WeakMap();
const pocketReflowAnimations = new WeakMap();

function canMoveDraggedTabsWithinCaptainGroup() {
  return captainDragEligible && (draggedTabIds.length > 0
    || draggedCaptainKeepIds.length > 0
    || draggedCaptainPendingDeadIds.length > 0);
}

function draggedTabsBelongToOpenCaptainGroup() {
  const captainGroup = domainGroups.find(group => group.domain === draggedCaptainGroupKey);
  if (draggedCaptainKeepIds.length > 0) {
    const keepIds = new Set((captainGroup?.tabs || [])
      .filter(tab => tab.captainDead)
      .map(tab => tab.captainKeepId));
    return draggedCaptainKeepIds.every(id => keepIds.has(id));
  }
  if (draggedCaptainPendingDeadIds.length > 0) {
    const pendingDeadIds = new Set((captainGroup?.tabs || [])
      .filter(tab => tab.captainPendingDead)
      .map(tab => tab.captainPendingDeadId));
    return draggedCaptainPendingDeadIds.every(id => pendingDeadIds.has(id));
  }
  if (draggedTabIds.length === 0) return false;
  const openCaptainIds = new Set((captainGroup?.tabs || []).map(tab => tab.id));
  return draggedTabIds.every(id => openCaptainIds.has(id));
}

function layoutTopWithinCard(element, card) {
  let top = 0;
  let current = element;
  while (current && current !== card) {
    top += current.offsetTop;
    current = current.offsetParent;
  }
  if (current === card) return top;

  // This fallback is only for an unusual offset-parent chain. Account for the
  // card border so the value still matches an absolutely positioned child.
  const elementRect = element.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  return elementRect.top - cardRect.top - card.clientTop;
}

function chipRowElement(chip) {
  return chip?.closest('.page-chip-wrapper') || chip || null;
}

function captainCardAtPoint(target, clientX, clientY) {
  if (!canMoveDraggedTabsWithinCaptainGroup()) return null;
  const card = target instanceof Element
    ? target.closest('.captain-group-card[data-area="open"]')
    : null;
  if (!card) return null;
  if (card.dataset.groupKey !== draggedCaptainGroupKey) return null;

  const cardRect = card.getBoundingClientRect();
  if (clientX < cardRect.left || clientX > cardRect.right
    || clientY < cardRect.top || clientY > cardRect.bottom) return null;
  return card;
}

function captainDropContextAtPoint(card, clientX, clientY) {
  if (!card?.isConnected || !canMoveDraggedTabsWithinCaptainGroup()) return null;

  const cardRect = card.getBoundingClientRect();
  if (clientX < cardRect.left || clientX > cardRect.right
    || clientY < cardRect.top || clientY > cardRect.bottom) return null;
  const pointerY = clientY - cardRect.top - card.clientTop;

  const divider = card.querySelector('.captain-subgroup-divider');
  if (!divider) return null;
  const dividerY = layoutTopWithinCard(divider, card) + divider.offsetHeight / 2;

  // Moving the invisible source between Keep and Pending shifts the divider by
  // one row. Normalize by half that row so the hit boundary remains stable
  // instead of jumping away from the pointer after every cross-divider move.
  const sourceChip = card.querySelector(
    draggedCaptainKeepIds.length === 1
      ? `.page-chip[data-captain-keep-id="${CSS.escape(draggedCaptainKeepIds[0])}"]`
      : draggedCaptainPendingDeadIds.length === 1
        ? `.page-chip[data-captain-pending-dead-id="${CSS.escape(draggedCaptainPendingDeadIds[0])}"]`
      : `.page-chip[data-tab-id="${draggedTabIds.length === 1 ? draggedTabIds[0] : ''}"]`,
  );
  const sourceList = sourceChip?.closest('.mission-pages');
  const sourceGap = sourceList
    ? Number.parseFloat(getComputedStyle(sourceList).rowGap) || 0
    : 0;
  const sourceSlotHeight = sourceChip ? sourceChip.offsetHeight + sourceGap : 0;
  const sourceSubgroup = sourceChip?.closest('.captain-subgroup');
  const stableDividerY = dividerY + (sourceSubgroup?.classList.contains('captain-subgroup-retained')
    ? -sourceSlotHeight / 2
    : sourceSubgroup?.classList.contains('captain-subgroup-pending')
      ? sourceSlotHeight / 2
      : 0);
  const destination = pointerY < stableDividerY ? 'retained' : 'pending';
  const subgroup = card.querySelector(`.captain-subgroup-${destination}`);
  if (!subgroup) return null;
  const targetList = subgroup.querySelector(':scope > .mission-pages');
  if (!targetList) return null;

  const draggedIds = new Set(draggedTabIds);
  const draggedKeepIds = new Set(draggedCaptainKeepIds);
  const draggedPendingDeadIds = new Set(draggedCaptainPendingDeadIds);
  const candidateSelector = destination === 'retained'
    ? '.page-chip[data-tab-id], .page-chip[data-captain-keep-id]'
    : '.page-chip[data-tab-id], .page-chip[data-captain-pending-dead-id]';
  const candidates = [...subgroup.querySelectorAll(candidateSelector)]
    .filter(chip => chip.offsetHeight > 0
      && !draggedIds.has(Number(chip.dataset.tabId))
      && !draggedKeepIds.has(chip.dataset.captainKeepId)
      && !draggedPendingDeadIds.has(chip.dataset.captainPendingDeadId));
  const beforeChip = candidates.find(chip =>
    pointerY < layoutTopWithinCard(chip, card) + chip.offsetHeight / 2) || null;
  const beforeTabId = beforeChip ? Number(beforeChip.dataset.tabId) : null;
  const beforeKeepId = beforeChip?.dataset.captainKeepId || null;
  const targetGap = Number.parseFloat(getComputedStyle(targetList).rowGap) || 0;

  let indicatorY;
  if (beforeChip) {
    indicatorY = layoutTopWithinCard(beforeChip, card) - targetGap / 2;
  } else if (candidates.length > 0) {
    const lastChip = candidates.at(-1);
    indicatorY = layoutTopWithinCard(lastChip, card)
      + lastChip.offsetHeight + targetGap / 2;
  } else {
    indicatorY = dividerY + (destination === 'retained' ? -5 : 5);
  }

  return {
    card,
    destination,
    subgroup,
    targetList,
    candidates,
    beforeChip,
    beforeTabId: Number.isInteger(beforeTabId) ? beforeTabId : null,
    beforeKeepId,
    beforePendingDeadId: beforeChip?.dataset.captainPendingDeadId || null,
    indicatorTop: indicatorY,
  };
}

function captainDropContext(e) {
  const card = captainCardAtPoint(e.target, e.clientX, e.clientY);
  return card ? captainDropContextAtPoint(card, e.clientX, e.clientY) : null;
}

/**
 * Moves the invisible source chip(s) as live placeholders. Their neighbours
 * use a FLIP transition from their old positions, producing the same
 * displaced, "making room" response as the UI Kit while the custom drag
 * preview follows the pointer above them.
 */
function previewCaptainReorder(dropContext) {
  const draggedIdSet = new Set(draggedTabIds);
  const draggedKeepIdSet = new Set(draggedCaptainKeepIds);
  const draggedPendingDeadIdSet = new Set(draggedCaptainPendingDeadIds);
  const sourceChips = [...dropContext.card.querySelectorAll(
    '.page-chip[data-tab-id], .page-chip[data-captain-keep-id], .page-chip[data-captain-pending-dead-id]',
  )].filter(chip => draggedIdSet.has(Number(chip.dataset.tabId))
    || draggedKeepIdSet.has(chip.dataset.captainKeepId)
    || draggedPendingDeadIdSet.has(chip.dataset.captainPendingDeadId));
  const targetList = dropContext.targetList;
  if (sourceChips.length === 0 || !targetList) return dropContext.indicatorTop;

  // Expanded overflow rows use display:contents. Keep a source placed at the
  // end beside the last visible candidate rather than after the overflow UI.
  const beforeRow = chipRowElement(dropContext.beforeChip);
  const targetParent = beforeRow?.parentElement
    || chipRowElement(dropContext.candidates.at(-1))?.parentElement
    || targetList;
  const sourceRows = sourceChips.map(chipRowElement).filter(Boolean);
  const draggedKeys = draggedCaptainKeepIds.length > 0
    ? draggedCaptainKeepIds
    : draggedCaptainPendingDeadIds.length > 0
      ? draggedCaptainPendingDeadIds
      : draggedTabIds;
  const orderedSourceRows = draggedKeys
    .map(id => sourceRows.find(row => draggedCaptainKeepIds.length > 0
      ? row.querySelector('.page-chip')?.dataset.captainKeepId === id
      : draggedCaptainPendingDeadIds.length > 0
        ? row.querySelector('.page-chip')?.dataset.captainPendingDeadId === id
      : Number(row.querySelector('.page-chip[data-tab-id]')?.dataset.tabId) === id))
    .filter(Boolean);
  const siblings = [...targetParent.children];
  const insertionIndex = beforeRow
    ? siblings.indexOf(beforeRow)
    : siblings.length;
  const preceding = siblings.slice(Math.max(0, insertionIndex - orderedSourceRows.length), insertionIndex);
  const alreadyPlaced = orderedSourceRows.every(row => row.parentElement === targetParent)
    && preceding.length === orderedSourceRows.length
    && preceding.every((row, index) => row === orderedSourceRows[index]);
  const targetGap = Number.parseFloat(getComputedStyle(targetList).rowGap) || 0;
  if (alreadyPlaced) {
    return layoutTopWithinCard(orderedSourceRows[0], dropContext.card) - targetGap / 2;
  }

  const movingChips = [...dropContext.card.querySelectorAll(
    '.page-chip[data-tab-id], .page-chip[data-captain-keep-id], .page-chip[data-captain-pending-dead-id]',
  )].filter(chip => !draggedIdSet.has(Number(chip.dataset.tabId))
    && !draggedKeepIdSet.has(chip.dataset.captainKeepId)
    && !draggedPendingDeadIdSet.has(chip.dataset.captainPendingDeadId)
    && chip.offsetHeight > 0)
    .map(chipRowElement);
  const previousRects = new Map(movingChips.map(chip => [chip, chip.getBoundingClientRect()]));
  const previousPlacements = orderedSourceRows.map(row => [row.parentElement, row.nextSibling]);

  // Preserve each row's current on-screen position, then remove its previous
  // FLIP transform before measuring the new layout. This lets rapid pointer
  // movement connect animations without inheriting a stale translated rect.
  for (const chip of movingChips) {
    const previousAnimation = captainReflowAnimations.get(chip);
    if (!previousAnimation) continue;
    previousAnimation.cancel();
    captainReflowAnimations.delete(chip);
  }

  for (const sourceRow of orderedSourceRows) {
    if (beforeRow) targetParent.insertBefore(sourceRow, beforeRow);
    else targetParent.append(sourceRow);
  }

  const placementChanged = orderedSourceRows.some((row, index) => {
    const [previousParent, previousNextSibling] = previousPlacements[index];
    return previousParent !== row.parentElement || previousNextSibling !== row.nextSibling;
  });
  if (placementChanged) captainDragPreviewMoved = true;

  for (const chip of movingChips) {
    const previousRect = previousRects.get(chip);
    const nextRect = chip.getBoundingClientRect();
    const dx = previousRect.left - nextRect.left;
    const dy = previousRect.top - nextRect.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;

    const animation = chip.animate([
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: 'translate(0, 0)' },
    ], {
      duration: 150,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
    captainReflowAnimations.set(chip, animation);
    animation.addEventListener('finish', () => {
      if (captainReflowAnimations.get(chip) === animation) captainReflowAnimations.delete(chip);
    }, { once: true });
  }

  return layoutTopWithinCard(orderedSourceRows[0], dropContext.card) - targetGap / 2;
}

function updateCaptainDropPreview(card, clientX, clientY) {
  const dropContext = captainDropContextAtPoint(card, clientX, clientY);
  if (!dropContext) return;

  if (!card.classList.contains('is-captain-drop-target')) {
    clearDropHighlights(card);
    card.classList.add('is-captain-drop-target');
  }
  card.dataset.captainDropDestination = dropContext.destination;
  const indicatorTop = previewCaptainReorder(dropContext);
  card.style.setProperty('--captain-drop-indicator-top', `${indicatorTop}px`);
}

function scheduleCaptainDropPreview(card, clientX, clientY) {
  pendingCaptainDragPoint = { card, clientX, clientY };
  if (captainDragFrame !== null) return;
  captainDragFrame = requestAnimationFrame(() => {
    captainDragFrame = null;
    const point = pendingCaptainDragPoint;
    pendingCaptainDragPoint = null;
    if (point) updateCaptainDropPreview(point.card, point.clientX, point.clientY);
  });
}

function cancelPendingCaptainDropPreview() {
  if (captainDragFrame !== null) cancelAnimationFrame(captainDragFrame);
  captainDragFrame = null;
  pendingCaptainDragPoint = null;
}

function updateDragPreview(e) {
  if (!dragPreview || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
  dragPreview.style.left = `${e.clientX - Number(dragPreview.dataset.grabOffsetX || 0)}px`;
  dragPreview.style.top = `${e.clientY - Number(dragPreview.dataset.grabOffsetY || 0)}px`;
}

function createDragPreview(dragEl, e, dragIds = []) {
  const rect = dragEl.getBoundingClientRect();
  const dragCount = dragIds.length || 1;
  const isMultiChipDrag = dragCount > 1 && dragEl.classList.contains('page-chip');
  let preview;

  if (isMultiChipDrag) {
    preview = document.createElement('div');
    preview.className = 'tabout-multi-drag-preview';
    const dragIdSet = new Set(dragIds);
    const visibleChips = [...document.querySelectorAll('.page-chip.is-marquee-selected[data-tab-id]')]
      .filter(chip => dragIdSet.has(Number(chip.dataset.tabId)));
    for (const chip of visibleChips) {
      const clone = chip.cloneNode(true);
      clone.classList.remove(
        'is-dragging',
        'is-marquee-selected',
        'is-marquee-archive-preview',
        'is-marquee-delete-preview',
      );
      clone.removeAttribute('draggable');
      clone.querySelectorAll('[draggable="true"]').forEach(node => node.removeAttribute('draggable'));
      preview.append(clone);
    }
  } else {
    preview = dragEl.cloneNode(true);
  }
  const previewContext = document.createElement('div');
  previewContext.className = 'tabout-drag-preview-context domain-card-shell';
  if (dragEl.closest('.archive-tabs') || dragEl.dataset.area === 'archive') {
    previewContext.classList.add('archive-tabs');
  }
  preview.classList.remove('is-dragging');
  preview.classList.add('tabout-drag-preview');
  preview.removeAttribute('draggable');
  if (isMultiChipDrag) {
    const countBadge = document.createElement('span');
    countBadge.className = 'tabout-drag-count';
    countBadge.textContent = String(dragCount);
    preview.append(countBadge);
  }
  preview.style.width = `${rect.width}px`;
  if (!isMultiChipDrag) preview.style.height = `${rect.height}px`;
  preview.dataset.grabOffsetX = String(e.clientX - rect.left);
  preview.dataset.grabOffsetY = String(e.clientY - rect.top);
  preview.dataset.originLeft = String(rect.left);
  preview.dataset.originTop = String(rect.top);
  previewContext.append(preview);
  document.body.append(previewContext);
  dragPreviewContext = previewContext;
  dragPreview = preview;
  updateDragPreview(e);

  // Chrome only reliably honors setDragImage() for an element mounted in the
  // document. Keeping this transparent pixel mounted prevents its default
  // browser-tab ghost from appearing beside the custom preview.
  nativeDragImage = document.createElement('div');
  nativeDragImage.className = 'tabout-native-drag-image';
  document.body.append(nativeDragImage);
  e.dataTransfer?.setDragImage(nativeDragImage, 0, 0);
}

function removeDragPreview() {
  dragPreviewContext?.remove();
  dragPreviewContext = null;
  dragPreview = null;
  nativeDragImage?.remove();
  nativeDragImage = null;
}

async function snapBackDragPreview() {
  const preview = dragPreview;
  if (!preview?.isConnected) return;
  const originLeft = Number(preview.dataset.originLeft);
  const originTop = Number(preview.dataset.originTop);
  if (!Number.isFinite(originLeft) || !Number.isFinite(originTop)) return;
  preview.classList.add('is-snapping-back');
  try {
    await preview.animate([
      { left: preview.style.left, top: preview.style.top, transform: 'scale(1)' },
      { left: `${originLeft}px`, top: `${originTop}px`, transform: 'scale(.985)' },
    ], {
      duration: 170,
      easing: 'cubic-bezier(.22, .82, .28, 1)',
      fill: 'forwards',
    }).finished;
  } catch {
    // The preview may be removed if the dashboard refreshes concurrently.
  }
}

async function settlePocketDragPreview() {
  const preview = dragPreview;
  const destination = pocketDragSourceElements()[0];
  if (!preview?.isConnected || !destination?.isConnected) return;
  const destinationElement = dragKind === 'group'
    ? destination.querySelector('.mission-card[data-area="archive"]') || destination
    : destination;
  const destinationRect = destinationElement.getBoundingClientRect();
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 145;
  try {
    await preview.animate([
      {
        left: preview.style.left,
        top: preview.style.top,
        transform: 'scale(1)',
        opacity: 1,
      },
      {
        left: `${destinationRect.left}px`,
        top: `${destinationRect.top}px`,
        transform: 'scale(.99)',
        opacity: 1,
      },
    ], {
      duration,
      easing: 'cubic-bezier(.22, .82, .28, 1)',
      fill: 'forwards',
    }).finished;
  } catch {
    // A concurrent dashboard refresh can remove the destination or preview.
  }
}

document.addEventListener('dragstart', (e) => {
  if (e.target.closest('.chip-rename-input')) {
    e.preventDefault();
    return;
  }
  if (e.target.closest('button')) {
    e.preventDefault();
    return;
  }

  if (!e.dataTransfer) return;
  // Native drag recognition is the existing movement threshold. Once Chrome
  // crosses it, this gesture must not later resolve as a delayed click.
  cancelPendingChipActivation();
  const sourceChipForDrag = e.target.closest('.page-chip[data-action="focus-tab"]');
  if (sourceChipForDrag) suppressedChipActivations.add(sourceChipForDrag);
  const domainHandle = e.target.closest('[data-drag-domain-id]');
  const dragEl = e.target.closest(
    '.page-chip[data-drag-tab-id], .page-chip[data-drag-pocket-item-id], .page-chip[data-drag-captain-keep-id], .page-chip[data-drag-captain-pending-dead-id]',
  );
  let previewSource;
  let ids = [];
  let itemIds = [];
  let keepIds = [];
  let pendingDeadIds = [];
  draggedDuplicateRepresentativeIds = [];

  if (domainHandle && !dragEl) {
    const sourceCard = domainHandle.closest('.mission-card[data-area]');
    if (!sourceCard) return;
    const sourceGroup = groupsForArea(sourceCard.dataset.area)
      .find(group => groupCardId(group, sourceCard.dataset.area) === sourceCard.dataset.domainId);
    if (!sourceGroup) return;
    ids = sourceCard.dataset.area === 'archive'
      ? livePocketTabIds(sourceGroup.tabs)
      : normalizeTabIds(sourceGroup.tabs.map(tab => tab.id));
    itemIds = sourceCard.dataset.area === 'archive'
      ? dormantPocketItemIds(sourceGroup.tabs)
      : [];
    draggedDomainId = sourceCard.dataset.domainId;
    dragSourceArea = sourceCard.dataset.area;
    dragKind = 'group';
    previewSource = sourceCard;
  } else if (dragEl) {
    const sourceChip = dragEl.closest('.page-chip');
    const sourceCard = sourceChip?.closest('.mission-card[data-area]');
    if (!sourceChip || !sourceCard) return;
    const dormantItemId = dragEl.dataset.dragPocketItemId;
    const deadKeepId = dragEl.dataset.dragCaptainKeepId;
    const pendingDeadId = dragEl.dataset.dragCaptainPendingDeadId;
    if (deadKeepId) {
      keepIds = [deadKeepId];
    } else if (pendingDeadId) {
      pendingDeadIds = [pendingDeadId];
    } else if (dormantItemId) {
      itemIds = [dormantItemId];
    } else {
      const selectedIds = marqueeSelectedTabIdsForChip(sourceChip);
      ids = selectedIds.length > 0
        ? selectedIds
        : normalizeTabIds([Number(dragEl.dataset.dragTabId)]);
    }

    const selectedIdSet = new Set(ids);
    draggedDuplicateRepresentativeIds = normalizeTabIds([
      ...sourceCard.querySelectorAll('.page-chip.chip-has-dupes[data-tab-id]'),
    ].filter(chip => selectedIdSet.has(Number(chip.dataset.tabId)))
      .map(chip => Number(chip.dataset.tabId)));
    draggedDomainId = sourceCard.dataset.domainId;
    dragSourceArea = sourceCard.dataset.area;
    dragKind = 'tabs';
    previewSource = sourceChip.closest('.page-chip-wrapper.has-duplicate-stack') || sourceChip;
    draggedCaptainGroupKey = sourceCard.classList.contains('captain-group-card')
      && dragSourceArea === 'open'
      && captainUsesKeepArea(captainConfigForGroupKey(sourceCard.dataset.groupKey))
      ? sourceCard.dataset.groupKey || ''
      : '';
  } else {
    return;
  }

  if (ids.length === 0 && itemIds.length === 0
    && keepIds.length === 0 && pendingDeadIds.length === 0) return;
  draggedTabIds = ids;
  draggedPocketItemIds = itemIds;
  draggedCaptainKeepIds = keepIds;
  draggedCaptainPendingDeadIds = pendingDeadIds;
  captainDragEligible = draggedTabsBelongToOpenCaptainGroup();
  captainDragPreviewMoved = false;
  pocketDragPreviewMoved = false;
  pocketDragOriginalPlacements = [];
  captainDropHandled = false;
  dashboardDropHandled = false;
  cancelPendingCaptainDropPreview();
  cancelPendingPocketDropPreview();

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/tab-out-tab-ids', ids.join(','));
  e.dataTransfer.setData('text/tab-out-captain-keep-ids', keepIds.join(','));
  e.dataTransfer.setData('text/plain', ids.length > 0
    ? ids.join(',')
    : keepIds.length > 0
      ? keepIds.join(',')
      : pendingDeadIds.length > 0 ? pendingDeadIds.join(',') : itemIds.join(','));
  if (!previewSource) return;
  createDragPreview(previewSource, e, ids);
  document.body.classList.add('is-dashboard-dragging');
  const draggedIdSet = new Set(ids);
  const draggedItemIdSet = new Set(itemIds);
  const draggedKeepIdSet = new Set(keepIds);
  const draggedPendingDeadIdSet = new Set(pendingDeadIds);
  // Hide only the live dashboard rows. The multi-preview contains clones
  // with the same tab ids and must remain visible.
  document.querySelectorAll(
    '.container .page-chip[data-tab-id], .container .page-chip[data-pocket-item-id], .container .page-chip[data-captain-keep-id], .container .page-chip[data-captain-pending-dead-id]',
  ).forEach(chip => {
    if (draggedIdSet.has(Number(chip.dataset.tabId))
      || draggedItemIdSet.has(chip.dataset.pocketItemId)
      || draggedKeepIdSet.has(chip.dataset.captainKeepId)
      || draggedPendingDeadIdSet.has(chip.dataset.captainPendingDeadId)) {
      chip.classList.add('is-dragging');
      chip.closest('.page-chip-wrapper.has-duplicate-stack')?.classList.add('is-dragging');
    }
  });
  if (dragKind === 'group') previewSource.classList.add('is-dragging');
  if (dragSourceArea === 'archive') recordPocketDragPlacements();
  dragDebugStartedAt = performance.now();
  lastDragDebugZone = '';
  traceDragDebug('drag-start', {
    dragKind,
    dragSourceArea,
    draggedTabIds,
    draggedPocketItemIds,
    draggedCaptainKeepIds,
    draggedCaptainPendingDeadIds,
    draggedDomainId,
    draggedCaptainGroupKey,
    clientX: e.clientX,
    clientY: e.clientY,
  });
});

async function finishDashboardDrag(trigger = 'unknown') {
  if (dashboardDragCleanupPromise) {
    traceDragDebug('cleanup-join', { trigger });
    return dashboardDragCleanupPromise;
  }
  dashboardDragCleanupPromise = (async () => {
    const shouldRestoreCaptainOrder = captainDragPreviewMoved && !captainDropHandled;
    const shouldRestorePocketOrder = pocketDragPreviewMoved && !dashboardDropHandled;
    const shouldSettlePocketPreview = pocketDragPreviewMoved
      && dashboardDropHandled
      && dragSourceArea === 'archive';
    const shouldSnapBack = Boolean(dragPreview && !captainDropHandled && !dashboardDropHandled);
    traceDragDebug('cleanup-start', {
      trigger,
      shouldSnapBack,
      shouldRestoreCaptainOrder,
      shouldSettlePocketPreview,
      previewExists: Boolean(dragPreview),
      captainDropHandled,
      dashboardDropHandled,
    });
    cancelPendingCaptainDropPreview();
    cancelPendingPocketDropPreview();
    clearDropHighlights();
    if (shouldSnapBack) await snapBackDragPreview();
    if (shouldRestorePocketOrder) restorePocketDragPreview();
    if (shouldSettlePocketPreview) await settlePocketDragPreview();
    document.querySelectorAll('.is-dragging').forEach(el => el.classList.remove('is-dragging'));
    draggedTabIds = [];
    draggedCaptainKeepIds = [];
    draggedCaptainPendingDeadIds = [];
    draggedPocketItemIds = [];
    draggedDuplicateRepresentativeIds = [];
    draggedCaptainGroupKey = '';
    draggedDomainId = '';
    dragSourceArea = '';
    dragKind = '';
    captainDragEligible = false;
    captainDragPreviewMoved = false;
    pocketDragPreviewMoved = false;
    pocketDragOriginalPlacements = [];
    captainDropHandled = false;
    dashboardDropHandled = false;
    removeDragPreview();
    document.body.classList.remove('is-dashboard-dragging');
    if (shouldRestoreCaptainOrder) {
      renderDashboard().catch(error => {
        console.warn('[tab-out] Could not restore the Captain order after a cancelled drag:', error);
      });
    }
    traceDragDebug('cleanup-complete', {
      trigger,
      snappedBack: shouldSnapBack,
      previewExists: Boolean(dragPreview),
    });
  })();
  try {
    await dashboardDragCleanupPromise;
  } finally {
    dashboardDragCleanupPromise = null;
    lastDragDebugZone = '';
    dragDebugStartedAt = null;
  }
}

document.addEventListener('dragend', event => {
  traceDragDebug('dragend-received', {
    dropEffect: event.dataTransfer?.dropEffect || '',
    previewExists: Boolean(dragPreview),
    captainDropHandled,
    dashboardDropHandled,
  });
  void finishDashboardDrag('dragend');
});

function dashboardDropAreaAtPoint(target, clientX, clientY) {
  const pocketSection = document.getElementById('archiveSection');
  const pocketSurface = document.getElementById('archiveDropZone') || pocketSection;
  if (dragSourceArea === 'archive'
    && pocketSection
    && pocketSurface
    && getComputedStyle(pocketSection).display !== 'none') {
    const rect = pocketSurface.getBoundingClientRect();
    const remainsInPocket = clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top && clientY <= rect.bottom;
    // Once an archived item leaves the visible Pocket surface, any in-page
    // release means Restore—even over headers, controls, or surrounding space.
    return remainsInPocket ? 'archive' : 'open';
  }

  const direct = target instanceof Element
    ? target.closest('#openTabsSection, #archiveSection')
    : null;
  if (direct) return direct.id === 'archiveSection' ? 'archive' : 'open';
  const pocket = pocketSection;
  if (pocket && getComputedStyle(pocket).display !== 'none') {
    const rect = pocket.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top && clientY <= rect.bottom) return 'archive';

  }
  const open = document.getElementById('openTabsSection');
  if (open) {
    const rect = open.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) return 'open';
  }
  return '';
}

async function persistPocketManualOrder() {
  await chrome.storage.local.set({
    [POCKET_GROUP_ORDER_KEY]: pocketGroupOrder,
    [POCKET_TAB_ORDER_KEY]: pocketTabOrder,
  });
}

function nearestPocketElement(elements, clientY) {
  return elements.reduce((nearest, element) => {
    const rect = element.getBoundingClientRect();
    const distance = Math.abs(clientY - (rect.top + rect.height / 2));
    return !nearest || distance < nearest.distance ? { element, distance } : nearest;
  }, null)?.element || null;
}

function pocketGroupDropCard(target, clientY) {
  const direct = target instanceof Element
    ? target.closest('.mission-card[data-area="archive"]')
    : null;
  if (direct) return direct;
  return nearestPocketElement([
    ...document.querySelectorAll('.mission-card[data-area="archive"]'),
  ], clientY);
}

function pocketTabDropTarget(target, clientY, sourceCard) {
  if (!sourceCard) return null;
  const directCard = target instanceof Element
    ? target.closest('.mission-card[data-area="archive"]')
    : null;
  if (directCard !== sourceCard) return null;
  const directChip = target.closest('.page-chip[data-tab-id], .page-chip[data-pocket-item-id]');
  if (directChip && !directChip.classList.contains('is-dragging')) return directChip;
  return nearestPocketElement([
    ...sourceCard.querySelectorAll(
      '.page-chip:not(.is-dragging)[data-tab-id], .page-chip:not(.is-dragging)[data-pocket-item-id]',
    ),
  ], clientY);
}

function pocketDragSourceElements() {
  if (dragSourceArea !== 'archive') return [];
  const sourceCard = document.querySelector(
    `.mission-card[data-area="archive"][data-domain-id="${CSS.escape(draggedDomainId)}"]`,
  );
  if (!sourceCard) return [];
  if (dragKind === 'group') return [sourceCard.closest('.domain-card-shell')].filter(Boolean);
  const tabIds = new Set(draggedTabIds);
  const itemIds = new Set(draggedPocketItemIds);
  return [...sourceCard.querySelectorAll('.page-chip[data-tab-id], .page-chip[data-pocket-item-id]')]
    .filter(chip => tabIds.has(Number(chip.dataset.tabId)) || itemIds.has(chip.dataset.pocketItemId))
    .map(chipRowElement);
}

function recordPocketDragPlacements() {
  pocketDragOriginalPlacements = pocketDragSourceElements()
    .map(element => ({ element, parent: element.parentElement, nextSibling: element.nextSibling }));
}

function pocketDropContextAtPoint(target, clientY) {
  if (dragSourceArea !== 'archive') return null;
  const sourceElements = pocketDragSourceElements();
  if (sourceElements.length === 0) return null;
  const targetCard = pocketGroupDropCard(target, clientY);
  if (!targetCard) return null;

  if (dragKind === 'group') {
    const sourceGroup = archivedDomainGroups.find(group => groupCardId(group, 'archive') === draggedDomainId);
    if (!sourceGroup || isCaptainGroupKey(sourceGroup.domain)) return null;
    const targetShell = targetCard.closest('.domain-card-shell');
    const targetGroup = archivedDomainGroups.find(group => groupCardId(group, 'archive') === targetCard.dataset.domainId);
    if (!targetShell || !targetGroup || targetGroup === sourceGroup) return null;
    const targetIsCaptain = isCaptainGroupKey(targetGroup.domain);
    const insertAfter = targetIsCaptain
      || clientY >= targetCard.getBoundingClientRect().top + targetCard.offsetHeight / 2;
    const firstMovableShell = targetIsCaptain
      ? [...targetShell.parentElement.children].find(shell => {
        const card = shell.querySelector('.mission-card[data-area="archive"]');
        const group = card && archivedDomainGroups.find(item =>
          groupCardId(item, 'archive') === card.dataset.domainId);
        return group && !isCaptainGroupKey(group.domain);
      })
      : null;
    return {
      sourceElements,
      targetParent: targetShell.parentElement,
      beforeElement: targetIsCaptain
        ? firstMovableShell || null
        : insertAfter ? targetShell.nextElementSibling : targetShell,
      marker: targetCard,
      insertAfter,
    };
  }

  const sourceCard = sourceElements[0].closest('.mission-card[data-area="archive"]');
  const targetChip = pocketTabDropTarget(target, clientY, sourceCard);
  if (!targetChip || targetCard !== sourceCard) return null;
  const targetRow = chipRowElement(targetChip);
  const insertAfter = clientY >= targetChip.getBoundingClientRect().top + targetChip.offsetHeight / 2;
  return {
    sourceElements,
    targetParent: targetRow.parentElement,
    beforeElement: insertAfter ? targetRow.nextElementSibling : targetRow,
    marker: targetChip,
    insertAfter,
  };
}

function animatePocketReflow(elements, previousRects) {
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 150;
  for (const element of elements) {
    const previousAnimation = pocketReflowAnimations.get(element);
    previousAnimation?.cancel();
    const previousRect = previousRects.get(element);
    const nextRect = element.getBoundingClientRect();
    const dx = previousRect.left - nextRect.left;
    const dy = previousRect.top - nextRect.top;
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5) continue;
    const animation = element.animate([
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: 'translate(0, 0)' },
    ], { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    pocketReflowAnimations.set(element, animation);
    animation.addEventListener('finish', () => {
      if (pocketReflowAnimations.get(element) === animation) pocketReflowAnimations.delete(element);
    }, { once: true });
  }
}

function previewPocketReorder(dropContext) {
  const { sourceElements, targetParent, beforeElement } = dropContext;
  if (!targetParent) return false;
  const siblings = [...targetParent.children];
  const insertionIndex = beforeElement ? siblings.indexOf(beforeElement) : siblings.length;
  const preceding = siblings.slice(Math.max(0, insertionIndex - sourceElements.length), insertionIndex);
  const alreadyPlaced = sourceElements.every(element => element.parentElement === targetParent)
    && preceding.length === sourceElements.length
    && preceding.every((element, index) => element === sourceElements[index]);
  if (alreadyPlaced) return false;

  const movingElements = siblings.filter(element => !sourceElements.includes(element) && element.offsetHeight > 0);
  const previousRects = new Map(movingElements.map(element => [element, element.getBoundingClientRect()]));
  const previousPlacements = sourceElements.map(element => [element.parentElement, element.nextSibling]);
  for (const sourceElement of sourceElements) targetParent.insertBefore(sourceElement, beforeElement);
  if (previousPlacements.some(([parent, nextSibling], index) =>
    parent !== sourceElements[index].parentElement || nextSibling !== sourceElements[index].nextSibling)) {
    pocketDragPreviewMoved = true;
  }
  animatePocketReflow(movingElements, previousRects);
  return true;
}

function updatePocketDropPreview(target, clientY) {
  const dropContext = pocketDropContextAtPoint(target, clientY);
  if (!dropContext) return;
  document.querySelectorAll('.is-pocket-reorder-before, .is-pocket-reorder-after')
    .forEach(element => element.classList.remove('is-pocket-reorder-before', 'is-pocket-reorder-after'));
  previewPocketReorder(dropContext);
  dropContext.marker.classList.add(dropContext.insertAfter
    ? 'is-pocket-reorder-after'
    : 'is-pocket-reorder-before');
}

function schedulePocketDropPreview(target, clientY) {
  pendingPocketDragPoint = { target, clientY };
  if (pocketDragFrame !== null) return;
  pocketDragFrame = requestAnimationFrame(() => {
    pocketDragFrame = null;
    const point = pendingPocketDragPoint;
    pendingPocketDragPoint = null;
    if (point) updatePocketDropPreview(point.target, point.clientY);
  });
}

function cancelPendingPocketDropPreview() {
  if (pocketDragFrame !== null) cancelAnimationFrame(pocketDragFrame);
  pocketDragFrame = null;
  pendingPocketDragPoint = null;
}

function restorePocketDragPreview() {
  if (!pocketDragPreviewMoved) return;
  const moved = pocketDragOriginalPlacements.map(({ element }) => element).filter(element => element.isConnected);
  const siblings = [...new Set(pocketDragOriginalPlacements.flatMap(({ parent }) =>
    parent ? [...parent.children] : []).filter(element => !moved.includes(element) && element.offsetHeight > 0))];
  const previousRects = new Map(siblings.map(element => [element, element.getBoundingClientRect()]));
  for (const { element, parent, nextSibling } of pocketDragOriginalPlacements) {
    if (parent?.isConnected) parent.insertBefore(element, nextSibling);
  }
  animatePocketReflow(siblings, previousRects);
}

async function reorderPocketDrop(target, clientY) {
  // A very quick release can happen before the scheduled dragover frame. Run
  // that final preview synchronously so the drop still has a real destination
  // placeholder to settle into.
  if (!pocketDragPreviewMoved) {
    const finalDropContext = pocketDropContextAtPoint(target, clientY);
    if (finalDropContext) previewPocketReorder(finalDropContext);
  }

  // The live preview has already moved the invisible source rows. Read that
  // order back from the Pocket DOM so release never causes a second jump.
  if (pocketDragPreviewMoved) {
    // Native dragend does not wait for this async persistence. Claim the drop
    // before the first await so cleanup performs the destination settle rather
    // than briefly snapping the preview back to its origin.
    dashboardDropHandled = true;
    beginDashboardRefreshSuppression();
    try {
      if (dragKind === 'group') {
        pocketGroupOrder = [...document.querySelectorAll('#archiveTabs > .domain-card-shell .mission-card[data-area="archive"]')]
          .map(card => archivedDomainGroups.find(group => groupCardId(group, 'archive') === card.dataset.domainId))
          .filter(group => group && !isCaptainGroupKey(group.domain))
          .map(group => group.domain);
      } else {
        const sourceGroup = archivedDomainGroups.find(group => groupCardId(group, 'archive') === draggedDomainId);
        const sourceCard = document.querySelector(
          `.mission-card[data-area="archive"][data-domain-id="${CSS.escape(draggedDomainId)}"]`,
        );
        if (!sourceGroup || !sourceCard) return false;
        const sourceKeys = [...sourceCard.querySelectorAll('.page-chip[data-tab-id], .page-chip[data-pocket-item-id]')]
          .map(chip => chip.dataset.pocketItemId || Number(chip.dataset.tabId));
        pocketTabOrder = archivedDomainGroups.flatMap(group => group === sourceGroup
          ? sourceKeys
          : group.tabs.map(pocketOrderKey));
        await requestPocketStateMutation('set-order', [], pocketTabOrder.filter(id => typeof id === 'string'));
      }
      await persistPocketManualOrder();
    } finally {
      // The Pocket state write can queue a dashboard refresh. Let the final
      // FLIP settle first, then discard that self-originated refresh because
      // the DOM already is the committed order.
      setTimeout(() => {
        cancelScheduledDashboardRefresh();
        endDashboardRefreshSuppression();
      }, 180);
    }
    stableGroupDomains.archive = [];
    return true;
  }

  const targetCard = pocketGroupDropCard(target, clientY);
  if (!targetCard) return false;

  if (dragKind === 'group') {
    const sourceGroup = archivedDomainGroups.find(group => groupCardId(group, 'archive') === draggedDomainId);
    const targetGroup = archivedDomainGroups.find(group =>
      groupCardId(group, 'archive') === targetCard.dataset.domainId);
    if (!sourceGroup || !targetGroup || sourceGroup === targetGroup
      || isCaptainGroupKey(sourceGroup.domain)) return false;
    const movable = archivedDomainGroups
      .filter(group => !isCaptainGroupKey(group.domain))
      .map(group => group.domain)
      .filter(key => key !== sourceGroup.domain);
    const targetIsCaptain = isCaptainGroupKey(targetGroup.domain);
    const targetIndex = targetIsCaptain ? 0 : Math.max(0, movable.indexOf(targetGroup.domain));
    const insertAfter = !targetIsCaptain
      && clientY >= targetCard.getBoundingClientRect().top + targetCard.offsetHeight / 2;
    movable.splice(targetIndex + (insertAfter ? 1 : 0), 0, sourceGroup.domain);
    pocketGroupOrder = movable;
  } else {
    const sourceGroup = archivedDomainGroups.find(group => groupCardId(group, 'archive') === draggedDomainId);
    const sourceCard = document.querySelector(
      `.mission-card[data-area="archive"][data-domain-id="${CSS.escape(draggedDomainId)}"]`,
    );
    const targetChip = pocketTabDropTarget(target, clientY, sourceCard);
    const targetGroup = archivedDomainGroups.find(group =>
      groupCardId(group, 'archive') === targetCard.dataset.domainId);
    if (!targetChip || !sourceGroup || sourceGroup !== targetGroup) return false;
    const targetId = targetChip.dataset.pocketItemId || Number(targetChip.dataset.tabId);
    const dragged = new Set(draggedTabIds);
    const draggedOrderKeys = archivedDomainGroups.flatMap(group => group.tabs)
      .filter(tab => dragged.has(tab.id))
      .map(pocketOrderKey)
      .concat(draggedPocketItemIds);
    const ordered = archivedDomainGroups.flatMap(group => group.tabs.map(pocketOrderKey))
      .filter(id => !draggedOrderKeys.includes(id));
    const targetIndex = Math.max(0, ordered.indexOf(targetId));
    const insertAfter = clientY >= targetChip.getBoundingClientRect().top + targetChip.offsetHeight / 2;
    ordered.splice(targetIndex + (insertAfter ? 1 : 0), 0, ...draggedOrderKeys);
    pocketTabOrder = ordered;
    dashboardDropHandled = true;
    await requestPocketStateMutation('set-order', [], ordered.filter(id => typeof id === 'string'));
  }

  dashboardDropHandled = true;
  await persistPocketManualOrder();
  stableGroupDomains.archive = [];
  await renderDashboard();
  return true;
}

document.addEventListener('dragover', (e) => {
  updateDragPreview(e);
  const dashboardDragActive = Boolean(dragKind
    && (draggedTabIds.length > 0 || draggedPocketItemIds.length > 0
      || draggedCaptainKeepIds.length > 0 || draggedCaptainPendingDeadIds.length > 0));
  if (dashboardDragActive) {
    // Accept the native transport everywhere inside the dashboard so Chrome
    // dispatches `drop` immediately on release. The drop handler still owns
    // semantic validation and snaps an illegal target back without mutation.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
  const captainCard = captainCardAtPoint(e.target, e.clientX, e.clientY);
  if (captainCard) {
    const zone = `captain:${captainCard.dataset.groupKey || ''}`;
    if (zone !== lastDragDebugZone) {
      lastDragDebugZone = zone;
      traceDragDebug('zone-change', {
        zone,
        legal: true,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    cancelPendingPocketDropPreview();
    scheduleCaptainDropPreview(captainCard, e.clientX, e.clientY);
    return;
  }

  cancelPendingCaptainDropPreview();
  clearDropHighlights();
  const dropArea = dashboardDropAreaAtPoint(e.target, e.clientX, e.clientY);
  const legal = Boolean(dropArea && (dropArea !== dragSourceArea || dropArea === 'archive'));
  const zone = legal ? `dashboard:${dropArea}` : `illegal:${dropArea || 'outside'}`;
  if (zone !== lastDragDebugZone) {
    lastDragDebugZone = zone;
    traceDragDebug('zone-change', {
      zone,
      legal,
      dropArea: dropArea || null,
      dragSourceArea,
      clientX: e.clientX,
      clientY: e.clientY,
    });
  }
  if (legal) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropArea === 'archive' && dragSourceArea === 'archive') {
      schedulePocketDropPreview(e.target, e.clientY);
    } else {
      cancelPendingPocketDropPreview();
    }
  } else {
    cancelPendingPocketDropPreview();
  }
});

document.addEventListener('dragleave', (e) => {
  const captainCard = e.target.closest('.captain-group-card[data-area="open"]');
  if (captainCard) {
    if (!captainCard.contains(e.relatedTarget)) {
      cancelPendingCaptainDropPreview();
      captainCard.classList.remove('is-captain-drop-target');
      captainCard.style.removeProperty('--captain-drop-indicator-top');
      delete captainCard.dataset.captainDropDestination;
    }
  }
});

document.addEventListener('drop', async (e) => {
  traceDragDebug('drop-received', {
    clientX: e.clientX,
    clientY: e.clientY,
    dragKind,
    dragSourceArea,
    previewExists: Boolean(dragPreview),
  });
  cancelPendingCaptainDropPreview();
  cancelPendingPocketDropPreview();
  const captainDrop = captainDropContext(e);
  if (captainDrop) {
    traceDragDebug('drop-resolve', {
      result: 'captain',
      destination: captainDrop.destination,
      groupKey: captainDrop.card.dataset.groupKey || '',
    });
    e.preventDefault();
    const ids = tabIdsFromDragEvent(e);
    const deadKeepIds = [...draggedCaptainKeepIds];
    const pendingDeadIds = [...draggedCaptainPendingDeadIds];
    const duplicateRepresentativeIds = [...draggedDuplicateRepresentativeIds];
    const captainGroup = domainGroups.find(group => group.domain === captainDrop.card.dataset.groupKey);
    captainDropHandled = true;
    dashboardDropHandled = true;
    draggedTabIds = [];
    draggedCaptainGroupKey = '';
    captainDragEligible = false;
    removeDragPreview();
    clearDropHighlights();
    if (pendingDeadIds.length > 0) {
      if (captainDrop.destination === 'retained') {
        const result = await dedupeDeadCaptainDropToKeep(
          pendingDeadIds[0],
          captainDrop.beforeKeepId,
        );
        if (!result) {
          await requestCaptainKeepLifecycle('keep-pending-dead', {
            keepItem: {
              pendingItemId: pendingDeadIds[0],
              beforeKeepId: captainDrop.beforeKeepId,
            },
          });
        }
        draggedCaptainPendingDeadIds = [];
        if (result?.removedCount > 0) playCloseSound();
        await renderDashboard();
        if (result?.removedCount > 0) {
          showToast(uiText(
            `Removed ${result.removedCount} duplicate${result.removedCount === 1 ? '' : 's'}; kept one in Keep`,
            `已移除 ${result.removedCount} 个重复项，并在保留区保留一项`,
          ));
        }
        return;
      }
      previewCaptainReorder(captainDrop);
      const orderedPendingDeadIds = [...captainDrop.card.querySelectorAll(
        '.captain-subgroup-pending .page-chip[data-captain-pending-dead-id]',
      )].map(chip => chip.dataset.captainPendingDeadId).filter(Boolean);
      const pendingSequence = [...captainDrop.card.querySelectorAll(
        '.captain-subgroup-pending .page-chip[data-tab-id], .captain-subgroup-pending .page-chip[data-captain-pending-dead-id]',
      )];
      const placements = orderedPendingDeadIds.map(id => {
        const itemIndex = pendingSequence.findIndex(chip => chip.dataset.captainPendingDeadId === id);
        const nextLive = itemIndex >= 0
          ? pendingSequence.slice(itemIndex + 1).find(chip => Number.isInteger(Number(chip.dataset.tabId)))
          : null;
        return { id, beforeTabId: nextLive ? Number(nextLive.dataset.tabId) : null };
      });
      await requestCaptainKeepLifecycle('reorder-pending-dead', {
        keepItem: { orderedPendingDeadIds, placements },
      });
      draggedCaptainPendingDeadIds = [];
      document.querySelectorAll('.is-dragging').forEach(element => {
        element.classList.remove('is-dragging');
      });
      captainDragPreviewMoved = false;
      return;
    }
    if (deadKeepIds.length > 0) {
      if (captainDrop.destination === 'pending') {
        const keepId = deadKeepIds[0];
        const keepEntry = captainKeepItemSnapshot(keepId);
        const response = await requestCaptainKeepLifecycle('unkeep-dead', {
          keepId,
          keepItem: {
            beforeTabId: captainDrop.beforeTabId,
            beforePendingDeadId: captainDrop.beforePendingDeadId,
          },
        });
        if (keepEntry && response.lifecycleItem) {
          await pushUndoEntry({
            type: 'captain-pending-dead-lifecycle',
            transition: 'unkeep',
            keepEntry,
            pendingItem: response.lifecycleItem,
          });
        }
        draggedCaptainKeepIds = [];
        await renderDashboard();
        showToast(uiText('Moved dead Keep tab to Pending', '已将 dead Keep 标签页移到待处理区'));
        return;
      }
      const beforeOrder = (captainKeepManifestSnapshot?.tabs || []).map(item => item.keepId);
      previewCaptainReorder(captainDrop);
      const orderedCardKeepIds = [...captainDrop.card.querySelectorAll(
        '.captain-subgroup-retained .page-chip[data-captain-keep-id]',
      )].map(chip => chip.dataset.captainKeepId).filter(Boolean);
      const visibleCardIds = new Set(orderedCardKeepIds);
      const firstVisibleIndex = beforeOrder.findIndex(id => visibleCardIds.has(id));
      const orderedKeepIds = beforeOrder.filter(id => !visibleCardIds.has(id));
      const insertionIndex = firstVisibleIndex < 0
        ? orderedKeepIds.length
        : beforeOrder.slice(0, firstVisibleIndex).filter(id => !visibleCardIds.has(id)).length;
      orderedKeepIds.splice(insertionIndex, 0, ...orderedCardKeepIds);
      await requestCaptainKeepLifecycle('reorder', {
        keepItem: { orderedKeepIds },
      });
      if (orderedKeepIds.some((id, index) => id !== beforeOrder[index])) {
        await pushUndoEntry({ type: 'captain-keep-order', before: beforeOrder, after: orderedKeepIds });
      }
      draggedCaptainKeepIds = [];
      document.querySelectorAll('.is-dragging').forEach(element => {
        element.classList.remove('is-dragging');
      });
      captainDragPreviewMoved = false;
      return;
    }
    draggedCaptainKeepIds = [];
    if (captainDrop.destination === 'retained') {
      const result = await dedupeLiveCaptainDropToKeep(
        ids,
        duplicateRepresentativeIds,
        captainDrop.beforeTabId,
        captainGroup,
      );
      if (result) {
        if (result.removedCount > 0) playCloseSound();
        await renderDashboard();
        if (result.removedCount > 0) {
          showToast(uiText(
            `Removed ${result.removedCount} duplicate${result.removedCount === 1 ? '' : 's'}; kept the dragged tab in Keep`,
            `已移除 ${result.removedCount} 个重复项，并在保留区保留拖入项`,
          ));
        }
        return;
      }
    }
    const changes = await moveCaptainTabsToSubgroup(
      ids,
      captainDrop.destination,
      captainDrop.beforeTabId,
      captainGroup,
    );
    if (changes.length === 0) {
      await renderDashboard();
      return;
    }

    await renderDashboard();
    return;
  }

  const dropArea = dashboardDropAreaAtPoint(e.target, e.clientX, e.clientY);
  const dashboardDragActive = Boolean(dragSourceArea
    && (draggedTabIds.length > 0 || draggedPocketItemIds.length > 0
      || draggedCaptainKeepIds.length > 0 || draggedCaptainPendingDeadIds.length > 0));
  traceDragDebug('drop-resolve', {
    result: !dashboardDragActive
      ? 'inactive'
      : !dropArea
        ? 'illegal'
        : dropArea === dragSourceArea && dropArea !== 'archive'
          ? 'illegal-same-area'
          : dropArea,
    dropArea: dropArea || null,
    dashboardDragActive,
  });
  if (!dropArea || !dashboardDragActive) {
    if (dashboardDragActive) {
      e.preventDefault();
      await finishDashboardDrag('drop-invalid');
    }
    return;
  }
  e.preventDefault();

  if (dropArea === 'archive' && dragSourceArea === 'archive') {
    const reordered = await reorderPocketDrop(e.target, e.clientY);
    if (!reordered) await finishDashboardDrag('drop-invalid-pocket-reorder');
    return;
  }
  if (dropArea === dragSourceArea) {
    await finishDashboardDrag('drop-invalid-same-area');
    return;
  }

  const deadKeepIds = [...draggedCaptainKeepIds];
  const pendingDeadIds = [...draggedCaptainPendingDeadIds];
  if (dropArea === 'archive' && (deadKeepIds.length > 0 || pendingDeadIds.length > 0)) {
    dashboardDropHandled = true;
    removeDragPreview();
    clearDropHighlights();
    document.body.classList.remove('is-dashboard-dragging');
    const result = await moveDeadCaptainItemToPocket({
      keepId: deadKeepIds[0] || '',
      pendingItemId: pendingDeadIds[0] || '',
    });
    if (!result.moved) return;
    draggedCaptainKeepIds = [];
    draggedCaptainPendingDeadIds = [];
    await renderDashboard();
    showToast(result.removedDuplicateCount > 0
      ? uiText(
        `Removed ${result.removedDuplicateCount} duplicate${result.removedDuplicateCount === 1 ? '' : 's'}; kept the new dead tab in Pocket`,
        `已移除 ${result.removedDuplicateCount} 个重复项，并在「口袋」保留新移入的 dead 标签页`,
      )
      : uiText('Moved dead tab to Pocket', '已将 dead 标签页移到「口袋」'));
    return;
  }

  const ids = [...draggedTabIds];
  const itemIds = [...draggedPocketItemIds];
  const duplicateRepresentativeIds = dropArea === 'archive'
    ? [...draggedDuplicateRepresentativeIds]
    : [];
  dashboardDropHandled = true;
  removeDragPreview();
  clearDropHighlights();
  document.body.classList.remove('is-dashboard-dragging');
  // A duplicate-indicated chip represents one canonical tab. Remove its live
  // same-URL copies and archive that canonical tab as one drop interaction.
  const { changes, closedDuplicates } = dropArea === 'archive'
    ? await archiveTabsWithIndicatedDedup(ids, duplicateRepresentativeIds)
    : {
      changes: [
        ...await changeArchiveMembershipWithUndo(ids, false),
        ...await restoreDormantPocketItems(itemIds),
      ],
      closedDuplicates: [],
    };
  if (changes.length === 0 && closedDuplicates.length === 0) return;
  await renderDashboard();
  showToast(dropArea === 'archive' && closedDuplicates.length > 0
    ? uiText(
      `Removed ${closedDuplicates.length} duplicate tab${closedDuplicates.length === 1 ? '' : 's'} and put ${changes.length === 1 ? 'one tab' : `${changes.length} tabs`} in Pocket`,
      `已去除 ${closedDuplicates.length} 个重复标签页，并将${changes.length === 1 ? '一份' : `${changes.length} 份`}扔进「口袋」`,
    )
    : dropArea === 'archive'
      ? uiText(
        `Put ${changes.length} tab${changes.length === 1 ? '' : 's'} in Pocket`,
        `已将 ${changes.length} 个扔进「口袋」`,
      )
      : pocketRestoreToastMessage(changes.length));
});

let dashboardRefreshTimer = null;
let dashboardRefreshSuppressionDepth = 0;
let dashboardRefreshPending = false;
const locallyClosingTabIds = new Set();
const recentlyClosedTabIds = new Set();
let locallyClosingTabCleanupTimer = null;

function markTabsForLocalClose(tabIds) {
  normalizeTabIds(tabIds).forEach(tabId => {
    locallyClosingTabIds.add(tabId);
    recentlyClosedTabIds.add(tabId);
  });
  clearTimeout(locallyClosingTabCleanupTimer);
  locallyClosingTabCleanupTimer = setTimeout(() => {
    locallyClosingTabIds.clear();
    recentlyClosedTabIds.clear();
    locallyClosingTabCleanupTimer = null;
  }, 2000);
}

function unmarkTabsForLocalClose(tabIds) {
  normalizeTabIds(tabIds).forEach(tabId => {
    locallyClosingTabIds.delete(tabId);
    recentlyClosedTabIds.delete(tabId);
  });
}

function onlyRemovesRecentlyClosedErrorSignals(change) {
  const oldRecords = change?.oldValue && typeof change.oldValue === 'object'
    ? change.oldValue
    : {};
  const newRecords = change?.newValue && typeof change.newValue === 'object'
    ? change.newValue
    : {};
  const removedKeys = Object.keys(oldRecords)
    .filter(key => !Object.prototype.hasOwnProperty.call(newRecords, key));
  if (removedKeys.length === 0
    || Object.keys(newRecords).some(key => !Object.prototype.hasOwnProperty.call(oldRecords, key))) {
    return false;
  }

  for (const key of removedKeys) {
    const tabId = Number(key);
    if (!recentlyClosedTabIds.has(tabId)) return false;
  }
  return true;
}

function cancelScheduledDashboardRefresh() {
  clearTimeout(dashboardRefreshTimer);
  dashboardRefreshTimer = null;
  dashboardRefreshPending = false;
}

function beginDashboardRefreshSuppression() {
  dashboardRefreshSuppressionDepth += 1;
  if (dashboardRefreshTimer !== null) {
    clearTimeout(dashboardRefreshTimer);
    dashboardRefreshTimer = null;
  }
}

function endDashboardRefreshSuppression() {
  dashboardRefreshSuppressionDepth = Math.max(0, dashboardRefreshSuppressionDepth - 1);
  if (dashboardRefreshSuppressionDepth === 0 && dashboardRefreshPending) {
    // A local mutation patches the visible model first. This delayed pass
    // reconciles any worker-owned state that changed concurrently.
    clearTimeout(dashboardRefreshTimer);
    dashboardRefreshTimer = setTimeout(runScheduledDashboardRefresh, 100);
  }
}

function runScheduledDashboardRefresh() {
  traceCaptainKeepRevive('scheduled-refresh-run', {
    refreshPending: dashboardRefreshPending,
    suppressionDepth: dashboardRefreshSuppressionDepth,
  });
  dashboardRefreshTimer = null;
  dashboardRefreshPending = false;
  if (dashboardRenderInFlight) {
    dashboardRenderRequested = true;
    return;
  }
  // Browser events should become visible from Chrome's live tab list and the
  // latest cached state immediately. Worker-backed reconciliation follows in
  // the background and can no longer hold the visible update hostage.
  renderCachedDashboard().catch(err => {
    console.warn('[tab-out] Could not apply the fast dashboard refresh:', err);
  }).finally(() => {
    void renderDashboard().catch(err => {
      console.warn('[tab-out] Could not reconcile dashboard state:', err);
    });
  });
}

function scheduleDashboardRefresh() {
  dashboardRefreshPending = true;
  traceCaptainKeepRevive('refresh-requested', {
    suppressionDepth: dashboardRefreshSuppressionDepth,
    timerAlreadyScheduled: dashboardRefreshTimer !== null,
  });
  if (dashboardRefreshSuppressionDepth > 0) return;
  clearTimeout(dashboardRefreshTimer);
  dashboardRefreshTimer = setTimeout(runScheduledDashboardRefresh, 100);
}

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (captainKeepDedupTrace
    && captainKeepDedupTrace.targetTabIds.includes(tabId)) {
    traceCaptainKeepDedup('tabs-onRemoved', {
      tabId,
      windowId: removeInfo?.windowId,
      isWindowClosing: Boolean(removeInfo?.isWindowClosing),
      locallyClosing: locallyClosingTabIds.has(tabId),
    });
  }
  traceCaptainKeep('event:tab-removed', {
    tabId,
    windowId: removeInfo?.windowId,
    isWindowClosing: Boolean(removeInfo?.isWindowClosing),
    locallyClosing: locallyClosingTabIds.has(tabId),
  });
  if (removeInfo?.isWindowClosing) {
    // CRITICAL KEEP INVARIANT: during browser/window teardown the shrinking
    // live-tab list is not the user's new Keep selection. Stop any queued
    // render and preserve the URL manifest for the next Chrome session.
    guardCaptainManifestDuringWindowClose();
    cancelScheduledDashboardRefresh();
    traceCaptainKeep('event:window-close-guarded', { tabId });
    return;
  }
  // The initiating close workflow performs one authoritative render after
  // storing its undo entry; ignore its per-tab event burst here.
  if (locallyClosingTabIds.delete(tabId)) return;
  if (patchExternallyClosedCaptainKeepTab(tabId)) return;
  if (removeClosedCaptainTabWithoutCardRender(tabId)) return;
  scheduleDashboardRefresh();
});

window.addEventListener('pagehide', () => {
  // Covers reload/quit timing where the dashboard begins unloading before its
  // own chrome.tabs.onRemoved callback can run.
  guardCaptainManifestDuringWindowClose();
  cancelScheduledDashboardRefresh();
  traceCaptainKeep('event:pagehide-guarded', {});
});
chrome.tabs.onAttached.addListener(scheduleDashboardRefresh);
chrome.tabs.onDetached.addListener(scheduleDashboardRefresh);
chrome.tabs.onCreated.addListener(scheduleDashboardRefresh);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (captainKeepReviveTrace?.createdTabId === tabId) {
    traceCaptainKeepRevive('tab-updated', { tabId, changeInfo });
  }
  if (recentlyRevivedCaptainTabIds.has(tabId)) return;
  if (Object.prototype.hasOwnProperty.call(changeInfo, 'url')
    || Object.prototype.hasOwnProperty.call(changeInfo, 'title')
    || changeInfo.status === 'complete') {
    if (captainLifecycleMutationDepth === 0
      && recentlyRevivedCaptainTabIds.size === 0
      && Date.now() > captainLifecycleRefreshSuppressedUntil) scheduleDashboardRefresh();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local'
    && Object.prototype.hasOwnProperty.call(changes, DAILY_QUOTES_ENABLED_KEY)) {
    dailyQuotesEnabled = changes[DAILY_QUOTES_ENABLED_KEY].newValue !== false;
    renderDailyQuote().catch(() => {});
  }
  if (areaName === 'session'
    && Object.prototype.hasOwnProperty.call(changes, CAPTAIN_PENDING_DEAD_ITEMS_KEY)) {
    captainPendingDeadItems = normalizeCaptainPendingDeadItems(
      changes[CAPTAIN_PENDING_DEAD_ITEMS_KEY].newValue,
    );
    if (captainLifecycleMutationDepth === 0) scheduleDashboardRefresh();
    return;
  }
  if (captainKeepDedupTrace) {
    const relevantKeys = Object.keys(changes).filter(key => [
      UNDO_HISTORY_KEY,
      REDO_HISTORY_KEY,
      POCKET_TAB_IDS_KEY,
      POCKET_LIVE_ITEM_IDS_KEY,
      CAPTAIN_KEEP_MANIFEST_KEY,
      CAPTAIN_RETAINED_TAB_IDS_KEY,
      CAPTAIN_TAB_ORDER_KEY,
    ].includes(key));
    if (relevantKeys.length > 0) {
      traceCaptainKeepDedup('storage-onChanged', { areaName, keys: relevantKeys });
    }
  }
  if (areaName === 'local'
    && Object.prototype.hasOwnProperty.call(changes, CAPTAIN_KEEP_MANIFEST_KEY)) {
    if (captainKeepReviveTrace) {
      traceCaptainKeepRevive('storage-manifest-changed', {
        oldEntry: changes[CAPTAIN_KEEP_MANIFEST_KEY].oldValue?.tabs?.find(item =>
          item.keepId === captainKeepReviveTrace.keepId) || null,
        newEntry: changes[CAPTAIN_KEEP_MANIFEST_KEY].newValue?.tabs?.find(item =>
          item.keepId === captainKeepReviveTrace.keepId) || null,
      });
    }
    const nextManifest = normalizeCaptainKeepManifest(
      changes[CAPTAIN_KEEP_MANIFEST_KEY].newValue,
    );
    const previousManifest = normalizeCaptainKeepManifest(
      changes[CAPTAIN_KEEP_MANIFEST_KEY].oldValue,
    );
    const deadTransitions = (previousManifest?.tabs || []).filter(previous =>
      previous.state !== 'dead' && Number.isInteger(previous.tabId)
      && nextManifest?.tabs.some(next => next.keepId === previous.keepId && next.state === 'dead'));
    const absorbedExternalClose = [...locallyPatchedExternalCaptainCloseKeepIds].some(keepId => {
      const item = nextManifest?.tabs.find(candidate => candidate.keepId === keepId);
      if (item?.state !== 'dead') return false;
      locallyPatchedExternalCaptainCloseKeepIds.delete(keepId);
      return true;
    });
    captainKeepManifestSnapshot = nextManifest;
    let patchedDeadTransition = false;
    for (const previous of deadTransitions) {
      captainRetainedTabIds.delete(previous.tabId);
      captainTabOrder = captainTabOrder.filter(id => id !== previous.tabId);
      openTabs = openTabs.filter(tab => tab.id !== previous.tabId);
      patchedDeadTransition = patchCaptainKeepChip(previous.keepId, 'dead') || patchedDeadTransition;
    }
    traceCaptainKeep('storage:manifest-changed', {
      oldValue: changes[CAPTAIN_KEEP_MANIFEST_KEY].oldValue || null,
      newValue: changes[CAPTAIN_KEEP_MANIFEST_KEY].newValue || null,
    });
    if (!absorbedExternalClose && !patchedDeadTransition
      && captainLifecycleMutationDepth === 0
      && recentlyRevivedCaptainTabIds.size === 0
      && Date.now() > captainLifecycleRefreshSuppressedUntil) scheduleDashboardRefresh();
  }
  if (areaName === 'local'
    && Object.prototype.hasOwnProperty.call(changes, POCKET_ITEMS_KEY)) {
    pocketItems = normalizePocketItems(changes[POCKET_ITEMS_KEY].newValue);
    if (pocketLifecycleMutationDepth === 0) scheduleDashboardRefresh();
    return;
  }
  const captainChanged = areaName === 'local'
    && (Object.prototype.hasOwnProperty.call(changes, CAPTAIN_CONFIGS_KEY)
      || Object.prototype.hasOwnProperty.call(changes, CAPTAIN_CONFIG_KEY));
  if (captainChanged) {
    loadCaptainConfig().then(() => {
      captainRetainedTabIds = new Set();
      captainTabOrder = [];
      stableGroupDomains.open = [];
      stableGroupDomains.archive = [];
      resetStableOpenGroupLayout();
      return renderDashboard();
    }).catch(error => {
      console.warn('[tab-out] Could not apply the Captain configuration:', error);
    });
    return;
  }
  if (areaName === 'local'
    && (Object.prototype.hasOwnProperty.call(changes, READ_LATER_ENABLED_KEY)
      || Object.prototype.hasOwnProperty.call(changes, POCKET_POSITION_KEY)
      || Object.prototype.hasOwnProperty.call(changes, POCKET_GROUP_LOOSE_TABS_KEY))) {
    (async () => {
      if (Object.prototype.hasOwnProperty.call(changes, READ_LATER_ENABLED_KEY)) {
        await loadReadLaterEnabled();
      }
      if (Object.prototype.hasOwnProperty.call(changes, POCKET_POSITION_KEY)) {
        await loadPocketPosition();
      }
      if (Object.prototype.hasOwnProperty.call(changes, POCKET_GROUP_LOOSE_TABS_KEY)) {
        await loadPocketGrouping();
      }
      stableGroupDomains.open = [];
      stableGroupDomains.archive = [];
      resetStableOpenGroupLayout();
      await renderDashboard();
    })().catch(error => {
      console.warn('[tab-out] Could not apply the Pocket settings:', error);
    });
    return;
  }
  if (areaName === 'local'
    && Object.prototype.hasOwnProperty.call(changes, DASHBOARD_COLUMNS_KEY)) {
    loadDashboardColumns().then(() => {
      stableGroupDomains.open = [];
      resetStableOpenGroupLayout();
      return renderDashboard();
    }).catch(error => {
      console.warn('[tab-out] Could not apply the dashboard column setting:', error);
    });
    return;
  }
  if (areaName === 'local'
    && Object.prototype.hasOwnProperty.call(changes, UI_LANGUAGE_KEY)) {
    loadUiLanguage().then(() => {
      applyPocketVisibility(pocketVisible);
      stableGroupDomains.open = [];
      stableGroupDomains.archive = [];
      resetStableOpenGroupLayout();
      return renderDashboard();
    }).catch(error => {
      console.warn('[tab-out] Could not apply the interface language:', error);
    });
    return;
  }
  if (areaName === 'session'
    && Object.prototype.hasOwnProperty.call(changes, TAB_CUSTOM_LABELS_KEY)) {
    tabCustomLabels = normalizeTabCustomLabels(changes[TAB_CUSTOM_LABELS_KEY].newValue);
    scheduleDashboardRefresh();
    return;
  }
  if (areaName === 'session'
    && Object.prototype.hasOwnProperty.call(changes, POCKET_TAB_IDS_KEY)) {
    archivedTabIds = new Set(normalizeTabIds(changes[POCKET_TAB_IDS_KEY].newValue));
    if (Object.prototype.hasOwnProperty.call(changes, POCKET_LIVE_ITEM_IDS_KEY)) {
      pocketLiveItemIds = normalizePocketLiveItemIds(changes[POCKET_LIVE_ITEM_IDS_KEY].newValue);
    }
    scheduleDashboardRefresh();
    return;
  }
  if (areaName === 'session'
    && Object.prototype.hasOwnProperty.call(changes, POCKET_LIVE_ITEM_IDS_KEY)) {
    pocketLiveItemIds = normalizePocketLiveItemIds(changes[POCKET_LIVE_ITEM_IDS_KEY].newValue);
    scheduleDashboardRefresh();
    return;
  }
  if (areaName === 'session'
    && Object.prototype.hasOwnProperty.call(changes, ERROR_TAB_SIGNALS_KEY)) {
    if (onlyRemovesRecentlyClosedErrorSignals(changes[ERROR_TAB_SIGNALS_KEY])) return;
    scheduleDashboardRefresh();
  }
});

let openGroupLayoutResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(openGroupLayoutResizeTimer);
  openGroupLayoutResizeTimer = setTimeout(() => {
    const metrics = syncDashboardAdaptiveLayout();
    const openStillChanged = stableOpenGroupLayout.columnCount
      && stableOpenGroupLayout.columnCount !== metrics.columnCount;
    if (!openStillChanged) return;
    resetStableOpenGroupLayout();
    renderDashboard().catch(error => {
      console.warn('[tab-out] Could not adapt the group columns:', error);
    });
  }, 100);
});

/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
async function initializeDashboard() {
  traceCaptainKeep('dashboard:initialize-begin', {
    href: location.href,
    visibilityState: document.visibilityState,
  });
  // A browser refresh can restore the previous document's dynamic DOM state.
  // Never carry an already-dismissed action confirmation into a new page load.
  resetToast();

  try {
    const isNewestTabOut = await keepNewestTabOut();
    if (!isNewestTabOut) return;
  } catch (err) {
    // A tab might disappear during rapid Ctrl/Cmd+T presses. Continue to show
    // the dashboard rather than leaving the newly opened page blank.
    console.warn('[tab-out] Could not clean up older Tab Out tabs:', err);
  }

  await Promise.all([
    loadUiLanguage(),
    loadDashboardColumns(),
    loadPocketPosition(),
    loadPocketGrouping(),
    loadPocketManualOrder(),
    loadTabCustomLabels(),
    loadCaptainConfig(),
    loadUndoHistory(),
    loadReadLaterEnabled(),
  ]);
  await loadCoinPocketVisibility();
  traceCaptainKeep('dashboard:settings-loaded', {
    captainConfigs,
    captainSetKey: captainSetKey(),
  });
  // First paint reads only Chrome tabs and cached storage. Pocket/Captain
  // reconciliation can wake the service worker, so it runs after tabs are
  // already visible instead of sitting on the critical rendering path.
  await renderCachedDashboard();
  document.body.classList.remove('pocket-layout-pending');
  traceCaptainKeep('dashboard:initial-render-complete', {
    openTabs: openTabs.map(captainTraceTab),
    retainedIds: [...captainRetainedTabIds],
    order: captainTabOrder,
  });
  void loadDailyQuotes();
  void renderDashboard().catch(error => {
    console.warn('[tab-out] Background dashboard reconciliation skipped:', error);
  });
}

async function renderDashboardRecovery(error) {
  console.error('[tab-out] Initial dashboard render failed; using cached state:', error);
  try {
    await renderCachedDashboard();
  } catch (recoveryError) {
    console.error('[tab-out] Cached dashboard recovery failed:', recoveryError);
    document.getElementById('openTabsSection')?.classList.add('is-rendered');
  } finally {
    document.body.classList.remove('pocket-layout-pending');
  }
}

initializeDashboard().catch(renderDashboardRecovery);
