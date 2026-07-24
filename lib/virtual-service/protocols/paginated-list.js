'use strict';

/**
 * paginated-list protocol: detect envelope from Observations, render VS handler.
 */

const { rowId } = require('../seed-store');

const PAGE_KEYS = ['page', 'pageNum', 'pageNo', 'current', 'currentPage'];
const PAGE_SIZE_KEYS = ['pageSize', 'size', 'limit', 'page_size'];
const LIST_KEYS = ['detail', 'list', 'records', 'rows', 'items', 'dataList'];
const TOTAL_KEYS = ['totalNum', 'total', 'totalCount', 'count'];
const TOTAL_PAGE_KEYS = ['totalPage', 'pages', 'totalPages'];

function firstKey(obj, candidates) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of candidates) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) return k;
  }
  return null;
}

function pickPageFromRequest(req) {
  if (!req || typeof req !== 'object') return null;
  for (const k of PAGE_KEYS) {
    if (req[k] != null && req[k] !== '') return { key: k, value: Number(req[k]) };
  }
  return null;
}

/**
 * @param {object[]} observations
 * @returns {{ protocol: string, envelope: object }|null}
 */
function detectPaginatedList(observations) {
  const list = Array.isArray(observations) ? observations.filter(Boolean) : [];
  if (!list.length) return null;
  const envelope = learnEnvelope(list);
  if (!envelope || !envelope.listKey || !envelope.totalKey) return null;
  const hasPageReq = list.some((o) => pickPageFromRequest(o.requestBody || o.query));
  const hasPageResp = list.some(
    (o) =>
      o.data &&
      typeof o.data === 'object' &&
      !Array.isArray(o.data) &&
      firstKey(o.data, PAGE_KEYS),
  );
  if (!hasPageReq && !hasPageResp) return null;
  const sample = list.find(
    (o) =>
      o.data &&
      typeof o.data === 'object' &&
      !Array.isArray(o.data) &&
      Array.isArray(o.data[envelope.listKey]),
  );
  if (!sample) return null;
  return { protocol: 'paginated-list', envelope };
}

/**
 * @param {object[]} observations
 * @returns {object|null}
 */
function learnEnvelope(observations) {
  for (const o of observations || []) {
    const data = o?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const listKey = firstKey(data, LIST_KEYS);
    const totalKey = firstKey(data, TOTAL_KEYS);
    if (!listKey || !totalKey) continue;
    return {
      listKey,
      totalKey,
      pageKey: firstKey(data, PAGE_KEYS) || 'page',
      pageSizeKey: firstKey(data, PAGE_SIZE_KEYS) || 'pageSize',
      totalPageKey: firstKey(data, TOTAL_PAGE_KEYS) || 'totalPage',
      requestPageKey:
        pickPageFromRequest(o.requestBody)?.key ||
        pickPageFromRequest(o.query)?.key ||
        firstKey(data, PAGE_KEYS) ||
        'page',
      requestPageSizeKey:
        firstKey(o.requestBody || {}, PAGE_SIZE_KEYS) ||
        firstKey(o.query || {}, PAGE_SIZE_KEYS) ||
        firstKey(data, PAGE_SIZE_KEYS) ||
        'pageSize',
    };
  }
  return null;
}

/**
 * @param {object[]} observations
 * @param {object} envelope
 * @returns {object[]}
 */
function extractListRows(observations, envelope) {
  const listKey = envelope?.listKey || 'detail';
  const byId = new Map();
  for (const o of observations || []) {
    const data = o?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const arr = data[listKey];
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      if (!row || typeof row !== 'object') continue;
      const id = rowId(row);
      if (id == null) continue;
      const prev = byId.get(id) || {};
      byId.set(id, { ...prev, ...row, id });
    }
  }
  return [...byId.values()];
}

/**
 * @param {object[]} rows
 * @param {{ page?: number, pageSize?: number }} req
 * @param {object} envelope
 */
