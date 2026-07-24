'use strict';

/**
 * Normalize usage/capture evidence into Observation records for Virtual Service derive.
 */

/**
 * @param {object} cap capture JSON from disk
 * @returns {object|null}
 */
function observationFromCapture(cap) {
  if (!cap || typeof cap !== 'object') return null;
  let responseBody = cap.responseBody;
  if (typeof responseBody === 'string') {
    try {
      responseBody = JSON.parse(responseBody);
    } catch {
      return null;
    }
  }
  if (responseBody == null || typeof responseBody !== 'object') return null;

  let requestBody = cap.requestBody;
  if (typeof requestBody === 'string') {
    try {
      requestBody = JSON.parse(requestBody);
    } catch {
      requestBody = {};
    }
  }
  if (requestBody == null || typeof requestBody !== 'object') requestBody = {};

  const data =
    responseBody.data !== undefined ? responseBody.data : responseBody;

  return {
    source: 'capture',
    method: String(cap.method || 'GET').toUpperCase(),
    host: cap.host || null,
    path: cap.path || null,
    stubId: cap.stubId || null,
    query: cap.query && typeof cap.query === 'object' ? cap.query : {},
    requestBody,
    responseBody,
    data,
    status: cap.status != null ? Number(cap.status) : 200,
  };
}

/**
 * Build a lightweight Observation from contract success case + optional request shape.
 * @param {object} contract
 * @returns {object|null}
 */
function observationFromContract(contract) {
  if (!contract || typeof contract !== 'object') return null;
  const success = (contract.cases || []).find((c) => c.id === 'success');
  const data = success?.response?.data;
  const method = Array.isArray(contract.method)
    ? contract.method[0]
    : contract.method || 'GET';
  return {
    source: 'contract',
    method: String(method || 'GET').toUpperCase(),
    host: Array.isArray(contract.hosts) ? contract.hosts[0] : null,
    path: contract.path || null,
    stubId: contract.stubId || contract.id || null,
    query: {},
    requestBody: {},
    responseBody: success?.response || { code: 0, data, message: '' },
    data,
    status: success?.httpStatus || 200,
  };
}

module.exports = {
  observationFromCapture,
  observationFromContract,
};
