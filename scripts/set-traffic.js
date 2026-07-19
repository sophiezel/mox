'use strict';

/**
 * Hot-switch proxy trafficMode / mockAllowlist (WireMock-style proxy/intercept).
 * Session file update; running proxy picks up via trafficLoader ≤1s.
 */

const { resolveScanLabel } = require('../lib/paths');
const { loadSession, saveSession } = require('../lib/session-config');
const { appendAudit } = require('../lib/audit');
const {
  VALID_MODES,
  normalizeTrafficMode,
} = require('../lib/traffic-mode');
const { assertStubId } = require('./set-case');

/**
 * @param {object} opts
 * @param {string} [opts.action] - mode | allow | deny | list | clear | set
 * @param {string} [opts.mode]
 * @param {string} [opts.stubId]
 * @param {string} [opts.name]
 * @param {string} [opts.projectDir]
 */
function setTraffic(opts = {}) {
  const label = resolveScanLabel(
    opts.projectDir || process.cwd(),
    opts.name,
  );
  const action = String(opts.action || '').toLowerCase();
  const cfg = loadSession();
  const proxy = { ...(cfg.proxy || {}) };
  let mode = proxy.trafficMode || 'all-mock';
  let list = Array.isArray(proxy.mockAllowlist) ? [...proxy.mockAllowlist] : [];

  if (action === 'list' || action === '') {
    console.log(`[mox] trafficMode=${mode}`);
    console.log(`[mox] mockAllowlist (${list.length}):`);
    for (const id of list) console.log(`  - ${id}`);
    return { trafficMode: mode, mockAllowlist: list };
  }

  if (action === 'clear') {
    list = [];
    saveSession({
      proxy: { ...proxy, mockAllowlist: list },
    });
    appendAudit(label, {
      command: 'traffic',
      summary: 'clear allowlist',
    });
    console.log('[mox] mockAllowlist cleared');
    console.log('[mox] session picks up via ≤1s cache; no restart needed');
    return { trafficMode: mode, mockAllowlist: list };
  }

  if (action === 'allow') {
    const stubId = opts.stubId;
    if (!stubId) throw new Error('Usage: mox traffic allow <stubId>');
    assertStubId(stubId);
    if (!list.includes(stubId)) list.push(stubId);
    const patch = { mockAllowlist: list };
    if (mode !== 'selective') {
      console.log(
        `[mox] hint: trafficMode is "${mode}"; allowlist only applies in selective. Run: mox traffic selective`,
      );
    }
    saveSession({ proxy: { ...proxy, ...patch } });
    appendAudit(label, {
      command: 'traffic',
      apiKey: stubId,
      summary: 'allow',
    });
    console.log(`[mox] allow ${stubId}`);
    console.log('[mox] session picks up via ≤1s cache; no restart needed');
    return { trafficMode: mode, mockAllowlist: list };
  }

  if (action === 'deny') {
    const stubId = opts.stubId;
    if (!stubId) throw new Error('Usage: mox traffic deny <stubId>');
    assertStubId(stubId);
    list = list.filter((x) => x !== stubId);
    saveSession({
      proxy: { ...proxy, mockAllowlist: list },
    });
    appendAudit(label, {
      command: 'traffic',
      apiKey: stubId,
      summary: 'deny',
    });
    console.log(`[mox] deny ${stubId}`);
    console.log('[mox] session picks up via ≤1s cache; no restart needed');
    return { trafficMode: mode, mockAllowlist: list };
  }

  // action is a mode name, or action=set with opts.mode
  const modeArg = action === 'set' ? opts.mode : action;
  if (VALID_MODES.has(modeArg) || opts.mode) {
    mode = normalizeTrafficMode(opts.mode || modeArg);
    saveSession({
      proxy: { ...proxy, trafficMode: mode },
    });
    appendAudit(label, {
      command: 'traffic',
      summary: `mode=${mode}`,
    });
    console.log(`[mox] trafficMode=${mode}`);
    console.log('[mox] session picks up via ≤1s cache; no restart needed');
    return { trafficMode: mode, mockAllowlist: list };
  }

  throw new Error(
    `Usage: mox traffic <all-mock|all-passthrough|selective|allow|deny|list|clear> [stubId]`,
  );
}

module.exports = { setTraffic };

if (require.main === module) {
  const a = process.argv[2];
  const b = process.argv[3];
  if (a === 'allow' || a === 'deny') {
    setTraffic({ action: a, stubId: b });
  } else {
    setTraffic({ action: a || 'list' });
  }
}
