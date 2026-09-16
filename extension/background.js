/**
 * background.js — Tab Out Service Worker
 *
 * Coordinates badge updates, persistent ambience,
 * error signals, and Captain Keep cleanup after Chrome session restoration.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts every browser tab Tab Out can manage, including internal
 * Chrome pages but excluding Tab Out itself and blank/new-tab placeholders.
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

importScripts('contracts.js', 'pocket-identity.js', 'captain-rules.js');

// ─── Badge updater ────────────────────────────────────────────────────────────

const { STORAGE_KEYS: TAB_OUT_STORAGE, MESSAGES: TAB_OUT_MESSAGES } = TabOutContracts;
const createRuntimeMessage = TabOutContracts.createRuntimeMessage;
const matchesRuntimeMessage = TabOutContracts.matchesRuntimeMessage;
const captainRules = TabOutCaptainRules;
const ERROR_TAB_SIGNALS_KEY = TAB_OUT_STORAGE.ERROR_TAB_SIGNALS;
const ERROR_DETECT_TRACE = '[tab-out error-detect]';
const CAPTAIN_CONFIG_KEY = TAB_OUT_STORAGE.CAPTAIN_CONFIG_LEGACY;
const CAPTAIN_CONFIGS_KEY = TAB_OUT_STORAGE.CAPTAIN_CONFIGS;
const CAPTAIN_KEEP_MANIFEST_KEY = TAB_OUT_STORAGE.CAPTAIN_KEEP_MANIFEST;
const CAPTAIN_SESSION_TOKEN_KEY = TAB_OUT_STORAGE.CAPTAIN_SESSION_TOKEN;
const CAPTAIN_PENDING_DEAD_ITEMS_KEY = TAB_OUT_STORAGE.CAPTAIN_PENDING_DEAD_ITEMS;
const CAPTAIN_RETAINED_TAB_IDS_KEY = TAB_OUT_STORAGE.CAPTAIN_RETAINED_TAB_IDS;
const CAPTAIN_TAB_ORDER_KEY = TAB_OUT_STORAGE.CAPTAIN_TAB_ORDER;
const POCKET_TAB_IDS_KEY = TAB_OUT_STORAGE.POCKET_TAB_IDS;
const POCKET_ITEMS_KEY = TAB_OUT_STORAGE.POCKET_ITEMS;
const POCKET_LIVE_ITEM_IDS_KEY = TAB_OUT_STORAGE.POCKET_LIVE_ITEM_IDS;
const TAB_CUSTOM_LABELS_KEY = TAB_OUT_STORAGE.TAB_CUSTOM_LABELS;
const UNDO_HISTORY_KEY = TAB_OUT_STORAGE.UNDO_HISTORY;
const REDO_HISTORY_KEY = TAB_OUT_STORAGE.REDO_HISTORY;
const STARTUP_PRUNE_STATE_KEY = TAB_OUT_STORAGE.CAPTAIN_STARTUP_PRUNE_STATE;
const DOI_TITLE_CACHE_KEY = TAB_OUT_STORAGE.DOI_TITLE_CACHE;
const ARXIV_TITLE_CACHE_KEY = TAB_OUT_STORAGE.ARXIV_TITLE_CACHE;
const STARTUP_PRUNE_ALARM = 'captain-startup-prune';
const STARTUP_RESTORE_QUIET_MS = 1800;
const STARTUP_RESTORE_MAX_MS = 10000;
const STARTUP_TAB_ORIGIN_TRACE_GRACE_MS = 15000;
const TAB_ORIGIN_CREATED_ID_LIMIT = 128;
// History is capped by user operations; one entry may describe many tabs.
const MAX_UNDO_STEPS = 200;
const MAX_DOI_TITLE_CACHE_ENTRIES = 500;
const DOI_TITLE_FETCH_TIMEOUT_MS = 3500;
const DOI_TITLE_FAILURE_CACHE_MS = 24 * 60 * 60 * 1000;
const PAPER_TITLE_CACHE_VERSION = 2;
const AMBIENCE_STATE_KEY = TAB_OUT_STORAGE.POCKET_AMBIENCE;
const LEGACY_AMBIENCE_STATE_KEY = TAB_OUT_STORAGE.POCKET_AMBIENCE_LEGACY;
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let errorSignalMutationTail = Promise.resolve();
let errorNavigationSequence = 0;
const currentErrorNavigationByTab = new Map();
const errorNavigationSequenceByDocument = new Map();
const errorNavigationSequenceByRequest = new Map();
let pocketStateMutationTail = Promise.resolve();
let tabCustomLabelMutationTail = Promise.resolve();
let offscreenCreation = null;
let ambienceCommandTail = Promise.resolve();
let startupPruneTail = Promise.resolve();
let captainKeepMutationTail = Promise.resolve();
const doiTitleRequests = new Map();
const arxivTitleRequests = new Map();
let doiTitleCacheMutationTail = Promise.resolve();
let arxivTitleCacheMutationTail = Promise.resolve();
const recentlyCreatedTabTimes = new Map();
const captainDuplicateRedirects = new Set();

function enqueueCaptainStateMutation(task) {
  const operation = captainKeepMutationTail.then(task, task);
  captainKeepMutationTail = operation.catch(() => {});
  return operation;
}

function normalizeDoi(value) {
  if (typeof value !== 'string') return '';
  const match = value.trim().match(/^10\.\d{4,9}\/\S+$/i);
  return match ? match[0].replace(/[.,;:]+$/, '').toLowerCase() : '';
}

function metadataTitle(value) {
  const title = Array.isArray(value) ? value[0] : value;
  return typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
}

async function fetchJsonWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOI_TITLE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDoiTitle(doi) {
  try {
    const metadata = await fetchJsonWithTimeout(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    );
    // Crossref's single-work endpoint returns the work directly in `message`;
    // `message.items` is the list-query shape and silently produced no title.
    return metadataTitle(metadata?.message?.title);
  } catch {
    return '';
  }
}

function normalizeArxivId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim().replace(/\.pdf$/i, '').replace(/v\d+$/i, '');
  return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})$/i.test(id)
    ? id.toLowerCase()
    : '';
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchArxivTitle(arxivId) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOI_TITLE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const xml = await response.text();
      const entry = xml.match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/i)?.[1] || '';
      return decodeXmlText(entry.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return '';
  }
}

async function cachedDoiTitle(rawDoi) {
  const doi = normalizeDoi(rawDoi);
  if (!doi) return '';
  const stored = await chrome.storage.local.get(DOI_TITLE_CACHE_KEY);
  const cache = stored[DOI_TITLE_CACHE_KEY];
  const cachedEntry = cache?.[doi];
  const cached = metadataTitle(cachedEntry?.title);
  if (cached && cachedEntry?.version === PAPER_TITLE_CACHE_VERSION) return cached;
  if (cachedEntry?.version === PAPER_TITLE_CACHE_VERSION
    && Date.now() - (Number(cachedEntry.fetchedAt) || 0) < DOI_TITLE_FAILURE_CACHE_MS) {
    return '';
  }

  if (doiTitleRequests.has(doi)) return doiTitleRequests.get(doi);
  const request = fetchDoiTitle(doi).then(async title => {
    const persist = async () => {
      const latest = await chrome.storage.local.get(DOI_TITLE_CACHE_KEY);
      const entries = Object.entries(latest[DOI_TITLE_CACHE_KEY] || {})
        .filter(([, entry]) => entry && Number(entry.fetchedAt));
      const next = Object.fromEntries(entries);
      next[doi] = { title, fetchedAt: Date.now(), version: PAPER_TITLE_CACHE_VERSION };
      const trimmed = Object.fromEntries(Object.entries(next)
        .sort(([, a], [, b]) => (Number(b.fetchedAt) || 0) - (Number(a.fetchedAt) || 0))
        .slice(0, MAX_DOI_TITLE_CACHE_ENTRIES));
      await chrome.storage.local.set({ [DOI_TITLE_CACHE_KEY]: trimmed });
    };
    const persistence = doiTitleCacheMutationTail.then(persist, persist);
    doiTitleCacheMutationTail = persistence.catch(() => {});
    await persistence;
    return title;
  }).finally(() => doiTitleRequests.delete(doi));
  doiTitleRequests.set(doi, request);
  return request;
}

async function cachedArxivTitle(rawArxivId) {
  const arxivId = normalizeArxivId(rawArxivId);
  if (!arxivId) return '';
  const stored = await chrome.storage.local.get(ARXIV_TITLE_CACHE_KEY);
  const cache = stored[ARXIV_TITLE_CACHE_KEY];
  const cachedEntry = cache?.[arxivId];
  const cached = metadataTitle(cachedEntry?.title);
  if (cached && cachedEntry?.version === PAPER_TITLE_CACHE_VERSION) return cached;
  if (cachedEntry?.version === PAPER_TITLE_CACHE_VERSION
    && Date.now() - (Number(cachedEntry.fetchedAt) || 0) < DOI_TITLE_FAILURE_CACHE_MS) {
    return '';
  }

  if (arxivTitleRequests.has(arxivId)) return arxivTitleRequests.get(arxivId);
  const request = fetchArxivTitle(arxivId).then(async title => {
    const persist = async () => {
      const latest = await chrome.storage.local.get(ARXIV_TITLE_CACHE_KEY);
      const entries = Object.entries(latest[ARXIV_TITLE_CACHE_KEY] || {})
        .filter(([, entry]) => entry && Number(entry.fetchedAt));
      const next = Object.fromEntries(entries);
      next[arxivId] = { title, fetchedAt: Date.now(), version: PAPER_TITLE_CACHE_VERSION };
      const trimmed = Object.fromEntries(Object.entries(next)
        .sort(([, a], [, b]) => (Number(b.fetchedAt) || 0) - (Number(a.fetchedAt) || 0))
        .slice(0, MAX_DOI_TITLE_CACHE_ENTRIES));
      await chrome.storage.local.set({ [ARXIV_TITLE_CACHE_KEY]: trimmed });
    };
    const persistence = arxivTitleCacheMutationTail.then(persist, persist);
    arxivTitleCacheMutationTail = persistence.catch(() => {});
    await persistence;
    return title;
  }).finally(() => arxivTitleRequests.delete(arxivId));
  arxivTitleRequests.set(arxivId, request);
  return request;
}

function traceErrorDetect() {}
const tabOutCreatedTabIds = new Set();
let startupTabOriginTraceUntil = 0;
let startupTabOriginPhase = 'none';
let startupTabOriginSessionToken = null;
const AMBIENCE_TRACE = '[tab-out ambience trace]';
const CAPTAIN_STARTUP_TRACE = '[tab-out captain startup]';
const TAB_ORIGIN_TRACE = '[tab-out tab-origin]';
const CAPTAIN_STARTUP_TRACE_LOG_KEY = TAB_OUT_STORAGE.CAPTAIN_STARTUP_TRACE_LOG;
let captainStartupTracePersistTail = Promise.resolve();
const PERSIST_VERBOSE_CAPTAIN_TRACES = false;

function persistCaptainStartupTrace(stage, detail) {
  if (!PERSIST_VERBOSE_CAPTAIN_TRACES) return;
  const entry = { at: new Date().toISOString(), stage, detail };
  captainStartupTracePersistTail = captainStartupTracePersistTail.then(async () => {
    const stored = await chrome.storage.local.get(CAPTAIN_STARTUP_TRACE_LOG_KEY);
    const previous = Array.isArray(stored[CAPTAIN_STARTUP_TRACE_LOG_KEY])
      ? stored[CAPTAIN_STARTUP_TRACE_LOG_KEY] : [];
    await chrome.storage.local.set({
      [CAPTAIN_STARTUP_TRACE_LOG_KEY]: [...previous, entry].slice(-240),
    });
  }).catch(() => {});
}

function traceCaptainStartup(stage, detail = {}) {
  let serialized = '{}';
  try {
    serialized = JSON.stringify(detail);
  } catch (error) {
    serialized = JSON.stringify({ serializationError: String(error?.message || error) });
  }
  persistCaptainStartupTrace(stage, JSON.parse(serialized));
}

function extendStartupTabOriginTraceWindow(durationMs = STARTUP_TAB_ORIGIN_TRACE_GRACE_MS) {
  startupTabOriginTraceUntil = Math.max(startupTabOriginTraceUntil, Date.now() + durationMs);
}

function currentStartupTabOriginContext() {
  return {
    startupPhase: startupTabOriginPhase,
    sessionToken: startupTabOriginSessionToken,
  };
}

function traceTabOrigin() {}

function rememberTabOutCreatedTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  tabOutCreatedTabIds.add(tabId);
  while (tabOutCreatedTabIds.size > TAB_ORIGIN_CREATED_ID_LIMIT) {
    tabOutCreatedTabIds.delete(tabOutCreatedTabIds.values().next().value);
  }
}

async function createTabWithOrigin(source, createProperties) {
  traceTabOrigin('create-request', {
    source,
    url: typeof createProperties.url === 'string' ? createProperties.url : '',
    windowId: Number.isInteger(createProperties.windowId) ? createProperties.windowId : null,
    active: createProperties.active === true,
    ...currentStartupTabOriginContext(),
  });
  const tab = await chrome.tabs.create(createProperties);
  rememberTabOutCreatedTab(tab.id);
  traceTabOrigin('create-result', {
    source,
    tabId: tab.id,
    url: startupTabUrl(tab),
    windowId: tab.windowId,
  });
  return tab;
}

async function traceStartupTabCreated(tab) {
  const timestamp = Date.now();
  const stored = await chrome.storage.session.get([
    STARTUP_PRUNE_STATE_KEY,
    CAPTAIN_SESSION_TOKEN_KEY,
  ]);
  const startupState = stored[STARTUP_PRUNE_STATE_KEY] || null;
  const startupPhase = startupState?.phase || 'none';
  const completedAt = Number(startupState?.completedAt) || 0;
  const isWithinCompletedGrace = startupPhase === 'complete'
    && timestamp - completedAt <= STARTUP_TAB_ORIGIN_TRACE_GRACE_MS;
  const isStartupActive = startupPhase === 'pending'
    || startupPhase === 'running'
    || startupPhase === 'waiting-for-window';
  if (timestamp > startupTabOriginTraceUntil && !isStartupActive && !isWithinCompletedGrace) return;
  traceTabOrigin('onCreated', {
    timestamp,
    tabId: tab.id,
    url: typeof tab.url === 'string' ? tab.url : '',
    pendingUrl: typeof tab.pendingUrl === 'string' ? tab.pendingUrl : '',
    windowId: tab.windowId,
    index: tab.index,
    openerTabId: Number.isInteger(tab.openerTabId) ? tab.openerTabId : null,
    ownedByTabOutCreate: tabOutCreatedTabIds.has(tab.id),
    startupPhase,
    sessionToken: typeof stored[CAPTAIN_SESSION_TOKEN_KEY] === 'string'
      ? stored[CAPTAIN_SESSION_TOKEN_KEY] : null,
  });
}

function startupTabTrace(tab) {
  return {
    id: tab?.id,
    windowId: tab?.windowId,
    index: tab?.index,
    active: Boolean(tab?.active),
    pinned: Boolean(tab?.pinned),
    status: tab?.status,
    url: startupTabUrl(tab),
    title: typeof tab?.title === 'string' ? tab.title : '',
  };
}

function traceAmbience(stage, detail = {}) {
  chrome.runtime.sendMessage(createRuntimeMessage(TAB_OUT_MESSAGES.AMBIENCE_TRACE, {
    stage: `background:${stage}`,
    detail,
  })).catch(() => {});
}

const normalizePocketTabIds = TabOutContracts.normalizeTabIds;
const normalizePocketItems = TabOutContracts.normalizePocketItems;
const normalizePocketLiveItemIds = TabOutContracts.normalizePocketLiveItemIds;
const normalizeTabCustomLabels = TabOutContracts.normalizeTabCustomLabels;

function mutateSessionTabCustomLabel(tabId, customLabel) {
  if (!Number.isInteger(tabId)) return Promise.resolve({});
  const nextLabel = typeof customLabel === 'string' ? customLabel.trim() : '';
  const task = async () => {
    const stored = await chrome.storage.session.get(TAB_CUSTOM_LABELS_KEY);
    const labels = normalizeTabCustomLabels(stored[TAB_CUSTOM_LABELS_KEY]);
    const key = String(tabId);
    if (nextLabel) labels[key] = nextLabel;
    else delete labels[key];
    await chrome.storage.session.set({ [TAB_CUSTOM_LABELS_KEY]: labels });
    return labels;
  };
  const operation = tabCustomLabelMutationTail.then(task, task);
  tabCustomLabelMutationTail = operation.catch(() => {});
  return operation;
}

function createPocketItemId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `pocket-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function pocketItemMetadata(tab) {
  return {
    url: typeof tab?.pendingUrl === 'string' && tab.pendingUrl
      ? tab.pendingUrl
      : typeof tab?.url === 'string' ? tab.url : '',
    title: typeof tab?.title === 'string' ? tab.title.trim() : '',
  };
}

function normalizePocketItemIdentity(pocketItems, liveItemIds, currentIds) {
  const itemsByUrl = new Map();
  const redundantIds = new Map();
  let itemsChanged = false;
  let sessionLinksChanged = false;

  pocketItems.forEach((item, index) => {
    const identityUrl = getPocketIdentityUrl(item.url);
    if (!identityUrl) return;
    const group = itemsByUrl.get(identityUrl) || [];
    group.push({ item, index });
    itemsByUrl.set(identityUrl, group);
  });

  for (const group of itemsByUrl.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.item.order - b.item.order) || (a.index - b.index));
    const winner = group[0].item;
    const labelSource = group.find(({ item }) =>
      typeof item.customLabel === 'string' && item.customLabel.trim());
    const label = labelSource?.item.customLabel.trim() || '';
    if (label && winner.customLabel !== label) {
      winner.customLabel = label;
      itemsChanged = true;
    }
    group.slice(1).forEach(({ item }) => redundantIds.set(item.id, winner.id));
  }

  if (redundantIds.size === 0) return { itemsChanged, sessionLinksChanged };
  for (let index = pocketItems.length - 1; index >= 0; index -= 1) {
    if (!redundantIds.has(pocketItems[index].id)) continue;
    pocketItems.splice(index, 1);
    itemsChanged = true;
  }
  for (const [tabId, itemId] of Object.entries(liveItemIds)) {
    const retainedItemId = redundantIds.get(itemId);
    if (!retainedItemId) continue;
    if (currentIds.has(Number(tabId))) liveItemIds[tabId] = retainedItemId;
    else delete liveItemIds[tabId];
    sessionLinksChanged = true;
  }
  return { itemsChanged, sessionLinksChanged };
}

const pocketIsPdfTab = captainRules.isPdfTab;

function isManageablePocketTab(tab) {
  const urls = [tab?.pendingUrl, tab?.url]
    .filter(url => typeof url === 'string' && url.length > 0);
  if (pocketIsPdfTab(tab)) return true;

  const tabOutRoot = chrome.runtime.getURL('');
  return urls.some(url => {
    const normalized = url.toLowerCase();
    return !url.startsWith(tabOutRoot)
      && normalized !== 'chrome://newtab/'
      && normalized !== 'about:blank'
      && normalized !== 'about:newtab';
  });
}

/** The worker is the sole writer of Pocket membership and live-item links. */
function mutatePocketState(operation, tabIds = [], itemIds = [], customLabel = '', pocketItem = null) {
  const requestedIds = normalizePocketTabIds(tabIds);
  const requestedItemIds = [...new Set((Array.isArray(itemIds) ? itemIds : [])
    .filter(itemId => typeof itemId === 'string' && itemId.length > 0))];
  const task = async () => {
    const [stored, local] = await Promise.all([
      chrome.storage.session.get([POCKET_TAB_IDS_KEY, POCKET_LIVE_ITEM_IDS_KEY]),
      chrome.storage.local.get(POCKET_ITEMS_KEY),
    ]);
    const currentIds = new Set(normalizePocketTabIds(stored[POCKET_TAB_IDS_KEY]));
    const pocketItems = normalizePocketItems(local[POCKET_ITEMS_KEY]);
    const liveItemIds = normalizePocketLiveItemIds(stored[POCKET_LIVE_ITEM_IDS_KEY]);
    const identityNormalization = normalizePocketItemIdentity(pocketItems, liveItemIds, currentIds);
    const itemsById = new Map(pocketItems.map(item => [item.id, item]));
    const addedTabIds = [];
    const removedTabIds = [];
    const killedTabs = [];
    let removedDuplicateCount = 0;
    let restoredPocketItemIdentity = '';
    let itemsChanged = identityNormalization.itemsChanged;
    let sessionLinksChanged = identityNormalization.sessionLinksChanged;

    const removeItem = itemId => {
      if (!itemsById.delete(itemId)) return;
      const index = pocketItems.findIndex(item => item.id === itemId);
      if (index >= 0) pocketItems.splice(index, 1);
      itemsChanged = true;
    };

    const unlinkTab = tabId => {
      if (!Object.prototype.hasOwnProperty.call(liveItemIds, tabId)) return;
      delete liveItemIds[tabId];
      sessionLinksChanged = true;
    };

    const itemHasLiveBinding = itemId => Object.entries(liveItemIds).some(([tabId, boundItemId]) =>
      boundItemId === itemId && currentIds.has(Number(tabId)));

    const linkTab = async (tabId, preferredItemId = '', knownTab = null) => {
      let tab = knownTab;
      if (!tab) {
        try {
          tab = await chrome.tabs.get(tabId);
        } catch {
          return;
        }
      }
      if (!isManageablePocketTab(tab)) return;
      const metadata = pocketItemMetadata(tab);
      if (!metadata.url) return;
      let itemId = preferredItemId && itemsById.has(preferredItemId)
        ? preferredItemId
        : liveItemIds[tabId];
      let item = itemId ? itemsById.get(itemId) : null;
      if (!item) {
        item = pocketItems.find(candidate =>
          getPocketIdentityUrl(candidate.url) === getPocketIdentityUrl(metadata.url)) || null;
        itemId = item?.id || '';
      }
      if (!item) {
        item = {
          id: createPocketItemId(),
          url: metadata.url,
          title: metadata.title,
          order: pocketItems.length === 0
            ? 0
            : Math.max(...pocketItems.map(candidate => candidate.order)) + 1,
          state: 'live',
          tabId,
        };
        itemId = item.id;
        pocketItems.push(item);
        itemsById.set(item.id, item);
        itemsChanged = true;
      } else {
        if (item.url !== metadata.url) {
          item.url = metadata.url;
          itemsChanged = true;
        }
        if (metadata.title && item.title !== metadata.title) {
          item.title = metadata.title;
          itemsChanged = true;
        }
      }
      if (item.state !== 'live' || item.tabId !== tabId) {
        item.state = 'live';
        item.tabId = tabId;
        itemsChanged = true;
      }
      if (liveItemIds[tabId] !== itemId) {
        liveItemIds[tabId] = itemId;
        sessionLinksChanged = true;
      }
    };

    if (operation === 'add' || operation === 'migration-import') {
      const liveTabsById = new Map((await chrome.tabs.query({}))
        .map(tab => [tab.id, tab]));
      for (const tabId of requestedIds) {
        if (currentIds.has(tabId)) continue;
        currentIds.add(tabId);
        addedTabIds.push(tabId);
      }
      for (const tabId of requestedIds) await linkTab(tabId, '', liveTabsById.get(tabId));
    } else if (operation === 'bind') {
      const itemId = requestedItemIds[0] || '';
      if (!itemsById.has(itemId)) throw new Error('Pocket item no longer exists');
      const liveTabsById = new Map((await chrome.tabs.query({}))
        .map(tab => [tab.id, tab]));
      for (const tabId of requestedIds) {
        if (!currentIds.has(tabId)) {
          currentIds.add(tabId);
          addedTabIds.push(tabId);
        }
        await linkTab(tabId, itemId, liveTabsById.get(tabId));
      }
    } else if (operation === 'remove') {
      for (const tabId of requestedIds) {
        if (!currentIds.delete(tabId)) continue;
        removedTabIds.push(tabId);
        const itemId = liveItemIds[tabId];
        unlinkTab(tabId);
        if (itemId && !itemHasLiveBinding(itemId)) removeItem(itemId);
      }
    } else if (operation === 'kill-items') {
      const targetItemIds = new Set(requestedItemIds.length > 0
        ? requestedItemIds
        : pocketItems.filter(item => item.state === 'live').map(item => item.id));
      for (const [tabIdText, itemId] of Object.entries(liveItemIds)) {
        if (!targetItemIds.has(itemId)) continue;
        const tabId = Number(tabIdText);
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab) killedTabs.push(tab);
        currentIds.delete(tabId);
        removedTabIds.push(tabId);
        unlinkTab(tabId);
      }
      for (const item of pocketItems) {
        if (!targetItemIds.has(item.id) || item.state === 'dead') continue;
        item.state = 'dead';
        item.tabId = null;
        itemsChanged = true;
      }
    } else if (operation === 'restore-dormant' || operation === 'replace-dormant') {
      const restoredItem = normalizePocketItems([pocketItem])[0];
      if (!restoredItem) throw new Error('Pocket item snapshot is invalid');
      restoredPocketItemIdentity = getPocketIdentityUrl(restoredItem.url);
      restoredItem.state = 'dead';
      restoredItem.tabId = null;
      if (operation === 'replace-dormant') {
        const identity = getPocketIdentityUrl(restoredItem.url);
        const duplicates = pocketItems.filter(item => item.id !== restoredItem.id
          && getPocketIdentityUrl(item.url) === identity);
        const duplicateIds = new Set(duplicates.map(item => item.id));
        const liveDuplicateItemIds = new Set();
        let liveDuplicateCount = 0;
        for (const [tabIdText, itemId] of Object.entries(liveItemIds)) {
          if (!duplicateIds.has(itemId)) continue;
          liveDuplicateItemIds.add(itemId);
          liveDuplicateCount += 1;
          const tabId = Number(tabIdText);
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (tab) killedTabs.push(tab);
          currentIds.delete(tabId);
          removedTabIds.push(tabId);
          unlinkTab(tabId);
        }
        removedDuplicateCount = liveDuplicateCount
          + duplicates.filter(item => !liveDuplicateItemIds.has(item.id)).length;
        for (const itemId of duplicateIds) removeItem(itemId);
      }
      for (const tabId of requestedIds) {
        if (currentIds.delete(tabId)) removedTabIds.push(tabId);
        unlinkTab(tabId);
      }
      const existingIndex = pocketItems.findIndex(item => item.id === restoredItem.id);
      if (existingIndex >= 0) pocketItems.splice(existingIndex, 1, restoredItem);
      else pocketItems.push(restoredItem);
      itemsById.set(restoredItem.id, restoredItem);
      itemsChanged = true;
    } else if (operation === 'discard-items') {
      const discardedIds = new Set(requestedItemIds);
      for (const [tabId, itemId] of Object.entries(liveItemIds)) {
        if (!discardedIds.has(itemId)) continue;
        const numericTabId = Number(tabId);
        if (currentIds.delete(numericTabId)) removedTabIds.push(numericTabId);
        unlinkTab(numericTabId);
      }
      for (const itemId of discardedIds) removeItem(itemId);
    } else if (operation === 'set-order') {
      const rankedIds = requestedItemIds.filter(itemId => itemsById.has(itemId));
      const rankedSet = new Set(rankedIds);
      const remainingIds = pocketItems
        .filter(item => !rankedSet.has(item.id))
        .sort((a, b) => a.order - b.order)
        .map(item => item.id);
      [...rankedIds, ...remainingIds].forEach((itemId, index) => {
        const item = itemsById.get(itemId);
        if (item && item.order !== index) {
          item.order = index;
          itemsChanged = true;
        }
      });
    } else if (operation === 'set-label') {
      const item = itemsById.get(requestedItemIds[0]);
      if (!item) throw new Error('Pocket item no longer exists');
      const nextLabel = typeof customLabel === 'string' ? customLabel.trim() : '';
      if (nextLabel) {
        if (item.customLabel !== nextLabel) {
          item.customLabel = nextLabel;
          itemsChanged = true;
        }
      } else if (Object.prototype.hasOwnProperty.call(item, 'customLabel')) {
        delete item.customLabel;
        itemsChanged = true;
      }
    } else if (operation === 'prune') {
      // Query live tabs inside the same queue. A Dashboard's stale snapshot
      // must never remove a tab another Dashboard has just added to Pocket.
      const liveTabs = await chrome.tabs.query({});
      const liveTabsById = new Map(liveTabs.map(tab => [tab.id, tab]));
      const validIds = new Set(liveTabs.filter(isManageablePocketTab).map(tab => tab.id));
      for (const tabId of currentIds) {
        if (validIds.has(tabId)) continue;
        currentIds.delete(tabId);
        removedTabIds.push(tabId);
        // A disappeared live tab becomes dormant; its persistent Pocket item
        // remains available until the user explicitly removes it.
        const item = itemsById.get(liveItemIds[tabId]);
        if (item && (item.state !== 'dead' || item.tabId !== null)) {
          item.state = 'dead';
          item.tabId = null;
          itemsChanged = true;
        }
        unlinkTab(tabId);
      }
      for (const tabId of Object.keys(liveItemIds)) {
        if (!currentIds.has(Number(tabId))) unlinkTab(Number(tabId));
      }
      for (const tabId of currentIds) await linkTab(tabId, '', liveTabsById.get(tabId));
    } else {
      throw new Error(`Unsupported Pocket mutation: ${operation}`);
    }

    const postMutationIdentityNormalization = normalizePocketItemIdentity(
      pocketItems,
      liveItemIds,
      currentIds,
    );
    itemsChanged = itemsChanged || postMutationIdentityNormalization.itemsChanged;
    sessionLinksChanged = sessionLinksChanged || postMutationIdentityNormalization.sessionLinksChanged;

    const pocketTabIds = [...currentIds];
    if (addedTabIds.length > 0 || removedTabIds.length > 0 || sessionLinksChanged) {
      await chrome.storage.session.set({
        [POCKET_TAB_IDS_KEY]: pocketTabIds,
        [POCKET_LIVE_ITEM_IDS_KEY]: liveItemIds,
      });
    }
    if (itemsChanged) await chrome.storage.local.set({ [POCKET_ITEMS_KEY]: pocketItems });
    if ((operation === 'kill-items' || operation === 'replace-dormant') && killedTabs.length > 0) {
      await chrome.tabs.remove(killedTabs.map(tab => tab.id));
    }
    const restoredPocketItemId = restoredPocketItemIdentity
      ? pocketItems.find(item => getPocketIdentityUrl(item.url) === restoredPocketItemIdentity)?.id || ''
      : '';
    return {
      pocketTabIds,
      addedTabIds,
      removedTabIds,
      pocketItems,
      pocketLiveItemIds: liveItemIds,
      killedTabs,
      removedDuplicateCount,
      restoredPocketItemId,
    };
  };
  const current = pocketStateMutationTail.then(task, task);
  pocketStateMutationTail = current.catch(() => {});
  return current;
}

