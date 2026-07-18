'use strict';

const { resetStore, readJournal, clearJournal, getStore } = require('../lib/service-store');

/**
 * CLI: mox service reset|journal|status
 * @param {{ _: string[], flags: Record<string, any> }} args
 */
function runService(args) {
  const sub = args._[1] || args._[0];
  const flags = args.flags || {};

  if (sub === 'reset') {
    const up = flags.upstream || flags.name || null;
    const result = resetStore(up === true ? null : up);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }

  if (sub === 'journal') {
    if (flags.clear) {
      clearJournal();
      console.log(JSON.stringify({ ok: true, cleared: true }, null, 2));
      return;
    }
    const limit = flags.limit != null ? Number(flags.limit) : 50;
    console.log(JSON.stringify({ ok: true, entries: readJournal(limit) }, null, 2));
    return;
  }

  if (sub === 'status') {
    const up = flags.upstream || flags.name;
    if (!up || up === true) {
      console.log(JSON.stringify({ ok: true, message: 'pass --upstream=<id>' }, null, 2));
      return;
    }
    console.log(JSON.stringify({ ok: true, ...getStore(up).snapshot() }, null, 2));
    return;
  }

  console.log(`Usage (advanced — see references/guide-l6-advanced.md#repair):
  mox service reset [--upstream=ID]
  mox service journal [--limit=N] [--clear]
  mox service status --upstream=ID

Main path auto-resets store on start; stop prints a journal one-liner.
`);
}

module.exports = { runService };
