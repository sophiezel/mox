'use strict';

const DEFAULT_ALLOW_HEADERS =
  'Content-Type, Authorization, Accept, Referer, User-Agent, request-id, x-mock-case';

/**
 * Local mock proxy: default reflect any Origin (no domain hardcoding).
 * Set cors.reflectOrigin=false to restore localhost + extraOrigins whitelist.
 */
function isAllowedOrigin(origin, corsCfg = {}) {
  if (!origin) return false;
  // Default true: echo any Origin for local MITM/mock DX across all H5 hosts.
  if (corsCfg.reflectOrigin !== false) {
    return true;
  }
  if (corsCfg.allowLocalhost !== false) {
    if (
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
      /^https?:\/\/\[::1\](:\d+)?$/i.test(origin)
    ) {
      return true;
    }
  }
  const extras = corsCfg.extraOrigins || [];
  return extras.some(
    (o) => o === origin || (o.startsWith('*') && origin.endsWith(o.slice(1))),
  );
}

function applyCorsHeaders(req, res, corsCfg = {}) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin, corsCfg)) {
    // Never use *: credentials require a concrete Origin echo.
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (corsCfg.allowCredentials !== false) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Vary', 'Origin');
  }

  const requestedHeaders = req.headers['access-control-request-headers'];
  res.setHeader(
    'Access-Control-Allow-Headers',
    requestedHeaders || DEFAULT_ALLOW_HEADERS,
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,DELETE,OPTIONS,PATCH',
  );
}

function handleOptions(req, res, corsCfg) {
  applyCorsHeaders(req, res, corsCfg);
  res.setHeader('Access-Control-Max-Age', '86400');
  res.statusCode = 204;
  res.end();
}

module.exports = {
  isAllowedOrigin,
  applyCorsHeaders,
  handleOptions,
  DEFAULT_ALLOW_HEADERS,
};
