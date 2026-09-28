// Dev-only: exposes a bridge's unix socket as `ws://127.0.0.1:<port>/ws`, so a
// browser page can reach a private herdr-world. It forwards the WebSocket
// upgrade byte for byte, minus the Origin header (the bridge only accepts
// same-origin requests, and this proxy is the origin it sees). Loopback only;
// the Mac helper is the real thing (Host/Origin/token checks).
//
//   portlease run --name proxy -- sh -c 'node tools/ws-unix-proxy.ts --port "$PORTLEASE_PROXY_PORT" --socket "$XDG_RUNTIME_DIR/h3d-m2game/bridge.sock"'
import { createServer, request, type Server } from 'node:http';
import type { Socket } from 'node:net';

export function startProxy(port: number, socketPath: string, log: (m: string) => void = () => {}): Promise<Server> {
  const srv = createServer((req, res) => {
    // Plain HTTP (e.g. /healthz) passes through too.
    const up = request({ socketPath, path: req.url, method: req.method, headers: { ...req.headers, host: 'herdr-world' } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => res.writeHead(502).end(String(e)));
    req.pipe(up);
  });
  srv.on('upgrade', (req, client: Socket, head) => {
    const headers = { ...req.headers, host: 'herdr-world' };
    delete headers.origin;
    const up = request({ socketPath, path: req.url?.startsWith('/ws') ? req.url : '/ws', method: 'GET', headers });
    up.on('upgrade', (res, bridge, bridgeHead) => {
      const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
      for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
      client.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (bridgeHead.length) client.write(bridgeHead);
      if (head.length) bridge.write(head);
      bridge.pipe(client).pipe(bridge);
      const close = () => {
        bridge.destroy();
        client.destroy();
      };
      bridge.on('error', close);
      client.on('error', close);
      bridge.on('close', close);
      client.on('close', close);
      log(`proxy: ws connected ${req.url ?? ''}`);
    });
    up.on('response', (res) => {
      client.end(`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}\r\nConnection: close\r\n\r\n`);
    });
    up.on('error', (e) => {
      log(`proxy: ${String(e)}`);
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    up.end();
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(opt('--port') ?? process.env.PORTLEASE_PROXY_PORT);
  const sock = opt('--socket');
  if (!Number.isInteger(port) || port <= 0 || !sock) {
    console.error('usage: ws-unix-proxy.ts --port <port> --socket <bridge.sock>');
    process.exit(2);
  }
  await startProxy(port, sock, (m) => console.log(m));
  console.log(`proxy ws://127.0.0.1:${port}/ws -> ${sock}`);
}
