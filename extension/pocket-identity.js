'use strict';

const POCKET_TRACKING_QUERY_PARAMS = new Set([
  'gclid',
  'gad_source',
  'gad_campaignid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
]);

globalThis.getPocketIdentityUrl = function getPocketIdentityUrl(url) {
  const originalUrl = typeof url === 'string' ? url.trim() : '';
  if (!originalUrl) return '';

  try {
    const parsed = new URL(originalUrl);
    for (const key of [...parsed.searchParams.keys()]) {
      if (POCKET_TRACKING_QUERY_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return originalUrl;
  }
};