async function hasOffscreenDocument() {
  if (typeof chrome.offscreen?.hasDocument === 'function') {
    return chrome.offscreen.hasDocument();
  }
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const controlledClients = await self.clients.matchAll();
  return controlledClients.some(client => client.url === offscreenUrl);
}

async function ensureOffscreenDocument({ quiet = false } = {}) {
  if (await hasOffscreenDocument()) {
    if (!quiet) traceAmbience('offscreen-present');
    return;
  }
  if (!quiet) traceAmbience('offscreen-create-begin');
  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Keep one local ambience mix playing across Tab Out page navigation.',
    }).finally(() => {
      offscreenCreation = null;
    });
  }
  await offscreenCreation;
  if (!quiet) traceAmbience('offscreen-create-done');
}

function ambienceDelay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForOffscreenListener({ quiet = false } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage(createRuntimeMessage(TAB_OUT_MESSAGES.AMBIENCE_COMMAND, {
        command: 'ping',
      }, 'offscreen'));
      if (response?.ok) {
        if (!quiet) traceAmbience('offscreen-ready', { attempt });
        return;
      }
      lastError = new Error('Offscreen ping had no response');
    } catch (error) {
      lastError = error;
    }
    await ambienceDelay(50);
  }
  throw lastError || new Error('Offscreen listener did not become ready');
}

