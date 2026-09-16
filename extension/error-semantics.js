(() => {
  'use strict';

  const EXACT_ERROR_PATTERNS = [
    /^error(?:\s*[|—–:-]\s*.*)?$/i,
    /^(?:error\s*)?(?:400|401|403|404|408|410|429|500|502|503|504)(?:\s*[-:|—–]\s*.*)?$/i,
    /^not\s+found(?:\s*[|—–-].*)?$/i,
    /^(?:400\s+bad request|401\s+unauthorized|403\s+forbidden|404\s+not found|408\s+request timeout|410\s+gone|429\s+too many requests)(?:\s*[|—–-].*)?$/i,
    /^(?:500\s+internal server error|502\s+bad gateway|503\s+service unavailable|504\s+gateway timeout)(?:\s*[|—–-].*)?$/i,
    /^(?:access|permission)\s+denied(?:\s*[|—–-].*)?$/i,
    /^(?:forbidden|server error|internal server error|application error|service unavailable|temporarily unavailable|bad gateway|gateway timeout)(?:\s*[|—–-].*)?$/i,
    /^(?:页面不存在|未找到页面|找不到网页|禁止访问|无权访问|服务器错误|应用程序错误|加载失败|出错了)(?:\s*[|—–-].*)?$/,
  ];

  const PHRASE_ERROR_PATTERNS = [
    /\b(?:page|site|file|resource|document|url)\s+(?:(?:was|is)\s+)?not\s+found\b/i,
    /\b(?:page|site|file|resource|document|url)\s+(?:could\s+not|couldn['’]?t|cannot|can['’]?t)\s+be\s+found\b/i,
    /\b(?:could\s+not|couldn['’]?t|cannot|can['’]?t)\s+find\s+(?:(?:the|this|that|your)\s+)?(?:page|site|file|resource|document|url)\b/i,
    /\b(?:page|site|file|resource|document)\s+(?:does\s+not|doesn['’]?t)\s+exist\b/i,
    /\bthis\s+(?:site|page)\s+(?:can['’]?t\s+be\s+reached|isn['’]?t\s+working)\b/i,
    /\b(?:failed|unable)\s+to\s+(?:load|open|connect|fetch)(?:\s+(?:the|this))?\s+(?:page|site|resource|document|url)\b/i,
    /\b(?:page|site|resource|document)\s+(?:failed|was unable)\s+to\s+load\b/i,
    /\b(?:an?\s+)?(?:unexpected|application|server|network|loading)\s+error\s+(?:occurred|has occurred)\b/i,
    /\b(?:something|anything)\s+went\s+wrong\b/i,
    /\b(?:website|page|service)\s+(?:is\s+)?(?:temporarily\s+)?unavailable\b/i,
    /\b(?:connection\s+(?:refused|reset|timed\s+out)|dns_probe_finished_[a-z_]+|err_[a-z_]+)\b/i,
    /(?:页面不存在|未找到页面|找不到网页|禁止访问|无权访问|服务器错误|应用程序错误|加载失败|无法加载|无法连接|连接失败|连接超时|出错了|发生错误|服务不可用)/,
  ];

  const SECURITY_VERIFICATION_PATTERNS = [
    /\bperforming\s+security\s+verification\b/i,
    /\b(?:verify|verifies|verifying)\s+(?:that\s+)?you\s+are\s+not\s+(?:a\s+)?(?:robot|bot)\b/i,
    /\bchecking\s+(?:if|whether)\s+(?:the\s+)?(?:site\s+)?connection\s+is\s+secure\b/i,
  ];

  function normalize(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  function match(values) {
    for (const rawValue of Array.isArray(values) ? values : [values]) {
      const value = normalize(rawValue);
      if (!value) continue;
      if (EXACT_ERROR_PATTERNS.some(pattern => pattern.test(value))
        || PHRASE_ERROR_PATTERNS.some(pattern => pattern.test(value))) {
        return value.slice(0, 180);
      }
    }
    return '';
  }

  function isSecurityVerification(values) {
    return (Array.isArray(values) ? values : [values]).some(rawValue => {
      const value = normalize(rawValue);
      return value && SECURITY_VERIFICATION_PATTERNS.some(pattern => pattern.test(value));
    });
  }

  globalThis.TAB_OUT_ERROR_SEMANTICS = Object.freeze({ match, isSecurityVerification });
})();
