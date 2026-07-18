'use strict';

const http = require('http');
const { createMockApp } = require('./app');

function startMockServer({
  mocksRoot,
  host = '127.0.0.1',
  port = 3900,
  cors = {},
  caseHeader = 'x-mock-case',
  resolveMocksRoot = null,
}) {
  const app = createMockApp({ mocksRoot, cors, caseHeader, resolveMocksRoot });
  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        host,
        port: boundPort,
        url: `http://${host}:${boundPort}`,
        close: () =>
          new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

if (require.main === module) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...rest] = a.split('=');
      return [k.replace(/^--/, ''), rest.join('=')];
    }),
  );
  startMockServer({
    mocksRoot: args.mocksRoot || args.mocks,
    host: args.host || '127.0.0.1',
    port: Number(args.port || 3900),
  }).then((s) => {
    console.log(`[mox] mock listening ${s.url} mocksRoot=${args.mocksRoot}`);
  });
}

module.exports = { startMockServer };