async function getAmbienceState() {
  const stored = await chrome.storage.session.get([
    AMBIENCE_STATE_KEY,
    LEGACY_AMBIENCE_STATE_KEY,
  ]);
  const current = stored[AMBIENCE_STATE_KEY];
  if (current && typeof current.active === 'boolean') return current;

  const legacy = stored[LEGACY_AMBIENCE_STATE_KEY];
  const legacyStartedAt = Number.isFinite(legacy?.savedAt)
    ? legacy.savedAt - (Number(legacy.currentTime) || 0) * 1000
    : 0;
  const migrated = {
    active: Boolean(legacy?.active),
    startedAt: Number(legacy?.startedAt) || legacyStartedAt || 0,
  };
  await chrome.storage.session.set({ [AMBIENCE_STATE_KEY]: migrated });
  await chrome.storage.session.remove(LEGACY_AMBIENCE_STATE_KEY);
  return migrated;
}

async function sendOffscreenAmbienceCommand(command, state = {}) {
  const deliver = async () => {
    if (command !== 'mix') traceAmbience('offscreen-send', { command, state });
    await ensureOffscreenDocument({ quiet: command === 'mix' });
    await waitForOffscreenListener({ quiet: command === 'mix' });
    const response = await chrome.runtime.sendMessage(createRuntimeMessage(TAB_OUT_MESSAGES.AMBIENCE_COMMAND, {
      command,
      ...state,
    }, 'offscreen'));
    if (!response?.ok) throw new Error(response?.error || 'Offscreen ambience did not respond');
    if (command !== 'mix') traceAmbience('offscreen-response', { command, response });
  };

  try {
    await deliver();
  } catch (firstError) {
    traceAmbience('offscreen-first-failure', { command, message: String(firstError?.message || firstError) });
    // hasDocument() can report a stale offscreen page whose script no longer
    // has a live message listener. Recreate it once instead of leaving both
    // the audio and the dashboard rain waiting behind the dead owner.
    if (await hasOffscreenDocument()) {
      try { await chrome.offscreen.closeDocument(); } catch {}
    }
    offscreenCreation = null;
    try {
      await deliver();
    } catch (retryError) {
      traceAmbience('offscreen-retry-failure', { command, message: String(retryError?.message || retryError) });
      throw new Error(`${retryError?.message || retryError} (after offscreen recovery: ${firstError?.message || firstError})`);
    }
  }
}

async function handleAmbienceCommand(command, mix = null) {
  const state = await getAmbienceState();
  if (command !== 'mix') traceAmbience('handle-command', { command, state });
  if (command === 'prime') {
    await sendOffscreenAmbienceCommand('prime');
    return state;
  }
  if (command === 'ensure') {
    if (state.active) {
      await sendOffscreenAmbienceCommand('start', { startedAt: state.startedAt, instant: true });
    }
    return state;
  }
  if (command === 'mix') {
    // Keep inactive ambience inert. The dashboard retains its page-local mix
    // and replays all three tracks when the existing toggle path turns on.
    if (state.active) await sendOffscreenAmbienceCommand('mix', { mix });
    return state;
  }
  if (command !== 'toggle') throw new Error(`Unknown ambience command: ${command}`);

  const nextState = state.active
    ? { active: false, startedAt: 0 }
    : { active: true, startedAt: Date.now() };
  await ensureOffscreenDocument();
  // Publish the user's intent first so the rain layer is never blocked behind
  // audio decoding or an offscreen recovery. Roll it back if audio cannot be
  // started/stopped after the single recovery attempt.
  await chrome.storage.session.set({ [AMBIENCE_STATE_KEY]: nextState });
  traceAmbience('state-published', nextState);
  try {
    await sendOffscreenAmbienceCommand(
      nextState.active ? 'start' : 'stop',
      nextState.active ? { startedAt: nextState.startedAt, instant: false } : {},
    );
  } catch (error) {
    traceAmbience('command-rollback', { command, message: String(error?.message || error) });
    await chrome.storage.session.set({ [AMBIENCE_STATE_KEY]: state });
    throw error;
  }
  return nextState;
}

function startupCaptainConfigs(stored) {
  return TabOutCaptainRules.normalizeConfigs(
    stored[CAPTAIN_CONFIGS_KEY],
    stored[CAPTAIN_CONFIG_KEY],
  ).map(config => config.keepAreaEnabled !== false
    ? config
    : { ...config, enabled: false });
}

