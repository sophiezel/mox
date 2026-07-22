'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('applyRulesToSession then rematch mergeCatalogs includes map paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-rematch-'));
  const prevData = process.env.MOX_DATA_ROOT;
  const prevSession = process.env.MOX_SESSION_FILE;
  process.env.MOX_DATA_ROOT = root;
  process.env.MOX_SESSION_FILE = path.join(root, 'session.json');
  try {
    const {
      ensureDataDirs,
      ensureServiceDirs,
      serviceDataDir,
      listServiceIds,
    } = require('../lib/paths');
    const { mergeCatalogs, resolveActiveCatalogs } = require('../lib/catalog-merge');
    const { applyRulesToSession } = require('../lib/rules');
    const { saveSession } = require('../lib/session-config');

    ensureDataDirs();
    const up = 'svc-rematch';
    ensureServiceDirs(up);
    fs.writeFileSync(
      path.join(serviceDataDir(up), 'proxy-rules.json'),
      `${JSON.stringify([], null, 2)}\n`,
    );
    saveSession({ activeCatalogs: [up] });

    let catalogs = resolveActiveCatalogs({
      names: [up],
      allIfEmpty: true,
    });
    let merged = mergeCatalogs(catalogs);
    assert.equal(
      merged.rules.some((r) =>
        String(r.pathPrefix || '').includes('getTradeAppointDetail'),
      ),
      false,
    );

    const rulesDir = path.join(root, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'csp-trade.txt'),
      'jian-j.example.com/csp-task/external/trade/appoint/getTradeAppointDetail\n',
    );

    applyRulesToSession(['csp-trade'], { rulesDir });
    // Mirror start-session: remount all services after map upsert when no --name pin
    catalogs = resolveActiveCatalogs({ allIfEmpty: true });
    assert.ok(listServiceIds().includes('jian-j'));
    merged = mergeCatalogs(catalogs);

    const hit = merged.rules.find((r) =>
      String(r.pathPrefix || '').includes('getTradeAppointDetail'),
    );
    assert.ok(
      hit,
      `expected detail rule after rematch; have ${merged.rules.length} rules`,
    );
    assert.equal(
      hit.pathPrefix,
      '/csp-task/external/trade/appoint/getTradeAppointDetail',
    );
  } finally {
    if (prevData === undefined) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prevData;
    if (prevSession === undefined) delete process.env.MOX_SESSION_FILE;
    else process.env.MOX_SESSION_FILE = prevSession;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
