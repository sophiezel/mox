'use strict';

/**
 * Preload for `npm test`: redirect all .data writes to a temp dir so the
 * repo `.data/services` and global ops dirs are never filled with test junk.
 * Individual tests may still override MOX_DATA_ROOT.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.MOX_DATA_ROOT) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-test-'));
  process.env.MOX_DATA_ROOT = tmp;
  const cleanup = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
}
