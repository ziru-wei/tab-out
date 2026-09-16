(() => {
  'use strict';

  const { MESSAGES, createRuntimeMessage, matchesRuntimeMessage } = globalThis.TabOutContracts;
  let scanTimer = 0;
  let lastReport = '';

  function isVisibleSemanticHeading(element) {
    if (!(element instanceof HTMLElement)
      || element.hidden
      || element.getAttribute('aria-hidden') === 'true') return false;
    const style = getComputedStyle(element);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number.parseFloat(style.opacity || '1') > 0
      && element.getClientRects().length > 0;
  }

  function semanticValues() {
    // Only page-level semantics may classify the whole tab as an error.
    // Sites such as GitHub use role=alert (and nested h2 elements) for local,
    // sometimes transient component failures on an otherwise healthy page.
    // Promoting those messages to a tab-level Error creates false positives.
    const primaryHeadings = [...document.querySelectorAll('h1')]
      .filter(isVisibleSemanticHeading)
      .slice(0, 4)
      .map(element => element.textContent || '');
    if (primaryHeadings.length > 0) return [document.title, ...primaryHeadings];

    // A small number of error documents use h2 as their top heading. Accept
    // only a direct child of the main landmark when no visible h1 exists;
    // nested component headings and all role=alert nodes remain excluded.
    const fallbackHeadings = [...document.querySelectorAll(
      'main > h2, [role="main"] > h2',
    )]
      .filter(isVisibleSemanticHeading)
      .slice(0, 2)
      .map(element => element.textContent || '');
    return [document.title, ...fallbackHeadings];
  }

  function scan() {
    scanTimer = 0;
    const values = semanticValues();
    const semantics = globalThis.TAB_OUT_ERROR_SEMANTICS;
    const securityVerification = Boolean(semantics?.isSecurityVerification(values));
    const reason = securityVerification ? '' : semantics?.match(values) || '';
    const reportKey = `${location.href}\n${reason}\n${securityVerification}`;
    if (reportKey === lastReport) return;
    lastReport = reportKey;
    chrome.runtime.sendMessage(createRuntimeMessage(MESSAGES.SEMANTIC_ERROR, {
      url: location.href,
      reason,
      securityVerification,
    })).catch(() => {});
  }

  function scheduleScan() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, 400);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!matchesRuntimeMessage(message, MESSAGES.GET_CITATION_TITLE)) return;
    const selectors = [
      'meta[name="citation_title"]',
      'meta[name="dc.title" i]',
      'meta[name="dcterms.title" i]',
      'meta[property="og:title"]',
    ];
    const title = selectors.reduce((result, selector) => result
      || document.querySelector(selector)?.content?.replace(/\s+/g, ' ').trim(), '') || '';
    sendResponse({ title });
  });

  scan();
  window.addEventListener('pageshow', scheduleScan);
  window.addEventListener('popstate', scheduleScan);
  window.addEventListener('hashchange', scheduleScan);
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
