'use strict';

// Local TLS peer for Python's native retry regression. No upstream requests.
const fs = require('node:fs');
const http2 = require('node:http2');
const readline = require('node:readline');
const server = http2.createSecureServer({
  cert: fs.readFileSync(process.argv[2]),
  key: fs.readFileSync(process.argv[3]),
});
const peers = new Set();
let requests = 0;
server.on('session', (session) => {
  peers.add(session);
  session.on('error', () => {});
  session.on('close', () => peers.delete(session));
});
server.on('stream', (stream) => {
  requests += 1;
  stream.on('error', () => {});
  stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
const lines = readline.createInterface({ input: process.stdin });
const watchdog = setTimeout(() => process.exit(1), 20000);
function close() {
  clearTimeout(watchdog);
  for (const peer of peers) peer.destroy();
  server.close();
  lines.close();
}
lines.on('line', (command) => {
  if (command === 'stats') {
    process.stdout.write(`${JSON.stringify({ requests, http2: true })}\n`);
  } else if (command === 'close') close();
});
process.stdin.on('end', close);