function startupCaptainKey(config) {
  return TabOutCaptainRules.configKey(config);
}

function startupCaptainSetKey(configs) {
  return TabOutCaptainRules.configSetKey(configs);
}

function startupTabUrl(tab) {
  return typeof tab?.pendingUrl === 'string' && tab.pendingUrl
    ? tab.pendingUrl
    : typeof tab?.url === 'string' ? tab.url : '';
}

function isTabOutDashboardTab(tab) {
  const url = startupTabUrl(tab);
  return url === chrome.runtime.getURL('index.html') || url === 'chrome://newtab/';
}

function isNewTabStartupPlaceholder(tab) {
  const url = startupTabUrl(tab).toLowerCase();
  return isTabOutDashboardTab(tab)
    || !url
    || url === 'about:blank'
    || url === 'about:newtab'
    || url === 'chrome://new-tab-page/';
}

function startupCaptainIndexForTab(tab, configs) {
  return TabOutCaptainRules.captainIndexForTab(tab, configs);
}

function startupMatchesCaptain(tab, config) {
  return TabOutCaptainRules.matchesTab(tab, config);
}

const normalizeStartupKeepManifest = TabOutCaptainRules.normalizeKeepManifest;
const normalizeCaptainPendingDeadItems = TabOutCaptainRules.normalizePendingDeadItems;

async function getCaptainSessionToken() {
  const stored = await chrome.storage.session.get(CAPTAIN_SESSION_TOKEN_KEY);
  if (typeof stored[CAPTAIN_SESSION_TOKEN_KEY] === 'string'
    && stored[CAPTAIN_SESSION_TOKEN_KEY]) return stored[CAPTAIN_SESSION_TOKEN_KEY];
  const token = crypto.randomUUID();
  await chrome.storage.session.set({ [CAPTAIN_SESSION_TOKEN_KEY]: token });
  return token;
}

function matchStartupKeepTabs(manifest, configs, tabs) {
  if (!manifest || manifest.captainSetKey !== startupCaptainSetKey(configs)) return [];
  const availableIds = new Set(tabs.map(tab => tab.id));
  const matches = [];
  for (const reference of manifest.tabs) {
    if (reference.state === 'dead') continue;
    const config = configs[reference.captainIndex];
    if (!config
      || startupCaptainKey(config) !== reference.captainKey
      || !startupMatchesCaptain({ url: reference.url }, config)) continue;
    const match = tabs.find(tab => availableIds.has(tab.id)
      && startupMatchesCaptain(tab, config)
      && startupTabUrl(tab) === reference.url);
    if (!match) continue;
    availableIds.delete(match.id);
    matches.push({ tab: match, reference });
  }
  return matches;
}

async function recreateKeepTabsForNewTabStartup(manifest, configs, tabs) {
  extendStartupTabOriginTraceWindow();
  traceTabOrigin('recreate:start', {
    manifestTabCount: Array.isArray(manifest?.tabs) ? manifest.tabs.length : 0,
    ...currentStartupTabOriginContext(),
  });
  const expectedCaptainSetKey = startupCaptainSetKey(configs);
  const blockers = [];
  if (!manifest) blockers.push('manifest-missing');
  if (manifest && manifest.captainSetKey !== expectedCaptainSetKey) blockers.push('captain-config-mismatch');
  if (manifest?.tabs.length === 0) blockers.push('manifest-empty');
  if (tabs.length === 0) blockers.push('no-browser-tabs');
  if (tabs.some(tab => !isNewTabStartupPlaceholder(tab))) blockers.push('non-new-tab-startup-page-present');
  traceCaptainStartup('recreate:evaluate', {
    blockers,
    expectedCaptainSetKey,
    manifestCaptainSetKey: manifest?.captainSetKey || null,
    startupTabs: tabs.map(startupTabTrace),
  });
  if (blockers.length > 0) return [];

  const dashboardTab = tabs.filter(isTabOutDashboardTab).reduce(
    (newest, tab) => !newest || tab.id > newest.id ? tab : newest,
    null,
  );
  const targetWindowId = dashboardTab?.windowId;
  const recreated = [];

  for (const reference of manifest.tabs) {
    if (reference.state === 'dead') continue;
    const config = configs[reference.captainIndex];
    if (!config
      || startupCaptainKey(config) !== reference.captainKey
      || !startupMatchesCaptain({ url: reference.url }, config)) continue;
    try {
      const tab = await createTabWithOrigin('captain-startup-recreate', {
        url: reference.url,
        active: false,
        ...(Number.isInteger(targetWindowId) ? { windowId: targetWindowId } : {}),
      });
      recreated.push({ tab, reference });
      traceCaptainStartup('recreate:tab-created', {
        reference,
        tab: startupTabTrace(tab),
      });
    } catch (error) {
      traceCaptainStartup('recreate:tab-failed', {
        reference,
        error: String(error?.message || error),
      });
      // One inaccessible saved URL must not prevent the other Keep tabs from
      // being restored into Chrome's otherwise-empty startup window.
    }
  }

  if (Number.isInteger(dashboardTab?.id)) {
    try {
      await chrome.tabs.update(dashboardTab.id, { active: true });
      await chrome.windows.update(dashboardTab.windowId, { focused: true });
    } catch {}
  }
  return recreated;
}

async function normalBrowserTabs() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  return windows.flatMap(windowInfo => windowInfo.tabs || [])
    .filter(tab => Number.isInteger(tab.id) && !tab.incognito)
    .sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
}

async function appendStartupCloseUndo(tabs, pocketTabIds) {
  if (tabs.length === 0) return;
  const stored = await chrome.storage.session.get([UNDO_HISTORY_KEY, REDO_HISTORY_KEY]);
  const history = Array.isArray(stored[UNDO_HISTORY_KEY]) ? stored[UNDO_HISTORY_KEY] : [];
    const entry = {
    type: 'closed-tabs',
    tabs: tabs.map(tab => ({
      id: tab.id,
      url: startupTabUrl(tab),
      windowId: tab.windowId,
      index: tab.index,
      pinned: Boolean(tab.pinned),
      wasArchived: pocketTabIds.has(tab.id),
    })).filter(tab => tab.url),
  };
  if (entry.tabs.length === 0) return;
  await chrome.storage.session.set({
    [UNDO_HISTORY_KEY]: [...history, entry].slice(-MAX_UNDO_STEPS),
    [REDO_HISTORY_KEY]: [],
  });
}

async function ensureStartupDashboardTab(tabs, keepMatches) {
  const existing = tabs.filter(isTabOutDashboardTab).reduce(
    (newest, tab) => !newest || tab.id > newest.id ? tab : newest,
    null,
  );
  if (existing) {
    traceCaptainStartup('dashboard:existing', startupTabTrace(existing));
    return existing;
  }

  const targetWindowId = keepMatches.find(match =>
    Number.isInteger(match?.tab?.windowId))?.tab.windowId;
  try {
    // Startup cleanup is already committed at this point. Recreate its
    // dashboard infrastructure without stealing focus from Chrome's restored
    // active tab. Explicit startup-page mode exits before reaching this path.
    const created = await createTabWithOrigin('captain-startup-dashboard', {
      url: chrome.runtime.getURL('index.html'),
      active: false,
      ...(Number.isInteger(targetWindowId) ? { windowId: targetWindowId } : {}),
    });
    traceCaptainStartup('dashboard:created', startupTabTrace(created));
    return created;
  } catch (error) {
    traceCaptainStartup('dashboard:create-failed', {
      error: String(error?.message || error),
    });
    return null;
  }
}

async function runCaptainStartupPrune() {
  let deferCompletion = false;
  const session = await chrome.storage.session.get([
    STARTUP_PRUNE_STATE_KEY,
    CAPTAIN_SESSION_TOKEN_KEY,
  ]);
  startupTabOriginPhase = session[STARTUP_PRUNE_STATE_KEY]?.phase || 'none';
  startupTabOriginSessionToken = typeof session[CAPTAIN_SESSION_TOKEN_KEY] === 'string'
    ? session[CAPTAIN_SESSION_TOKEN_KEY] : null;
  traceCaptainStartup('prune:invoked', { state: session[STARTUP_PRUNE_STATE_KEY] || null });
  extendStartupTabOriginTraceWindow();
  traceTabOrigin('prune:invoked', { ...currentStartupTabOriginContext() });
  if (session[STARTUP_PRUNE_STATE_KEY]?.phase !== 'pending') {
    traceCaptainStartup('prune:skipped-not-pending', { state: session[STARTUP_PRUNE_STATE_KEY] || null });
    return;
  }
  await chrome.storage.session.set({
    [STARTUP_PRUNE_STATE_KEY]: { ...session[STARTUP_PRUNE_STATE_KEY], phase: 'running' },
  });
  startupTabOriginPhase = 'running';

  try {
    const stored = await chrome.storage.local.get([
      CAPTAIN_CONFIGS_KEY,
      CAPTAIN_CONFIG_KEY,
      CAPTAIN_KEEP_MANIFEST_KEY,
    ]);
    const configs = startupCaptainConfigs(stored);
    const manifest = normalizeStartupKeepManifest(stored[CAPTAIN_KEEP_MANIFEST_KEY]);
    const tabs = await normalBrowserTabs();
    traceCaptainStartup('prune:snapshot', {
      configs,
      expectedCaptainSetKey: startupCaptainSetKey(configs),
      rawManifest: stored[CAPTAIN_KEEP_MANIFEST_KEY] || null,
      normalizedManifest: manifest,
      tabs: tabs.map(startupTabTrace),
    });
    if (tabs.length === 0) {
      deferCompletion = true;
      const previousState = session[STARTUP_PRUNE_STATE_KEY];
      const deadline = Number(previousState?.deadline) || Date.now();
      const nextState = Date.now() < deadline
        ? { ...previousState, phase: 'pending' }
        : { phase: 'waiting-for-window', since: Date.now() };
      await chrome.storage.session.set({ [STARTUP_PRUNE_STATE_KEY]: nextState });
      traceCaptainStartup('prune:deferred-no-window-tabs', { nextState });
      if (nextState.phase === 'pending') await scheduleCaptainStartupPrune();
      return;
    }
    let keepMatches = matchStartupKeepTabs(manifest, configs, tabs);
    traceCaptainStartup('prune:match-result', {
      matches: keepMatches.map(({ tab, reference }) => ({
        tab: startupTabTrace(tab),
        reference,
      })),
      unmatchedReferences: (manifest?.tabs || []).filter(reference =>
        !keepMatches.some(match => match.reference === reference)),
    });

    // Under Chrome's "Open the New Tab page" setting there are no restored
    // browser tabs to match. In that one unambiguous case, recreate Keep from
    // its URL manifest. Any configured startup page makes this return [] so
    // Chrome's explicit startup-page setting remains untouched.
    if (keepMatches.length === 0) {
      keepMatches = await recreateKeepTabsForNewTabStartup(manifest, configs, tabs);
    }

    // No match and no New Tab-only restoration means Chrome opened configured
    // startup pages, or there is no saved Keep state. Respect that state.
    if (keepMatches.length === 0) {
      traceCaptainStartup('prune:abort-no-keep', {});
      return;
    }

    const keepIds = new Set(keepMatches.map(match => match.tab.id));
    const dashboardToKeep = await ensureStartupDashboardTab(tabs, keepMatches);
    if (dashboardToKeep) keepIds.add(dashboardToKeep.id);
    const tabsToClose = tabs.filter(tab => !keepIds.has(tab.id));
    traceCaptainStartup('prune:plan', {
      keep: keepMatches.map(match => startupTabTrace(match.tab)),
      dashboard: dashboardToKeep ? startupTabTrace(dashboardToKeep) : null,
      close: tabsToClose.map(startupTabTrace),
    });
    if (tabsToClose.length > 0) {
      const pocketState = await chrome.storage.session.get(POCKET_TAB_IDS_KEY);
      const pocketTabIds = new Set(Array.isArray(pocketState[POCKET_TAB_IDS_KEY])
        ? pocketState[POCKET_TAB_IDS_KEY].filter(Number.isInteger) : []);
      await chrome.tabs.remove(tabsToClose.map(tab => tab.id));
      traceCaptainStartup('prune:close-complete', {
        closedIds: tabsToClose.map(tab => tab.id),
      });
      // Tab Out is infrastructure for viewing the result, not user content.
      // Never let an older dashboard enter Undo and replace its active page.
      await appendStartupCloseUndo(
        tabsToClose.filter(tab => !isTabOutDashboardTab(tab)),
        pocketTabIds,
      );
    }

    const sessionToken = await getCaptainSessionToken();
    await chrome.storage.local.set({
      [CAPTAIN_RETAINED_TAB_IDS_KEY]: keepMatches.map(match => match.tab.id),
      [CAPTAIN_TAB_ORDER_KEY]: keepMatches.map(match => match.tab.id),
      [CAPTAIN_KEEP_MANIFEST_KEY]: {
        version: 1,
        sessionToken,
        captainSetKey: startupCaptainSetKey(configs),
        tabs: (manifest?.tabs || []).flatMap(reference => {
          if (reference.state === 'dead') {
            const config = configs[reference.captainIndex];
            return config
              && startupCaptainKey(config) === reference.captainKey
              && startupMatchesCaptain({ url: reference.url }, config)
              ? [reference] : [];
          }
          const match = keepMatches.find(candidate => candidate.reference === reference);
          if (!match) return [];
          const { tab } = match;
          return [{
            keepId: reference.keepId || crypto.randomUUID(),
            state: 'live',
            tabId: tab.id,
            captainIndex: reference.captainIndex,
            captainKey: reference.captainKey,
            url: startupTabUrl(tab),
            title: typeof tab.title === 'string' && tab.title.trim()
              ? tab.title.trim()
              : reference.title || '',
            ...(typeof reference.customLabel === 'string' && reference.customLabel
              ? { customLabel: reference.customLabel }
              : {}),
          }];
        }),
      },
    });
    traceCaptainStartup('prune:manifest-committed', {
      sessionToken,
      retainedIds: keepMatches.map(match => match.tab.id),
      manifestTabs: keepMatches.map(({ tab, reference }) => ({
        tabId: tab.id,
        captainIndex: reference.captainIndex,
        captainKey: reference.captainKey,
        url: startupTabUrl(tab),
      })),
    });
    if (dashboardToKeep) {
      try {
        // The restored/recreated Keep tabs stay in the background; startup
        // should land on the dashboard rather than a tab Chrome activated as
        // a side effect of closing the previous active page.
        await chrome.tabs.update(dashboardToKeep.id, { active: true });
        traceCaptainStartup('dashboard:activated', startupTabTrace(dashboardToKeep));
      } catch {}
    }
  } catch (error) {
    traceCaptainStartup('prune:error', {
      error: String(error?.stack || error?.message || error),
    });
    console.warn('[tab-out] Could not keep only Captain Keep tabs after startup:', error);
  } finally {
    if (!deferCompletion) {
      await chrome.storage.session.set({
        [STARTUP_PRUNE_STATE_KEY]: { phase: 'complete', completedAt: Date.now() },
      });
      startupTabOriginPhase = 'complete';
      traceCaptainStartup('prune:complete', {});
      extendStartupTabOriginTraceWindow();
      traceTabOrigin('prune:complete', { ...currentStartupTabOriginContext() });
    }
  }
}

