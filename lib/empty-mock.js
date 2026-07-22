'use strict';

const { normalizeProxyMode } = require('./capture-filter');

/**
 * Detect success envelopes with empty / TRACE_EMPTY data (unmerged L0 stubs).
 * @param {unknown} body
 * @returns {{ empty: boolean, gap: string|null }}
 */
function inspectEmptyMockBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { empty: false, gap: null };
  }
  const code = body.code;
  const successBiz = code === 0 || code === '0' || code == null;
  if (!successBiz) return { empty: false, gap: null };

  const data = body.data;
  const gapHint =
    body.gap === 'TRACE_EMPTY' ||
    (Array.isArray(body.gaps) && body.gaps.includes('TRACE_EMPTY'))
      ? 'TRACE_EMPTY'
      : null;

  // Unmerged L0 stubs use data:{} or data:null; empty arrays may be intentional lists.
  const dataEmptyObject =
    data === null ||
    data === undefined ||
    (typeof data === 'object' &&
      !Array.isArray(data) &&
      Object.keys(data).length === 0);

  if (gapHint) return { empty: true, gap: gapHint };
  if (dataEmptyObject) return { empty: true, gap: 'TRACE_EMPTY' };
  return { empty: false, gap: null };
}

/**
 * Whether mock-lab should refuse an empty success envelope with HTTP 503.
 */
function shouldBlockEmptyMock(opts = {}) {
  if (process.env.MOX_ALLOW_EMPTY_MOCK === '1') return false;
  const mode = normalizeProxyMode(
    opts.mode || process.env.MOX_PROXY_MODE || 'mock-lab',
  );
  if (mode === 'capture-open') return false;
  return true;
}

/**
 * @returns {{ block: boolean, status: number, body: object|null }}
 */
function emptyMockGate(plan, opts = {}) {
  const httpStatus = plan?.httpStatus > 0 ? plan.httpStatus : 200;
  if (httpStatus !== 200) {
    return { block: false, status: httpStatus, body: null };
  }
  if (!shouldBlockEmptyMock(opts)) {
    return { block: false, status: httpStatus, body: null };
  }
  const { empty, gap } = inspectEmptyMockBody(plan?.body);
  if (!empty) return { block: false, status: httpStatus, body: null };
  return {
    block: true,
    status: 503,
    body: {
      code: 503,
      message: 'empty mock blocked (mock-lab); merge capture or MOX_ALLOW_EMPTY_MOCK=1',
      data: null,
      gap: gap || 'TRACE_EMPTY',
    },
  };
}

module.exports = {
  inspectEmptyMockBody,
  shouldBlockEmptyMock,
  emptyMockGate,
};
