(() => {
  'use strict';

  const GROUP_COLORS = Object.freeze([
    'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
  ]);
  const TASK_GROUP_ICONS = Object.freeze(['circle', 'book', 'bambu']);

  const BUILT_IN_PROFILES = Object.freeze({
    'feishu.cn': Object.freeze({
      title: '书',
      color: 'cyan',
      icon: 'book',
      label: 'Feishu / 飞书',
      matchRules: Object.freeze(['feishu.cn']),
    }),
    'bambulab.com': Object.freeze({
      title: '竹',
      color: 'green',
      icon: 'bambu',
      label: 'Bambu Lab / 拓竹',
      matchRules: Object.freeze(['bambulab.com', 'bambulab.cn', 'bambu.com', 'bambu.cn']),
    }),
    'dl.acm.org': Object.freeze({
      title: 'ACM Digital Library',
      color: 'purple',
      icon: 'book',
      label: 'ACM Digital Library',
      matchRules: Object.freeze(['dl.acm.org']),
    }),
  });

  function normalizeDomain(value) {
    let candidate = String(value || '').trim().toLowerCase();
    if (!candidate) return '';
    try {
      if (!candidate.includes('://')) candidate = `https://${candidate}`;
      candidate = new URL(candidate).hostname.toLowerCase();
    } catch {
      return '';
    }
    return candidate.replace(/^www\./, '').replace(/\.$/, '');
  }

  function domainFamilyValues(value) {
    if (Array.isArray(value)) return [...value];
    if (typeof value !== 'string') return [];
    return value.split(/[\s,;]+/);
  }

  function normalizeDomainFamily(value, fallbackDomain = '') {
    const source = domainFamilyValues(value);
    if (source.length === 0 && fallbackDomain) source.push(fallbackDomain);
    return [...new Set(source.map(normalizeDomain).filter(Boolean))];
  }

  function normalizePageUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      url.hash = '';
      return url.href;
    } catch {
      return '';
    }
  }

  function taskRuleValues(value) {
    if (Array.isArray(value)) return [...value];
    if (typeof value !== 'string') return [];
    return value.split(/[\s,;]+/);
  }

  function normalizeTaskRule(value) {
    const requestedKind = value && typeof value === 'object'
      ? value.kind || value.type : '';
    const requestedValue = value && typeof value === 'object'
      ? value.value : value;
    const raw = String(requestedValue || '').trim();
    if (!raw) return null;
    const pageUrl = requestedKind === 'page' || /^https?:\/\//i.test(raw)
      ? normalizePageUrl(raw) : '';
    if (pageUrl) return { kind: 'page', value: pageUrl };
    const domain = normalizeDomain(raw);
    return domain ? { kind: 'domain', value: domain } : null;
  }

  function normalizeTaskRules(value, fallbackDomain = '') {
    const source = taskRuleValues(value);
    if (source.length === 0 && fallbackDomain) source.push(fallbackDomain);
    const seen = new Set();
    return source.flatMap(item => {
      const rule = normalizeTaskRule(item);
      if (!rule) return [];
      const key = `${rule.kind}:${rule.value}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [rule];
    });
  }

  function serializeTaskRules(rules) {
    return normalizeTaskRules(rules).map(rule => rule.value);
  }

  function builtInProfileForRules(value) {
    const rules = serializeTaskRules(value);
    return Object.values(BUILT_IN_PROFILES).find(profile =>
      profile.matchRules.length === rules.length
      && profile.matchRules.every((rule, index) => rule === rules[index])) || null;
  }

  const builtInProfileForFamily = builtInProfileForRules;

  function legacyDomainFamily(domain) {
    const normalized = normalizeDomain(domain);
    return BUILT_IN_PROFILES[normalized]?.matchRules || (normalized ? [normalized] : []);
  }

  function normalizeConfig(value, index = 0) {
    const enabled = value
      ? value.enabled !== false
      : index === 0;
    const requestedType = value?.type === 'task'
      || value?.type === 'domain'
      || (index === 1 && !value) ? 'task' : 'pdf';
    const explicitRules = value?.matchRules ?? value?.rules ?? value?.sites;
    const hasExplicitRules = Array.isArray(explicitRules) || typeof explicitRules === 'string';
    const hasExplicitFamily = Array.isArray(value?.domains) || typeof value?.domains === 'string'
      || typeof value?.domainFamily === 'string';
    const matchRules = requestedType === 'task'
      ? hasExplicitRules
        ? normalizeTaskRules(explicitRules, value?.domain)
        : hasExplicitFamily
          ? normalizeTaskRules(value.domains ?? value.domainFamily, value?.domain)
          : normalizeTaskRules(legacyDomainFamily(value?.domain))
      : [];
    const type = requestedType;
    const domains = matchRules.filter(rule => rule.kind === 'domain').map(rule => rule.value);
    const firstRule = matchRules[0];
    const primaryDomain = (() => {
      if (firstRule?.kind === 'domain') return firstRule.value;
      try { return firstRule?.kind === 'page' ? new URL(firstRule.value).hostname : ''; } catch { return ''; }
    })();
    const allowedColors = new Set(GROUP_COLORS);
    const allowedIcons = new Set(TASK_GROUP_ICONS);
    const profile = builtInProfileForRules(matchRules);
    return {
      enabled,
      type,
      domain: primaryDomain,
      domains,
      matchRules,
      customTitle: typeof value?.customTitle === 'string'
        ? value.customTitle.trim().slice(0, 40) : '',
      groupColor: allowedColors.has(value?.groupColor)
        ? value.groupColor : (index === 0 ? 'blue' : 'purple'),
      keepAreaEnabled: value?.keepAreaEnabled !== false,
      icon: allowedIcons.has(value?.icon)
        ? value.icon : (requestedType === 'pdf' ? 'book' : profile?.icon || 'circle'),
    };
  }

  function normalizeCustomLabel(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeKeepManifest(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.tabs)) return null;
    return {
      version: 1,
      sessionToken: typeof value.sessionToken === 'string' ? value.sessionToken : '',
      captainSetKey: typeof value.captainSetKey === 'string' ? value.captainSetKey : '',
      tabs: value.tabs
        .filter(item => item && typeof item.url === 'string' && item.url)
        .map(item => {
          const captainIndex = Number.isInteger(item.captainIndex) ? item.captainIndex : 0;
          const customLabel = normalizeCustomLabel(item.customLabel);
          return {
            keepId: typeof item.keepId === 'string' && item.keepId
              ? item.keepId
              : `legacy-${captainIndex}-${item.tabId ?? 'dead'}-${item.url}`,
            state: item.state === 'dead' ? 'dead' : 'live',
            tabId: Number.isInteger(item.tabId) ? item.tabId : null,
            captainIndex,
            captainKey: typeof item.captainKey === 'string' ? item.captainKey : '',
            url: item.url,
            title: typeof item.title === 'string' ? item.title : '',
            ...(customLabel ? { customLabel } : {}),
          };
        }),
    };
  }

  function normalizePendingDeadItems(value) {
    if (!Array.isArray(value)) return [];
    const ids = new Set();
    return value.flatMap((item, index) => {
      const id = typeof item?.id === 'string' && item.id ? item.id : '';
      if (!id || ids.has(id) || !Number.isInteger(item?.captainIndex)
        || typeof item?.captainKey !== 'string'
        || typeof item?.url !== 'string' || !item.url) return [];
      ids.add(id);
      const customLabel = normalizeCustomLabel(item.customLabel);
      return [{
        id,
        keepId: typeof item.keepId === 'string' ? item.keepId : '',
        captainIndex: item.captainIndex,
        captainKey: item.captainKey,
        url: item.url,
        title: typeof item.title === 'string' ? item.title : '',
        order: Number.isFinite(item.order) ? item.order : index,
        beforeTabId: Number.isInteger(item.beforeTabId) ? item.beforeTabId : null,
        ...(customLabel ? { customLabel } : {}),
      }];
    });
  }

  function normalizeConfigs(value, legacyValue) {
    if (Array.isArray(value)) {
      return value.map((config, index) => normalizeConfig(config, index));
    }
    return [normalizeConfig(legacyValue, 0)];
  }

  function configKey(config) {
    if (!config?.enabled) return 'disabled';
    const isTaskConfig = config.type === 'task' || config.type === 'domain';
    if (!isTaskConfig) return 'pdf';
    // Keep the historical primary-domain key stable so existing Keep manifests
    // survive migration to mixed Task Group rules.
    const [firstRule] = normalizeTaskRules(config.matchRules, config.domain);
    if (!firstRule) return 'disabled';
    return firstRule.kind === 'domain'
      ? `domain:${firstRule.value}`
      : `task:page:${firstRule.value}`;
  }

  function configSetKey(configs) {
    return (Array.isArray(configs) ? configs : [])
      .filter(config => config?.enabled)
      .map(configKey)
      .join('|');
  }

  function isPdfTab(tab) {
    return [tab?.url, tab?.pendingUrl, tab?.title]
      .filter(value => typeof value === 'string' && value)
      .some(value => {
        let decodedValue = value;
        try { decodedValue = decodeURIComponent(value); } catch {}
        if (/\.pdf(?:[?#&]|$)/i.test(decodedValue) || /\.pdf(?:\s|$)/i.test(decodedValue)) {
          return true;
        }
        try {
          const parsed = new URL(decodedValue);
          if (/^(?:www\.)?ieeexplore\.ieee\.org$/i.test(parsed.hostname)
            && /^\/stamp\/(?:stamp|getpdf)\.jsp$/i.test(parsed.pathname)) return true;
          return /\/(?:doi\/)?pdf(?:direct)?\//i.test(parsed.pathname);
        } catch {
          return false;
        }
      });
  }

  function hostnameMatchesFamily(hostname, family) {
    const normalizedHostname = normalizeDomain(hostname);
    if (!normalizedHostname) return false;
    return normalizeDomainFamily(family).some(domain =>
      normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`));
  }

  function taskRulesOverlap(firstRules, secondRules) {
    const first = normalizeTaskRules(firstRules);
    const second = normalizeTaskRules(secondRules);
    return first.some(a => second.some(b => {
      if (a.kind === 'page' && b.kind === 'page') return a.value === b.value;
      if (a.kind === 'domain' && b.kind === 'domain') {
        return a.value === b.value
          || a.value.endsWith(`.${b.value}`)
          || b.value.endsWith(`.${a.value}`);
      }
      const page = a.kind === 'page' ? a : b;
      const domain = a.kind === 'domain' ? a : b;
      try { return hostnameMatchesFamily(new URL(page.value).hostname, [domain.value]); } catch { return false; }
    }));
  }

  function matchesTab(tab, config) {
    if (!config?.enabled) return false;
    if (config.type === 'pdf') return isPdfTab(tab);
    const rules = normalizeTaskRules(config.matchRules, config.domain);
    if (rules.length === 0) return false;
    return [tab?.pendingUrl, tab?.url].some(value => {
      if (typeof value !== 'string' || !value) return false;
      try {
        const pageUrl = normalizePageUrl(value);
        const hostname = new URL(value).hostname;
        return rules.some(rule => rule.kind === 'page'
          ? pageUrl === rule.value
          : hostnameMatchesFamily(hostname, [rule.value]));
      } catch {
        return false;
      }
    });
  }

  function captainIndexForTab(tab, configs) {
    const activeConfigs = Array.isArray(configs) ? configs : [];
    const pdfIndex = activeConfigs.findIndex(config =>
      config?.enabled && config.type === 'pdf' && matchesTab(tab, config));
    if (pdfIndex >= 0) return pdfIndex;
    return activeConfigs.findIndex(config =>
      config?.enabled
      && (config.type === 'task' || config.type === 'domain')
      && matchesTab(tab, config));
  }

  globalThis.TabOutCaptainRules = Object.freeze({
    BUILT_IN_PROFILES,
    GROUP_COLORS,
    TASK_GROUP_ICONS,
    builtInProfileForFamily,
    builtInProfileForRules,
    captainIndexForTab,
    configKey,
    configSetKey,
    hostnameMatchesFamily,
    isPdfTab,
    matchesTab,
    normalizeConfig,
    normalizeConfigs,
    normalizeKeepManifest,
    normalizePendingDeadItems,
    normalizeDomain,
    normalizeDomainFamily,
    normalizePageUrl,
    normalizeTaskRules,
    serializeTaskRules,
    taskRulesOverlap,
  });
})();