async function scheduleCaptainStartupPrune(activity = null) {
  const stored = await chrome.storage.session.get(STARTUP_PRUNE_STATE_KEY);
  const state = stored[STARTUP_PRUNE_STATE_KEY];
  if (state?.phase !== 'pending') return;
  if (activity) traceCaptainStartup('startup:tab-activity', activity);
  const when = Math.min(Date.now() + STARTUP_RESTORE_QUIET_MS, state.deadline);
  await chrome.alarms.create(STARTUP_PRUNE_ALARM, { when });
  traceCaptainStartup('schedule:alarm', {
    now: Date.now(),
    when,
    delayMs: Math.max(0, when - Date.now()),
    deadline: state.deadline,
  });
}

async function beginCaptainStartupPrune() {
  const startedAt = Date.now();
  startupTabOriginPhase = 'pending';
  extendStartupTabOriginTraceWindow(STARTUP_RESTORE_MAX_MS + STARTUP_TAB_ORIGIN_TRACE_GRACE_MS);
  traceCaptainStartup('startup:begin', { startedAt });
  await chrome.storage.session.set({
    [STARTUP_PRUNE_STATE_KEY]: {
      phase: 'pending',
      startedAt,
      deadline: startedAt + STARTUP_RESTORE_MAX_MS,
    },
  });
  const sessionToken = await getCaptainSessionToken();
  startupTabOriginSessionToken = sessionToken;
  traceCaptainStartup('startup:session-token', { sessionToken });
  await scheduleCaptainStartupPrune();
}

async function markPersistentTabsDeadForNewSession() {
  const local = await chrome.storage.local.get([
    POCKET_ITEMS_KEY,
    CAPTAIN_KEEP_MANIFEST_KEY,
  ]);
  const pocketItems = normalizePocketItems(local[POCKET_ITEMS_KEY]).map(item => ({
    ...item,
    state: 'dead',
    tabId: null,
  }));
  const manifest = normalizeStartupKeepManifest(local[CAPTAIN_KEEP_MANIFEST_KEY]);
  const update = { [POCKET_ITEMS_KEY]: pocketItems };
  if (manifest) {
    update[CAPTAIN_KEEP_MANIFEST_KEY] = {
      version: 1,
      sessionToken: await getCaptainSessionToken(),
      captainSetKey: manifest.captainSetKey,
      tabs: manifest.tabs.map(item => ({ ...item, state: 'dead', tabId: null })),
    };
    update[CAPTAIN_RETAINED_TAB_IDS_KEY] = [];
    update[CAPTAIN_TAB_ORDER_KEY] = [];
  }
  await Promise.all([
    chrome.storage.local.set(update),
    chrome.storage.session.set({
      [POCKET_TAB_IDS_KEY]: [],
      [POCKET_LIVE_ITEM_IDS_KEY]: {},
      [CAPTAIN_PENDING_DEAD_ITEMS_KEY]: [],
    }),
  ]);
}

function noteStartupTabActivity(detail = {}) {
  scheduleCaptainStartupPrune(detail).catch(() => {});
}

async function markCaptainRestoreWaitingForWindow(closedWindowId) {
  const normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  if (normalWindows.length > 0) return;
  const state = { phase: 'waiting-for-window', since: Date.now(), closedWindowId };
  await chrome.storage.session.set({ [STARTUP_PRUNE_STATE_KEY]: state });
  await chrome.alarms.clear(STARTUP_PRUNE_ALARM);
  traceCaptainStartup('window:last-normal-closed', state);
}

async function resumeCaptainRestoreForWindow(windowInfo) {
  if (windowInfo?.type !== 'normal') return;
  const stored = await chrome.storage.session.get(STARTUP_PRUNE_STATE_KEY);
  const state = stored[STARTUP_PRUNE_STATE_KEY];
  traceCaptainStartup('window:normal-created', {
    windowId: windowInfo.id,
    previousState: state || null,
  });
  // Covers macOS/Chrome configurations where closing the last window leaves
  // the browser process alive, so runtime.onStartup will not fire next time.
  if (state?.phase === 'waiting-for-window') await beginCaptainStartupPrune();
}

function captainManifestFingerprint(value) {
  return JSON.stringify(normalizeStartupKeepManifest(value));
}

/**
 * Serializes a dashboard reconciliation with tab-event mutations. The
 * dashboard supplies the manifest it read; a changed worker snapshot rejects
 * the stale replacement instead of silently losing the newer update.
 */
function replaceCaptainStateFromDashboard({
  expectedManifest = null,
  nextManifest = null,
  retainedIds = [],
  order = [],
  preserveManifest = false,
} = {}) {
  return enqueueCaptainStateMutation(async () => {
    const [local, session] = await Promise.all([
      chrome.storage.local.get([
        CAPTAIN_KEEP_MANIFEST_KEY,
        CAPTAIN_RETAINED_TAB_IDS_KEY,
        CAPTAIN_TAB_ORDER_KEY,
        CAPTAIN_CONFIGS_KEY,
        CAPTAIN_CONFIG_KEY,
      ]),
      chrome.storage.session.get(CAPTAIN_SESSION_TOKEN_KEY),
    ]);
    const currentManifest = normalizeStartupKeepManifest(local[CAPTAIN_KEEP_MANIFEST_KEY]);
    if (captainManifestFingerprint(currentManifest)
      !== captainManifestFingerprint(expectedManifest)) {
      return {
        conflict: true,
        manifest: currentManifest,
        retainedIds: normalizePocketTabIds(local[CAPTAIN_RETAINED_TAB_IDS_KEY]),
        order: normalizePocketTabIds(local[CAPTAIN_TAB_ORDER_KEY]),
      };
    }

    const sessionToken = session[CAPTAIN_SESSION_TOKEN_KEY];
    const configs = startupCaptainConfigs(local);
    const expectedCaptainSetKey = startupCaptainSetKey(configs);
    const normalizedManifest = preserveManifest
      ? currentManifest
      : normalizeStartupKeepManifest(nextManifest);
    if (!preserveManifest && (!normalizedManifest
      || !sessionToken
      || normalizedManifest.sessionToken !== sessionToken
      || normalizedManifest.captainSetKey !== expectedCaptainSetKey)) {
      throw new Error('Dashboard Captain state does not match the active session');
    }

    const nextRetainedIds = normalizePocketTabIds(retainedIds);
    const nextOrder = normalizePocketTabIds(order);
    const update = {
      [CAPTAIN_RETAINED_TAB_IDS_KEY]: nextRetainedIds,
      [CAPTAIN_TAB_ORDER_KEY]: nextOrder,
    };
    if (!preserveManifest) update[CAPTAIN_KEEP_MANIFEST_KEY] = normalizedManifest;
    await chrome.storage.local.set(update);
    return {
      conflict: false,
      manifest: normalizedManifest,
      retainedIds: nextRetainedIds,
      order: nextOrder,
    };
  });
}

function mutateCurrentSessionCaptainKeep(mutator, reason = 'unspecified') {
  return enqueueCaptainStateMutation(async () => {
    const [local, session] = await Promise.all([
      chrome.storage.local.get([
        CAPTAIN_KEEP_MANIFEST_KEY,
        CAPTAIN_RETAINED_TAB_IDS_KEY,
        CAPTAIN_TAB_ORDER_KEY,
        CAPTAIN_CONFIGS_KEY,
        CAPTAIN_CONFIG_KEY,
      ]),
      chrome.storage.session.get(CAPTAIN_SESSION_TOKEN_KEY),
    ]);
    const manifest = normalizeStartupKeepManifest(local[CAPTAIN_KEEP_MANIFEST_KEY]);
    const sessionToken = session[CAPTAIN_SESSION_TOKEN_KEY];
    if (!manifest || !sessionToken
      || local[CAPTAIN_KEEP_MANIFEST_KEY]?.sessionToken !== sessionToken) {
      traceCaptainStartup('manifest-mutation:skipped-session-mismatch', {
        reason,
        hasManifest: Boolean(manifest),
        sessionToken: sessionToken || null,
        manifestSessionToken: local[CAPTAIN_KEEP_MANIFEST_KEY]?.sessionToken || null,
      });
      return;
    }
    const retainedIds = Array.isArray(local[CAPTAIN_RETAINED_TAB_IDS_KEY])
      ? local[CAPTAIN_RETAINED_TAB_IDS_KEY].filter(Number.isInteger) : [];
    const order = Array.isArray(local[CAPTAIN_TAB_ORDER_KEY])
      ? local[CAPTAIN_TAB_ORDER_KEY].filter(Number.isInteger) : [];
    const configs = startupCaptainConfigs(local);
    const next = await mutator({ manifest, retainedIds, order, configs });
    if (!next) {
      traceCaptainStartup('manifest-mutation:no-change', { reason, retainedIds });
      return;
    }
    traceCaptainStartup('manifest-mutation:before-write', {
      reason,
      previousTabs: manifest.tabs,
      nextTabs: next.manifestTabs,
      previousRetainedIds: retainedIds,
      nextRetainedIds: next.retainedIds,
    });
    await chrome.storage.local.set({
      [CAPTAIN_KEEP_MANIFEST_KEY]: {
        version: 1,
        sessionToken,
        captainSetKey: startupCaptainSetKey(configs),
        tabs: next.manifestTabs,
      },
      [CAPTAIN_RETAINED_TAB_IDS_KEY]: next.retainedIds,
      [CAPTAIN_TAB_ORDER_KEY]: next.order,
    });
    traceCaptainStartup('manifest-mutation:write-complete', { reason });
  });
}