function applyPagination(rows, req, envelope) {
  const pageKey = envelope.pageKey || 'page';
  const pageSizeKey = envelope.pageSizeKey || 'pageSize';
  const totalKey = envelope.totalKey || 'totalNum';
  const listKey = envelope.listKey || 'detail';
  const totalPageKey = envelope.totalPageKey || 'totalPage';
  const page = Math.max(1, Number(req?.page) || 1);
  const pageSize = Math.max(1, Number(req?.pageSize) || 10);
  const total = rows.length;
  const totalPage = Math.max(1, Math.ceil(total / pageSize) || 1);
  const start = (page - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  return {
    [pageKey]: page,
    [pageSizeKey]: pageSize,
    [totalKey]: total,
    [totalPageKey]: totalPage,
    [listKey]: slice,
  };
}

/**
 * Apply evidence operators then pagination.
 * @param {object[]} rows
 * @param {object} requestBody
 * @param {object} envelope
 * @param {object[]} operators
 */
function applyQuery(rows, requestBody, envelope, operators) {
  const req = requestBody && typeof requestBody === 'object' ? requestBody : {};
  let out = [...(rows || [])];
  for (const op of operators || []) {
    if (!op || !op.field) continue;
    const field = op.field;
    const rv = req[field];
    if (rv == null || rv === '') continue;
    if (op.type === 'eq') {
      out = out.filter((row) => String(row[field]) === String(rv));
    } else if (op.type === 'like') {
      const needle = String(rv).toLowerCase();
      out = out.filter((row) =>
        String(row[field] ?? '')
          .toLowerCase()
          .includes(needle),
      );
    }
  }
  const sortOp = (operators || []).find((o) => o && o.type === 'sort');
  if (sortOp) {
    const sortReq = sortOp.requestField || 'sortField';
    const sf = req[sortReq];
    if (sf) {
      const dir =
        String(req.sortOrder || req.order || 'asc').toLowerCase() === 'desc'
          ? -1
          : 1;
      out = [...out].sort((a, b) => {
        const av = a[sf];
        const bv = b[sf];
        if (av === bv) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return av > bv ? dir : -dir;
      });
    }
  }
  const pageKey = envelope.requestPageKey || envelope.pageKey || 'page';
  const pageSizeKey =
    envelope.requestPageSizeKey || envelope.pageSizeKey || 'pageSize';
  return applyPagination(
    out,
    { page: req[pageKey], pageSize: req[pageSizeKey] },
    envelope,
  );
}

function resourceNameFromStub(stubId) {
  const s = String(stubId || '');
  const parts = s.split(/[\s/]+/).filter(Boolean);
  const last = parts[parts.length - 1] || 'items';
  return last.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'items';
}

/**
 * @param {{
 *   stubId: string,
 *   resource: string,
 *   envelope: object,
 *   operators?: object[],
 *   snapshotSuccess: object,
 * }} opts
 */
function renderPaginatedListHandler(opts) {
  const stubId = opts.stubId || '';
  const resource = String(opts.resource || 'items').replace(/[^a-zA-Z0-9_-]/g, '_');
  const envelope = opts.envelope || {};
  const operators = Array.isArray(opts.operators) ? opts.operators : [];
  const snap = opts.snapshotSuccess || {
    code: 0,
    data: {},
    message: '',
  };

  return `/** Auto-generated by mox — paginated-list Virtual Service — ${stubId}
 * mox:store resource=${resource} protocol=paginated-list
 */
module.exports = ({ method, query, params, body, headers, caseId, store }) => {
  const RESOURCE = ${JSON.stringify(resource)};
  const ENVELOPE = ${JSON.stringify(envelope)};
  const OPERATORS = ${JSON.stringify(operators)};
  const SNAPSHOT_SUCCESS = ${JSON.stringify(snap)};
  const PAGE_KEYS = ${JSON.stringify(PAGE_KEYS)};
  const cases = {
    empty: {
      response: {
        code: 0,
        data: {
          [ENVELOPE.pageKey || 'page']: 1,
          [ENVELOPE.pageSizeKey || 'pageSize']: Number((body && body[ENVELOPE.requestPageSizeKey || ENVELOPE.pageSizeKey]) || 10) || 10,
          [ENVELOPE.totalKey || 'totalNum']: 0,
          [ENVELOPE.totalPageKey || 'totalPage']: 0,
          [ENVELOPE.listKey || 'detail']: [],
        },
        message: '',
      },
      httpStatus: 200,
    },
    biz_error: { response: { code: 1, data: null, message: 'biz error' }, httpStatus: 200 },
  };
  const idHeader = caseId || (headers && (headers['x-mock-case'] || headers['X-Mock-Case']));
  if (idHeader && idHeader !== 'success' && cases[idHeader]) return cases[idHeader];

  const rows = store && typeof store.collectionList === 'function'
    ? store.collectionList(RESOURCE)
    : [];
  if (!rows.length) {
    return { response: SNAPSHOT_SUCCESS, httpStatus: 200 };
  }

  const req = Object.assign({}, query || {}, body && typeof body === 'object' ? body : {});
  let filtered = rows.slice();
  for (const op of OPERATORS) {
    if (!op || !op.field) continue;
    const field = op.field;
    const rv = req[field];
    if (rv == null || rv === '') continue;
    if (op.type === 'eq') {
      filtered = filtered.filter((row) => String(row[field]) === String(rv));
    } else if (op.type === 'like') {
      const needle = String(rv).toLowerCase();
      filtered = filtered.filter((row) =>
        String(row[field] == null ? '' : row[field]).toLowerCase().includes(needle),
      );
    }
  }
  const sortOp = OPERATORS.find((o) => o && o.type === 'sort');
  if (sortOp) {
    const sortReq = sortOp.requestField || 'sortField';
    const sf = req[sortReq];
    if (sf) {
      const dir = String(req.sortOrder || req.order || 'asc').toLowerCase() === 'desc' ? -1 : 1;
      filtered = filtered.slice().sort((a, b) => {
        const av = a[sf];
        const bv = b[sf];
        if (av === bv) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return av > bv ? dir : -dir;
      });
    }
  }

  const pageKey = ENVELOPE.requestPageKey || ENVELOPE.pageKey || 'page';
  const pageSizeKey = ENVELOPE.requestPageSizeKey || ENVELOPE.pageSizeKey || 'pageSize';
  const page = Math.max(1, Number(req[pageKey]) || 1);
  const pageSize = Math.max(1, Number(req[pageSizeKey]) || 10);
  const total = filtered.length;
  const totalPage = Math.max(1, Math.ceil(total / pageSize) || 1);
  const start = (page - 1) * pageSize;
  const slice = filtered.slice(start, start + pageSize);
  const data = {};
  data[ENVELOPE.pageKey || 'page'] = page;
  data[ENVELOPE.pageSizeKey || 'pageSize'] = pageSize;
  data[ENVELOPE.totalKey || 'totalNum'] = total;
  data[ENVELOPE.totalPageKey || 'totalPage'] = totalPage;
  data[ENVELOPE.listKey || 'detail'] = slice;
  return { response: { code: 0, data, message: '' }, httpStatus: 200 };
};
`;
}

module.exports = {
  PAGE_KEYS,
  PAGE_SIZE_KEYS,
  LIST_KEYS,
  TOTAL_KEYS,
  detectPaginatedList,
  learnEnvelope,
  extractListRows,
  applyPagination,
  applyQuery,
  resourceNameFromStub,
  renderPaginatedListHandler,
};
