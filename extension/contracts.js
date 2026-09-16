(() => {
  'use strict';

  const CONTRACT_VERSION = 2;

  const STORAGE_KEYS = Object.freeze({
    ARCHIVED_TAB_IDS_LEGACY: 'archivedTabIds',
    POCKET_TAB_IDS: 'pocketTabIds',
    POCKET_ITEMS: 'pocketItems',
    POCKET_LIVE_ITEM_IDS: 'pocketLiveItemIds',
    POCKET_SESSION_MIGRATION: 'pocketSessionStateMigrationComplete',
    POCKET_VISIBLE: 'coinPocketVisible',
    POCKET_ENABLED: 'readLaterEnabled',
    POCKET_POSITION: 'pocketPosition',
    POCKET_GROUP_LOOSE_TABS: 'pocketGroupLooseTabs',
    POCKET_GROUP_ORDER: 'pocketGroupOrder',
    POCKET_TAB_ORDER: 'pocketTabOrder',
    POCKET_AMBIENCE: 'ambientlyState',
    AMBIENCE_MIX: 'ambientlyMix',
    POCKET_AMBIENCE_LEGACY: 'ambientRainState',
    POCKET_COIN_MODE_LEGACY: 'coinSessionMode',
    POCKET_DEFAULT_COIN_MODE_LEGACY: 'defaultCoinMode',
    POCKET_DEMON_BULK_LEGACY: 'demonBulkIncludesArchive',
    POCKET_PURE_DEMON_LEGACY: 'pureDemonMode',
    TAB_CUSTOM_LABELS: 'tabCustomLabels',
    CAPTAIN_CONFIG_LEGACY: 'captainConfig',
    CAPTAIN_CONFIGS: 'captainConfigs',
    CAPTAIN_KEEP_MANIFEST: 'captainKeepManifest',
    CAPTAIN_SESSION_TOKEN: 'captainSessionToken',
    CAPTAIN_PENDING_DEAD_ITEMS: 'captainPendingDeadItems',
    CAPTAIN_STARTUP_PRUNE_STATE: 'captainStartupPruneState',
    // These values retain their original names so existing installations keep
    // their data. Code uses Captain terminology for the aliases.
    CAPTAIN_RETAINED_TAB_IDS: 'pdfRetainedTabIds',
    CAPTAIN_TAB_ORDER: 'pdfTabOrder',
    UI_LANGUAGE: 'uiLanguage',
    DASHBOARD_COLUMNS: 'dashboardColumns',
    DAILY_QUOTE_STATE: 'dailyQuoteState',
    UNDO_HISTORY: 'undoHistory',
    REDO_HISTORY: 'redoHistory',
    ERROR_TAB_SIGNALS: 'errorTabSignals',
    DOI_TITLE_CACHE: 'doiTitleCache',
    ARXIV_TITLE_CACHE: 'arxivTitleCache',
    CAPTAIN_KEEP_TRACE_LOG: 'captainKeepTraceLog',
    CAPTAIN_STARTUP_TRACE_LOG: 'captainStartupTraceLog',
  });

  const MESSAGES = Object.freeze({
    AMBIENCE_COMMAND: 'tabout:ambience-command',
    AMBIENCE_OFFSCREEN_TRACE: 'tabout:ambience-offscreen-trace',
    AMBIENCE_TRACE: 'tabout:ambience-trace',
    GET_ARXIV_TITLE: 'tabout:get-arxiv-title',
    GET_CITATION_TITLE: 'tabout:get-citation-title',
    GET_DOI_TITLE: 'tabout:get-doi-title',
    DIAGNOSTICS_PING: 'tabout:diagnostics-ping',
    MUTATE_CAPTAIN_KEEP_LIFECYCLE: 'tabout:mutate-captain-keep-lifecycle',
    MUTATE_POCKET_STATE: 'tabout:mutate-pocket-state',
    RECORD_TAB_ORIGIN: 'tabout:record-tab-origin',
    REPLACE_CAPTAIN_STATE: 'tabout:replace-captain-state',
    RETRY_CAPTAIN_STARTUP_RESTORE: 'tabout:retry-captain-startup-restore',
    SEMANTIC_ERROR: 'tabout:semantic-error',
    SET_CAPTAIN_KEEP_LABEL: 'tabout:set-captain-keep-label',
    SET_TAB_CUSTOM_LABEL: 'tabout:set-tab-custom-label',
  });

  const DOM_EVENTS = Object.freeze({
    AMBIENCE_PRIME: 'tabout:ambience-prime',
    AMBIENCE_TOGGLE: 'tabout:ambience-toggle',
    CANDIDATE_ACTION: 'tabout:candidate-action',
    POCKET_VISIBILITY_CHANGE: 'tabout:coin-pocket-visibility-change',
    POCKET_VISIBILITY_SYNC: 'tabout:coin-pocket-visibility-sync',
  });

  const MESSAGE_CONTRACTS = Object.freeze({
    [MESSAGES.AMBIENCE_COMMAND]: Object.freeze({ target: 'background', fields: Object.freeze(['command', 'active', 'mix', 'startedAt', 'instant']), required: Object.freeze(['command']) }),
    [MESSAGES.AMBIENCE_OFFSCREEN_TRACE]: Object.freeze({ target: 'background', fields: Object.freeze(['stage', 'detail']), required: Object.freeze(['stage']) }),
    [MESSAGES.AMBIENCE_TRACE]: Object.freeze({ target: 'dashboard', fields: Object.freeze(['stage', 'detail']), required: Object.freeze(['stage']) }),
    [MESSAGES.GET_ARXIV_TITLE]: Object.freeze({ target: 'background', fields: Object.freeze(['arxivId']), required: Object.freeze(['arxivId']) }),
    [MESSAGES.GET_CITATION_TITLE]: Object.freeze({ target: null, fields: Object.freeze([]), required: Object.freeze([]) }),
    [MESSAGES.GET_DOI_TITLE]: Object.freeze({ target: 'background', fields: Object.freeze(['doi']), required: Object.freeze(['doi']) }),
    [MESSAGES.DIAGNOSTICS_PING]: Object.freeze({ target: 'background', fields: Object.freeze(['requestId']), required: Object.freeze(['requestId']) }),
    [MESSAGES.MUTATE_CAPTAIN_KEEP_LIFECYCLE]: Object.freeze({ target: 'background', fields: Object.freeze(['operation', 'keepId', 'tabId', 'keepItem']), required: Object.freeze(['operation']) }),
    [MESSAGES.MUTATE_POCKET_STATE]: Object.freeze({ target: 'background', fields: Object.freeze(['operation', 'tabIds', 'itemIds', 'customLabel', 'pocketItem']), required: Object.freeze(['operation']) }),
    [MESSAGES.RECORD_TAB_ORIGIN]: Object.freeze({ target: 'background', fields: Object.freeze(['tabId']), required: Object.freeze(['tabId']) }),
    [MESSAGES.REPLACE_CAPTAIN_STATE]: Object.freeze({ target: 'background', fields: Object.freeze(['state']), required: Object.freeze(['state']) }),
    [MESSAGES.RETRY_CAPTAIN_STARTUP_RESTORE]: Object.freeze({ target: 'background', fields: Object.freeze([]), required: Object.freeze([]) }),
    [MESSAGES.SEMANTIC_ERROR]: Object.freeze({ target: null, fields: Object.freeze(['url', 'reason', 'securityVerification']), required: Object.freeze(['url', 'reason', 'securityVerification']) }),
    [MESSAGES.SET_CAPTAIN_KEEP_LABEL]: Object.freeze({ target: 'background', fields: Object.freeze(['tabId', 'customLabel']), required: Object.freeze(['tabId', 'customLabel']) }),
    [MESSAGES.SET_TAB_CUSTOM_LABEL]: Object.freeze({ target: 'background', fields: Object.freeze(['tabId', 'customLabel']), required: Object.freeze(['tabId', 'customLabel']) }),
  });

  function createRuntimeMessage(type, payload = {}, targetOverride = undefined) {
    const contract = MESSAGE_CONTRACTS[type];
    if (!contract) throw new TypeError(`Unknown Tab Out message type: ${type}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError(`Payload for ${type} must be an object`);
    }
    const unknownFields = Object.keys(payload).filter(field => !contract.fields.includes(field));
    if (unknownFields.length > 0) {
      throw new TypeError(`Unexpected ${type} payload field: ${unknownFields[0]}`);
    }
    const missingField = contract.required.find(field => !Object.hasOwn(payload, field));
    if (missingField) throw new TypeError(`Missing ${type} payload field: ${missingField}`);
    const target = targetOverride === undefined ? contract.target : targetOverride;
    return Object.freeze({ ...(target ? { target } : {}), type, ...payload });
  }

  function matchesRuntimeMessage(message, type, targetOverride = undefined) {
    const contract = MESSAGE_CONTRACTS[type];
    if (!contract || !message || message.type !== type) return false;
    const target = targetOverride === undefined ? contract.target : targetOverride;
    return target ? message.target === target : true;
  }

  function normalizeTabIds(value) {
    const candidates = Array.isArray(value) ? value : [];
    return [...new Set(candidates.filter(Number.isInteger))];
  }

  function normalizeOrderKeys(value) {
    const candidates = Array.isArray(value) ? value : [];
    return [...new Set(candidates.filter(key => Number.isInteger(key)
      || (typeof key === 'string' && key.length > 0)))];
  }

  function normalizeCustomLabel(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizePocketItems(value) {
    if (!Array.isArray(value)) return [];
    const seenIds = new Set();
    return value.flatMap((item, index) => {
      const id = typeof item?.id === 'string' ? item.id : '';
      const url = typeof item?.url === 'string' ? item.url : '';
      if (!id || !url || seenIds.has(id)) return [];
      seenIds.add(id);
      const customLabel = normalizeCustomLabel(item.customLabel);
      return [{
        id,
        url,
        title: typeof item.title === 'string' ? item.title : '',
        order: Number.isFinite(item.order) ? item.order : index,
        state: item.state === 'live' ? 'live' : 'dead',
        tabId: item.state === 'live' && Number.isInteger(item.tabId) ? item.tabId : null,
        ...(customLabel ? { customLabel } : {}),
      }];
    });
  }

  function normalizePocketLiveItemIds(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value)
      .filter(([tabId, itemId]) => Number.isInteger(Number(tabId))
        && typeof itemId === 'string' && itemId.length > 0));
  }

  function normalizeTabCustomLabels(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value)
      .filter(([tabId, label]) => Number.isInteger(Number(tabId)) && normalizeCustomLabel(label))
      .map(([tabId, label]) => [tabId, normalizeCustomLabel(label)]));
  }

  globalThis.TabOutContracts = Object.freeze({
    CONTRACT_VERSION,
    DOM_EVENTS,
    MESSAGE_CONTRACTS,
    MESSAGES,
    STORAGE_KEYS,
    createRuntimeMessage,
    matchesRuntimeMessage,
    normalizeCustomLabel,
    normalizeOrderKeys,
    normalizePocketItems,
    normalizePocketLiveItemIds,
    normalizeTabCustomLabels,
    normalizeTabIds,
  });
})();