function refreshRetainedCaptainTab(tabId) {
  mutateCurrentSessionCaptainKeep(({ manifest, retainedIds, order, configs }) => {
    if (!retainedIds.includes(tabId)) return null;
    return chrome.tabs.get(tabId).then(tab => {
      const captainIndex = startupCaptainIndexForTab(tab, configs);
      if (captainIndex < 0) {
        return {
          manifestTabs: manifest.tabs.filter(item => item.tabId !== tabId),
          retainedIds: retainedIds.filter(id => id !== tabId),
          order: order.filter(id => id !== tabId),
        };
      }
      const existingIndex = manifest.tabs.findIndex(item => item.tabId === tabId);
      if (existingIndex < 0) return null;
      const manifestTabs = [...manifest.tabs];
      manifestTabs[existingIndex] = {
        keepId: manifestTabs[existingIndex].keepId || crypto.randomUUID(),
        state: 'live',
        tabId,
        captainIndex,
        captainKey: startupCaptainKey(configs[captainIndex]),
        url: startupTabUrl(tab),
        title: typeof tab.title === 'string' && tab.title.trim()
          ? tab.title.trim()
          : manifestTabs[existingIndex].title || '',
        ...(typeof manifestTabs[existingIndex].customLabel === 'string'
          && manifestTabs[existingIndex].customLabel
          ? { customLabel: manifestTabs[existingIndex].customLabel }
          : {}),
      };
      return { manifestTabs, retainedIds, order };
    });
  }, `tab-updated:${tabId}`).catch(() => {});
}

function forgetClosedRetainedCaptainTab(tabId, isWindowClosing) {
  if (isWindowClosing) {
    traceCaptainStartup('manifest-mutation:preserve-window-close', { tabId });
    return;
  }
  mutateCurrentSessionCaptainKeep(({ manifest, retainedIds, order }) => {
    if (!retainedIds.includes(tabId)) return null;
    const closedEntry = manifest.tabs.find(item => item.tabId === tabId);
    const manifestTabs = manifest.tabs.map(item => item.tabId === tabId ? {
      ...item,
      keepId: item.keepId || crypto.randomUUID(),
      state: 'dead',
      tabId: null,
    } : item);
    return {
      manifestTabs: closedEntry ? manifestTabs : manifest.tabs,
      retainedIds: retainedIds.filter(id => id !== tabId),
      order: order.filter(id => id !== tabId),
    };
  }, `tab-removed:${tabId}`).catch(() => {});
}

function mutateCaptainKeepLifecycle(operation, keepId = '', tabId = null, keepItem = null) {
  const task = async () => {
    const [local, session] = await Promise.all([
      chrome.storage.local.get([
        CAPTAIN_KEEP_MANIFEST_KEY,
        CAPTAIN_RETAINED_TAB_IDS_KEY,
        CAPTAIN_TAB_ORDER_KEY,
        CAPTAIN_CONFIGS_KEY,
        CAPTAIN_CONFIG_KEY,
      ]),
      chrome.storage.session.get([CAPTAIN_SESSION_TOKEN_KEY, CAPTAIN_PENDING_DEAD_ITEMS_KEY]),
    ]);
    const manifest = normalizeStartupKeepManifest(local[CAPTAIN_KEEP_MANIFEST_KEY]);
    const sessionToken = session[CAPTAIN_SESSION_TOKEN_KEY];
    let pendingDeadItems = normalizeCaptainPendingDeadItems(session[CAPTAIN_PENDING_DEAD_ITEMS_KEY]);
    if (!manifest || !sessionToken
      || local[CAPTAIN_KEEP_MANIFEST_KEY]?.sessionToken !== sessionToken) {
      throw new Error('Captain Keep state is not ready for this browser session');
    }
    const retainedIds = Array.isArray(local[CAPTAIN_RETAINED_TAB_IDS_KEY])
      ? local[CAPTAIN_RETAINED_TAB_IDS_KEY].filter(Number.isInteger) : [];
    const order = Array.isArray(local[CAPTAIN_TAB_ORDER_KEY])
      ? local[CAPTAIN_TAB_ORDER_KEY].filter(Number.isInteger) : [];
    let entryIndex = manifest.tabs.findIndex(item => keepId && item.keepId === keepId);
    if (entryIndex < 0 && Number.isInteger(tabId)) {
      entryIndex = manifest.tabs.findIndex(item => item.tabId === tabId);
    }
    if (!['restore-dead', 'reorder', 'reorder-pending-dead', 'keep-pending-dead', 'revive-pending-dead', 'revive-pending-existing', 'remove-pending-dead', 'restore-unkept-dead'].includes(operation)
      && entryIndex < 0) {
      throw new Error('Captain Keep item no longer exists');
    }
    const entry = entryIndex >= 0 ? manifest.tabs[entryIndex] : null;
    let nextTabs = [...manifest.tabs];
    let nextRetainedIds = [...retainedIds];
    let nextOrder = [...order];
    let createdTab = null;

    if (operation === 'reorder') {
      const requestedKeepIds = Array.isArray(keepItem?.orderedKeepIds)
        ? [...new Set(keepItem.orderedKeepIds.filter(id => typeof id === 'string' && id))]
        : [];
      const byKeepId = new Map(nextTabs.map(item => [item.keepId, item]));
      const requested = requestedKeepIds.map(id => byKeepId.get(id)).filter(Boolean);
      const requestedSet = new Set(requested.map(item => item.keepId));
      nextTabs = [...requested, ...nextTabs.filter(item => !requestedSet.has(item.keepId))];
      nextOrder = nextTabs
        .filter(item => item.state !== 'dead' && Number.isInteger(item.tabId))
        .map(item => item.tabId);
    } else if (operation === 'reorder-pending-dead') {
      const requestedIds = Array.isArray(keepItem?.orderedPendingDeadIds)
        ? [...new Set(keepItem.orderedPendingDeadIds.filter(id => typeof id === 'string' && id))]
        : [];
      const byId = new Map(pendingDeadItems.map(item => [item.id, item]));
      const requested = requestedIds.map(id => byId.get(id)).filter(Boolean);
      const requestedSet = new Set(requested.map(item => item.id));
      const placementById = new Map((Array.isArray(keepItem?.placements) ? keepItem.placements : [])
        .filter(item => typeof item?.id === 'string')
        .map(item => [item.id, Number.isInteger(item.beforeTabId) ? item.beforeTabId : null]));
      pendingDeadItems = [...requested, ...pendingDeadItems.filter(item => !requestedSet.has(item.id))]
        .map((item, index) => ({
          ...item,
          order: index,
          beforeTabId: placementById.has(item.id) ? placementById.get(item.id) : item.beforeTabId,
        }));
    } else if (operation === 'keep-pending-dead') {
      const pendingItem = pendingDeadItems.find(item => item.id === keepItem?.pendingItemId);
      if (!pendingItem) throw new Error('Dead Pending item no longer exists');
      const restored = {
        keepId: pendingItem.keepId || crypto.randomUUID(),
        state: 'dead',
        tabId: null,
        captainIndex: pendingItem.captainIndex,
        captainKey: pendingItem.captainKey,
        url: pendingItem.url,
        title: pendingItem.title,
        ...(Object.prototype.hasOwnProperty.call(keepItem || {}, 'customLabel')
          ? typeof keepItem.customLabel === 'string' && keepItem.customLabel.trim()
            ? { customLabel: keepItem.customLabel.trim() }
            : {}
          : pendingItem.customLabel ? { customLabel: pendingItem.customLabel } : {}),
      };
      const beforeIndex = nextTabs.findIndex(item => item.keepId === keepItem?.beforeKeepId);
      nextTabs.splice(beforeIndex >= 0 ? beforeIndex : nextTabs.length, 0, restored);
      pendingDeadItems = pendingDeadItems.filter(item => item.id !== pendingItem.id);
    } else if (operation === 'restore-dead') {
      const restored = normalizeStartupKeepManifest({ tabs: [keepItem] })?.tabs[0];
      if (!restored?.keepId || restored.state !== 'dead') throw new Error('Dead Captain Keep snapshot is invalid');
      const configs = startupCaptainConfigs(local);
      if (!configs[restored.captainIndex]
        || startupCaptainKey(configs[restored.captainIndex]) !== restored.captainKey
        || !startupMatchesCaptain({ url: restored.url }, configs[restored.captainIndex])) {
        throw new Error('Dead Captain Keep snapshot no longer matches the Captain configuration');
      }
      if (!nextTabs.some(item => item.keepId === restored.keepId)) {
        const targetIndex = Math.max(0, Math.min(Number(keepItem?.manifestIndex) || 0, nextTabs.length));
        nextTabs.splice(targetIndex, 0, restored);
      }
    } else if (operation === 'unkeep-dead') {
      if (entry?.state !== 'dead') throw new Error('Only a dead Captain Keep item can move to Pending');
      const beforePendingItem = pendingDeadItems.find(item => item.id === keepItem?.beforePendingDeadId);
      const pendingItem = {
        id: typeof keepItem?.pendingItemId === 'string' && keepItem.pendingItemId
          ? keepItem.pendingItemId : crypto.randomUUID(),
        keepId: entry.keepId,
        captainIndex: entry.captainIndex,
        captainKey: entry.captainKey,
        url: entry.url,
        title: entry.title,
        order: pendingDeadItems.length,
        beforeTabId: Number.isInteger(keepItem?.beforeTabId)
          ? keepItem.beforeTabId
          : Number.isInteger(beforePendingItem?.beforeTabId) ? beforePendingItem.beforeTabId : null,
        ...(entry.customLabel ? { customLabel: entry.customLabel } : {}),
      };
      nextTabs.splice(entryIndex, 1);
      const beforePendingIndex = pendingDeadItems.findIndex(item => item.id === keepItem?.beforePendingDeadId);
      pendingDeadItems.splice(beforePendingIndex >= 0 ? beforePendingIndex : pendingDeadItems.length, 0, pendingItem);
      pendingDeadItems = pendingDeadItems.map((item, index) => ({ ...item, order: index }));
      keepItem = { ...(keepItem || {}), pendingItem };
    } else if (operation === 'restore-unkept-dead') {
      const restored = normalizeStartupKeepManifest({ tabs: [keepItem?.keepEntry] })?.tabs[0];
      if (!restored?.keepId || restored.state !== 'dead') throw new Error('Dead Pending snapshot is invalid');
      pendingDeadItems = pendingDeadItems.filter(item => item.id !== keepItem?.pendingItemId);
      if (!nextTabs.some(item => item.keepId === restored.keepId)) {
        const targetIndex = Math.max(0, Math.min(Number(keepItem?.manifestIndex) || 0, nextTabs.length));
        nextTabs.splice(targetIndex, 0, restored);
      }
    } else if (operation === 'revive-pending-dead'
      || operation === 'revive-pending-existing') {
      const pendingItem = pendingDeadItems.find(item => item.id === keepItem?.pendingItemId);
      if (!pendingItem) throw new Error('Dead Pending item no longer exists');
      createdTab = operation === 'revive-pending-existing' && Number.isInteger(tabId)
        ? await chrome.tabs.get(tabId)
        : await createTabWithOrigin('captain-pending-revive', { url: pendingItem.url, active: true });
      pendingDeadItems = pendingDeadItems.filter(item => item.id !== pendingItem.id);
      if (!nextOrder.includes(createdTab.id)) nextOrder.push(createdTab.id);
    } else if (operation === 'remove-pending-dead') {
      const pendingItem = pendingDeadItems.find(item => item.id === keepItem?.pendingItemId);
      if (!pendingItem) throw new Error('Dead Pending item no longer exists');
      pendingDeadItems = pendingDeadItems.filter(item => item.id !== pendingItem.id);
    } else if (operation === 'kill') {
      if (entry.state === 'dead' || !Number.isInteger(entry.tabId)) throw new Error('Captain Keep item is already dead');
      nextTabs[entryIndex] = { ...entry, keepId: entry.keepId || crypto.randomUUID(), state: 'dead', tabId: null };
      nextRetainedIds = retainedIds.filter(id => id !== entry.tabId);
      nextOrder = order.filter(id => id !== entry.tabId);
    } else if (operation === 'revive' || operation === 'revive-existing') {
      if (entry.state !== 'dead') throw new Error('Captain Keep item is already live');
      createdTab = operation === 'revive-existing' && Number.isInteger(tabId)
        ? await chrome.tabs.get(tabId)
        : await createTabWithOrigin('captain-keep-revive', { url: entry.url, active: true });
      nextTabs[entryIndex] = {
        ...entry,
        state: 'live',
        tabId: createdTab.id,
        title: typeof createdTab.title === 'string' && createdTab.title ? createdTab.title : entry.title,
      };
      if (!nextRetainedIds.includes(createdTab.id)) nextRetainedIds.push(createdTab.id);
      const liveBefore = manifest.tabs.slice(0, entryIndex)
        .filter(item => item.state !== 'dead' && Number.isInteger(item.tabId))
        .map(item => item.tabId);
      const insertionIndex = liveBefore.length === 0
        ? 0
        : Math.max(...liveBefore.map(id => nextOrder.indexOf(id)).filter(index => index >= 0), -1) + 1;
      nextOrder.splice(insertionIndex, 0, createdTab.id);
    } else if (operation === 'remove-dead') {
      if (entry.state !== 'dead') throw new Error('Only a dead Captain Keep item can be removed');
      nextTabs.splice(entryIndex, 1);
    } else {
      throw new Error(`Unsupported Captain Keep lifecycle mutation: ${operation}`);
    }

    const nextManifest = {
      version: 1,
      sessionToken,
      captainSetKey: manifest.captainSetKey,
      tabs: nextTabs,
    };
    await chrome.storage.local.set({
      [CAPTAIN_KEEP_MANIFEST_KEY]: nextManifest,
      [CAPTAIN_RETAINED_TAB_IDS_KEY]: nextRetainedIds,
      [CAPTAIN_TAB_ORDER_KEY]: nextOrder,
    });
    await chrome.storage.session.set({ [CAPTAIN_PENDING_DEAD_ITEMS_KEY]: pendingDeadItems });
    if (operation === 'kill' && Number.isInteger(entry.tabId)) {
      try {
        await chrome.tabs.remove(entry.tabId);
      } catch (error) {
        await chrome.storage.local.set({
          [CAPTAIN_KEEP_MANIFEST_KEY]: local[CAPTAIN_KEEP_MANIFEST_KEY],
          [CAPTAIN_RETAINED_TAB_IDS_KEY]: retainedIds,
          [CAPTAIN_TAB_ORDER_KEY]: order,
        });
        throw error;
      }
    }
    return { manifest: nextManifest, retainedIds: nextRetainedIds, order: nextOrder, createdTab, pendingDeadItems, lifecycleItem: keepItem?.pendingItem || null };
  };
  return enqueueCaptainStateMutation(task);
}

function setRetainedCaptainCustomLabel(tabId, customLabel) {
  const nextLabel = typeof customLabel === 'string' ? customLabel.trim() : '';
  return mutateCurrentSessionCaptainKeep(({ manifest, retainedIds, order }) => {
    if (!retainedIds.includes(tabId)) return null;
    const existingIndex = manifest.tabs.findIndex(item => item.tabId === tabId);
    if (existingIndex < 0) return null;
    const manifestTabs = [...manifest.tabs];
    const existing = manifestTabs[existingIndex];
    if (nextLabel) {
      if (existing.customLabel === nextLabel) return null;
      manifestTabs[existingIndex] = { ...existing, customLabel: nextLabel };
    } else {
      if (!Object.prototype.hasOwnProperty.call(existing, 'customLabel')) return null;
      const { customLabel: _removed, ...withoutLabel } = existing;
      manifestTabs[existingIndex] = withoutLabel;
    }
    return { manifestTabs, retainedIds, order };
  }, `custom-label:${tabId}`);
}

/** Reuses a live Captain Keep tab when a just-created tab opens the same URL. */
async function redirectRecentCaptainDuplicate(tabId, rawUrl) {
  if (!Number.isInteger(tabId) || captainDuplicateRedirects.has(tabId)) return;
  const createdAt = recentlyCreatedTabTimes.get(tabId);
  if (!createdAt || Date.now() - createdAt > 120000) return;
  const identityUrl = getPocketIdentityUrl(rawUrl);
  if (!identityUrl) return;

  captainDuplicateRedirects.add(tabId);
  try {
    const [local, session] = await Promise.all([
      chrome.storage.local.get([
        CAPTAIN_KEEP_MANIFEST_KEY,
        CAPTAIN_CONFIGS_KEY,
        CAPTAIN_CONFIG_KEY,
      ]),
      chrome.storage.session.get(CAPTAIN_SESSION_TOKEN_KEY),
    ]);
    const manifest = normalizeStartupKeepManifest(local[CAPTAIN_KEEP_MANIFEST_KEY]);
    if (!manifest || !session[CAPTAIN_SESSION_TOKEN_KEY]
      || manifest.sessionToken !== session[CAPTAIN_SESSION_TOKEN_KEY]
      || manifest.captainSetKey !== startupCaptainSetKey(startupCaptainConfigs(local))) return;
    const keep = manifest.tabs.find(item => item.state !== 'dead'
      && Number.isInteger(item.tabId)
      && item.tabId !== tabId
      && getPocketIdentityUrl(item.url) === identityUrl);
    if (!keep) return;
    const keptTab = await chrome.tabs.get(keep.tabId).catch(() => null);
    const duplicateTab = await chrome.tabs.get(tabId).catch(() => null);
    if (!keptTab || !duplicateTab
      || getPocketIdentityUrl(duplicateTab.pendingUrl || duplicateTab.url || '') !== identityUrl) return;
    await chrome.tabs.update(keptTab.id, { active: true });
    await chrome.windows.update(keptTab.windowId, { focused: true });
    await chrome.tabs.remove(tabId);
  } catch (error) {
    console.warn('[tab-out] Could not reuse the matching Captain Keep tab:', error);
  } finally {
    captainDuplicateRedirects.delete(tabId);
  }
}

function mutateErrorSignals(mutator) {
  const operation = errorSignalMutationTail.then(async () => {
    const stored = await chrome.storage.session.get(ERROR_TAB_SIGNALS_KEY);
    const records = stored[ERROR_TAB_SIGNALS_KEY];
    const nextRecords = records && typeof records === 'object' ? { ...records } : {};
    if (!mutator(nextRecords)) return;
    await chrome.storage.session.set({ [ERROR_TAB_SIGNALS_KEY]: nextRecords });
  });
  errorSignalMutationTail = operation.catch(() => {});
  return operation;
}

function setErrorSignal(tabId, url, source, reason, navigationSequence = null, documentId = '') {
  if (!Number.isInteger(tabId) || tabId < 0 || !url || !source || !reason) return Promise.resolve();
  traceErrorDetect('signal-write-request', { tabId, url, source, reason, navigationSequence, documentId });
  const operation = mutateErrorSignals(records => {
    if (Number.isInteger(navigationSequence)
      && currentErrorNavigationByTab.get(tabId)?.sequence !== navigationSequence) return false;
    const key = String(tabId);
    const current = records[key];
    const record = current?.url === url
      ? { ...current, sources: { ...(current.sources || {}) } }
      : { url, sources: {} };
    if (record.sources[source]?.reason === reason
      && (record.sources[source]?.navigationSequence ?? null) === navigationSequence
      && (record.sources[source]?.documentId || '') === documentId) return false;
    record.sources[source] = {
      reason,
      ...(Number.isInteger(navigationSequence) ? { navigationSequence } : {}),
      ...(documentId ? { documentId } : {}),
    };
    records[key] = record;
    return true;
  });
  return operation.then(() => {
    traceErrorDetect('signal-write-result', { tabId, url, source, reason });
  }).catch(error => {
    traceErrorDetect('signal-write-error', {
      tabId,
      url,
      source,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  });
}

function errorSignalUrlsMatch(first, second) {
  if (!first || !second) return false;
  try {
    const firstUrl = new URL(first);
    const secondUrl = new URL(second);
    firstUrl.hash = '';
    secondUrl.hash = '';
    return firstUrl.href === secondUrl.href;
  } catch {
    return first === second;
  }
}

function clearErrorSignal(tabId, source, url = '', navigationSequence = null) {
  if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve();
  return mutateErrorSignals(records => {
    const key = String(tabId);
    const current = records[key];
    if (!current || (url && !errorSignalUrlsMatch(current.url, url))) return false;
    if (Number.isInteger(navigationSequence)
      && currentErrorNavigationByTab.get(tabId)?.sequence !== navigationSequence) return false;
    if (!source) {
      delete records[key];
      return true;
    }
    if (!current.sources?.[source]) return false;
    const sources = { ...current.sources };
    delete sources[source];
    if (Object.keys(sources).length === 0) delete records[key];
    else records[key] = { ...current, sources };
    return true;
  });
}

function beginErrorNavigation(details) {
  if (details.frameId !== 0 || !Number.isInteger(details.tabId) || details.tabId < 0) return null;
  const sequence = ++errorNavigationSequence;
  const documentId = typeof details.documentId === 'string' ? details.documentId : '';
  currentErrorNavigationByTab.set(details.tabId, { sequence, documentId, url: details.url || '' });
  if (documentId) errorNavigationSequenceByDocument.set(documentId, sequence);
  traceErrorDetect('navigation-begin', { tabId: details.tabId, url: details.url, sequence, documentId });
  return sequence;
}

function errorNavigationSequenceFor(details) {
  const documentId = typeof details?.documentId === 'string' ? details.documentId : '';
  if (documentId && errorNavigationSequenceByDocument.has(documentId)) {
    return errorNavigationSequenceByDocument.get(documentId);
  }
  const current = currentErrorNavigationByTab.get(details?.tabId);
  return current?.url === details?.url ? current.sequence : null;
}

function isCurrentErrorNavigation(details, sequence = errorNavigationSequenceFor(details)) {
  return Number.isInteger(sequence)
    && currentErrorNavigationByTab.get(details.tabId)?.sequence === sequence;
}

chrome.webNavigation.onBeforeNavigate.addListener(details => {
  beginErrorNavigation(details);
});

chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  const current = currentErrorNavigationByTab.get(details.tabId);
  if (!current || current.url !== details.url) return;
  const documentId = typeof details.documentId === 'string' ? details.documentId : '';
  if (!documentId) return;
  current.documentId = documentId;
  errorNavigationSequenceByDocument.set(documentId, current.sequence);
});

function clearErrorSignalForDifferentUrl(tabId, url) {
  if (!Number.isInteger(tabId) || tabId < 0 || !url) return Promise.resolve();
  return mutateErrorSignals(records => {
    const key = String(tabId);
    const current = records[key];
    if (!current || errorSignalUrlsMatch(current.url, url)) return false;
    delete records[key];
    return true;
  });
}

// Preserve an error through a same-URL retry until that navigation reaches a
// definitive result. Chrome may abort an internal retry after showing its
// error page; clearing here would otherwise erase the valid preceding error.
chrome.webRequest.onBeforeRequest.addListener(details => {
  const sequence = currentErrorNavigationByTab.get(details.tabId)?.sequence;
  if (Number.isInteger(sequence) && details.requestId) {
    errorNavigationSequenceByRequest.set(details.requestId, sequence);
  }
  clearErrorSignalForDifferentUrl(details.tabId, details.url).catch(() => {});
}, { urls: ['<all_urls>'], types: ['main_frame'] });

// HTTP failures have a concrete response code even when the site's rendered
// page uses custom branding or contains no recognizable error wording.
chrome.webRequest.onCompleted.addListener(details => {
  const sequence = errorNavigationSequenceByRequest.get(details.requestId);
  errorNavigationSequenceByRequest.delete(details.requestId);
  if (Number.isInteger(sequence)
    && currentErrorNavigationByTab.get(details.tabId)?.sequence !== sequence) {
    traceErrorDetect('http-complete-stale', { tabId: details.tabId, url: details.url, sequence });
    return;
  }
  if (details.statusCode >= 400 && details.statusCode <= 599) {
    setErrorSignal(
      details.tabId,
      details.url,
      'http',
      `HTTP ${details.statusCode}`,
      sequence,
    ).catch(() => {});
  } else {
    clearErrorSignal(details.tabId, '', details.url, sequence).catch(() => {});
  }
}, { urls: ['<all_urls>'], types: ['main_frame'] });

chrome.webRequest.onErrorOccurred.addListener(details => {
  errorNavigationSequenceByRequest.delete(details.requestId);
}, { urls: ['<all_urls>'], types: ['main_frame'] });

// Navigation failures cover DNS, connection, TLS, and timeout failures that
// never produce an HTTP response. User-cancelled loads are not error pages.
chrome.webNavigation.onErrorOccurred.addListener(details => {
  const sequence = errorNavigationSequenceFor(details);
  traceErrorDetect('navigation-error', {
    tabId: details.tabId,
    url: details.url,
    frameId: details.frameId,
    error: details.error,
    sequence,
    ignored: details.frameId !== 0 || details.error === 'net::ERR_ABORTED'
      || !isCurrentErrorNavigation(details, sequence),
  });
  if (details.frameId !== 0 || details.error === 'net::ERR_ABORTED'
    || !isCurrentErrorNavigation(details, sequence)) return;
  setErrorSignal(
    details.tabId,
    details.url,
    'navigation',
    details.error,
    sequence,
    details.documentId,
  ).catch(() => {});
});

chrome.webNavigation.onCompleted.addListener(details => {
  if (details.frameId !== 0) return;
  const sequence = errorNavigationSequenceFor(details);
  if (!isCurrentErrorNavigation(details, sequence)) return;
  clearErrorSignal(details.tabId, 'navigation', details.url, sequence).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!matchesRuntimeMessage(message, TAB_OUT_MESSAGES.SEMANTIC_ERROR)
    || !Number.isInteger(sender.tab?.id)) return;
  const url = typeof message.url === 'string' ? message.url : sender.tab.url || '';
  const reason = typeof message.reason === 'string' ? message.reason : '';
  const documentId = typeof sender.documentId === 'string' ? sender.documentId : '';
  const currentNavigation = currentErrorNavigationByTab.get(sender.tab.id);
  if (documentId && currentNavigation?.documentId
    && currentNavigation.documentId !== documentId) return;
  const navigationSequence = documentId
    ? errorNavigationSequenceByDocument.get(documentId)
      ?? (currentNavigation?.documentId === documentId ? currentNavigation.sequence : null)
    : currentNavigation?.sequence ?? null;
  if (Number.isInteger(navigationSequence)
    && currentErrorNavigationByTab.get(sender.tab.id)?.sequence !== navigationSequence) return;
  // Bot/security challenges can legitimately use an HTTP 403 while the site
  // verifies the browser. Their page-level semantics override that transient
  // response code so they do not enter the Error candidate batch.
  const operation = message.securityVerification === true
    ? clearErrorSignal(sender.tab.id, '', url, navigationSequence)
    : reason
    ? setErrorSignal(sender.tab.id, url, 'semantic', reason, navigationSequence, documentId)
    : clearErrorSignal(sender.tab.id, 'semantic', url, navigationSequence);
  operation.catch(() => {});
});

chrome.runtime.onMessage.addListener(message => {
  if (!matchesRuntimeMessage(message, TAB_OUT_MESSAGES.RECORD_TAB_ORIGIN)) return;
  rememberTabOutCreatedTab(message.tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!matchesRuntimeMessage(message, TAB_OUT_MESSAGES.DIAGNOSTICS_PING)) return;
  sendResponse({
    ok: true,
    contractVersion: TabOutContracts.CONTRACT_VERSION,
    workerTimestamp: Date.now(),
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!matchesRuntimeMessage(message, TAB_OUT_MESSAGES.GET_DOI_TITLE)) return;
  cachedDoiTitle(message.doi).then(
    title => sendResponse({ ok: true, title }),
    error => sendResponse({ ok: false, title: '', error: String(error?.message || error) }),
  );
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!matchesRuntimeMessage(message, TAB_OUT_MESSAGES.GET_ARXIV_TITLE)) return;
  cachedArxivTitle(message.arxivId).then(
    title => sendResponse({ ok: true, title }),
    error => sendResponse({ ok: false, title: '', error: String(error?.message || error) }),
  );
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!matchesRuntimeMessage(message, TAB_OUT_MESSAGES.MUTATE_POCKET_STATE)) return;
  mutatePocketState(
    message.operation,
    message.tabIds,
    message.itemIds,
    message.customLabel,
    message.pocketItem,
  ).then(
    state => sendResponse({ ok: true, ...state }),
    error => sendResponse({ ok: false, error: String(error?.message || error) }),
  );
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!matchesRuntimeMessage(message, TAB_OUT_MESSAGES.SET_CAPTAIN_KEEP_LABEL)) return;
  setRetainedCaptainCustomLabel(message.tabId, message.customLabel).then(
    () => sendResponse({ ok: true }),
    error => sendResponse({ ok: false, error: String(error?.message || error) }),
  );
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!matchesRuntimeMessage(message, TAB_OUT_MESSAGES.MUTATE_CAPTAIN_KEEP_LIFECYCLE)) return;
  mutateCaptainKeepLifecycle(message.operation, message.keepId, message.tabId, message.keepItem).then(
    result => sendResponse({ ok: true, ...result }),
    error => sendResponse({ ok: false, error: String(error?.message || error) }),
  );
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!matchesRuntimeMessage(message, TAB_OUT_MESSAGES.REPLACE_CAPTAIN_STATE)) return;
  replaceCaptainStateFromDashboard(message.state).then(
    state => sendResponse({ ok: true, ...state }),
    error => sendResponse({ ok: false, error: String(error?.message || error) }),
  );
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!matchesRuntimeMessage(message, TAB_OUT_MESSAGES.SET_TAB_CUSTOM_LABEL)) return;
  mutateSessionTabCustomLabel(message.tabId, message.customLabel).then(
    tabCustomLabels => sendResponse({ ok: true, tabCustomLabels }),
    error => sendResponse({ ok: false, error: String(error?.message || error) }),
  );
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!matchesRuntimeMessage(message, TAB_OUT_MESSAGES.AMBIENCE_COMMAND)) return;
  if (message.command !== 'mix') traceAmbience('message-received', { command: message.command });
  const operation = ambienceCommandTail.then(
    () => handleAmbienceCommand(message.command, message.mix),
    () => handleAmbienceCommand(message.command, message.mix),
  );
  ambienceCommandTail = operation.catch(() => {});
  operation.then(
    state => sendResponse({ ok: true, state }),
    error => sendResponse({ ok: false, error: String(error?.message || error) }),
  );
  return true;
});

chrome.runtime.onMessage.addListener(message => {
  if (!matchesRuntimeMessage(message, TAB_OUT_MESSAGES.AMBIENCE_OFFSCREEN_TRACE)) return;
  traceAmbience(`offscreen:${message.stage}`, message.detail || {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!matchesRuntimeMessage(message, TAB_OUT_MESSAGES.RETRY_CAPTAIN_STARTUP_RESTORE)) return;
  traceCaptainStartup('restore:dashboard-retry-request', {});
  beginCaptainStartupPrune().then(
    () => sendResponse({ ok: true }),
    error => {
      traceCaptainStartup('restore:dashboard-retry-error', {
        error: String(error?.message || error),
      });
      sendResponse({ ok: false, error: String(error?.message || error) });
    },
  );
  return true;
});

/**
 * updateBadge()
 *
 * Counts tabs managed by the dashboard and updates the extension badge.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    const tabOutRoot = chrome.runtime.getURL('');
    const count = tabs.filter(t => {
      const url = t.pendingUrl || t.url || '';
      const normalized = url.toLowerCase();
      return Boolean(url)
        && !url.startsWith(tabOutRoot)
        && normalized !== 'chrome://newtab/'
        && normalized !== 'about:blank'
        && normalized !== 'about:newtab';
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = '#3d7a4a'; // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e'; // Amber — things are piling up
    } else {
      color = '#b35a5a'; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });

  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' });
  }
}

let badgeUpdateTimer = null;

/** Coalesces tab event bursts so a bulk close performs one full tab query. */
function scheduleBadgeUpdate() {
  clearTimeout(badgeUpdateTimer);
  badgeUpdateTimer = setTimeout(() => {
    badgeUpdateTimer = null;
    updateBadge();
  }, 100);
}

const pendingRemovedTabIds = new Set();
let removedTabsMaintenanceTimer = null;

/** Removes error metadata for an entire close burst with one storage mutation. */
function scheduleRemovedTabsMaintenance(tabId) {
  if (Number.isInteger(tabId)) pendingRemovedTabIds.add(tabId);
  clearTimeout(removedTabsMaintenanceTimer);
  removedTabsMaintenanceTimer = setTimeout(() => {
    removedTabsMaintenanceTimer = null;
    const removedIds = [...pendingRemovedTabIds];
    pendingRemovedTabIds.clear();
    if (removedIds.length === 0) return;

    mutateErrorSignals(records => {
      let changed = false;
      for (const removedId of removedIds) {
        const key = String(removedId);
        if (!Object.prototype.hasOwnProperty.call(records, key)) continue;
        delete records[key];
        changed = true;
      }
      return changed;
    }).catch(() => {});
  }, 100);
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  traceCaptainStartup('event:onStartup', {});
  updateBadge();
  enqueueCaptainStateMutation(markPersistentTabsDeadForNewSession)
    .then(() => beginCaptainStartupPrune()).catch(error => {
    console.warn('[tab-out] Could not schedule Captain startup cleanup:', error);
  });
});

chrome.windows.onRemoved.addListener(windowId => {
  markCaptainRestoreWaitingForWindow(windowId).catch(error => {
    traceCaptainStartup('window:close-state-error', {
      windowId,
      error: String(error?.message || error),
    });
  });
});

chrome.windows.onCreated.addListener(windowInfo => {
  resumeCaptainRestoreForWindow(windowInfo).catch(error => {
    traceCaptainStartup('window:create-resume-error', {
      windowId: windowInfo?.id,
      error: String(error?.message || error),
    });
  });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== STARTUP_PRUNE_ALARM) return;
  traceCaptainStartup('event:alarm', {
    name: alarm.name,
    scheduledTime: alarm.scheduledTime,
    now: Date.now(),
  });
  const operation = startupPruneTail.then(
    () => enqueueCaptainStateMutation(runCaptainStartupPrune),
    () => enqueueCaptainStateMutation(runCaptainStartupPrune),
  );
  startupPruneTail = operation.catch(() => {});
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(tab => {
  const createdAt = Date.now();
  recentlyCreatedTabTimes.set(tab.id, createdAt);
  setTimeout(() => {
    if (recentlyCreatedTabTimes.get(tab.id) === createdAt) recentlyCreatedTabTimes.delete(tab.id);
  }, 120000);
  const initialUrl = tab.pendingUrl || tab.url || '';
  if (initialUrl) setTimeout(() => { void redirectRecentCaptainDuplicate(tab.id, initialUrl); }, 50);
  scheduleBadgeUpdate();
  noteStartupTabActivity({ event: 'created', tab: startupTabTrace(tab) });
  traceStartupTabCreated(tab).catch(error => {
    console.warn('[tab-out] Could not trace startup tab origin:', error);
  });
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  recentlyCreatedTabTimes.delete(tabId);
  traceCaptainStartup('event:tab-removed', {
    tabId,
    windowId: removeInfo?.windowId,
    isWindowClosing: Boolean(removeInfo?.isWindowClosing),
  });
  mutateSessionTabCustomLabel(tabId, '').catch(() => {});
  currentErrorNavigationByTab.delete(tabId);
  scheduleRemovedTabsMaintenance(tabId);
  scheduleBadgeUpdate();
  forgetClosedRetainedCaptainTab(tabId, Boolean(removeInfo?.isWindowClosing));
});

// Update badge when a tab's URL changes.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  scheduleBadgeUpdate();
  if (Object.prototype.hasOwnProperty.call(changeInfo, 'url')
    || Object.prototype.hasOwnProperty.call(changeInfo, 'status')) {
    noteStartupTabActivity({ event: 'updated', tabId, changeInfo });
  }
  if (Object.prototype.hasOwnProperty.call(changeInfo, 'url')
    || Object.prototype.hasOwnProperty.call(changeInfo, 'title')) {
    refreshRetainedCaptainTab(tabId);
  }
  if (typeof changeInfo.url === 'string' && changeInfo.url) {
    setTimeout(() => { void redirectRecentCaptainDuplicate(tabId, changeInfo.url); }, 50);
  }
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
