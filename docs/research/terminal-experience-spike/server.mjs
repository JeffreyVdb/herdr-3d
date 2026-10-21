// Research only. One canned Python TUI per connection; never opens a user shell.
import { createServer } from 'vite';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export async function serve() {
  const port = Number(process.env.PORTLEASE_TERMINAL_SPIKE_PORT);
  if (!port) throw new Error('Run via pnpm dev or pnpm probe (portlease required)');
  const root = fileURLToPath(new URL('.', import.meta.url));
  const vite = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port, strictPort: true } });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const children = new Set();
  vite.httpServer.on('upgrade', (req, socket, head) => {
    if (req.url !== '/pty') return;
    if (req.headers.origin !== `http://127.0.0.1:${port}`) return socket.destroy();
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws));
  });
  sockets.on('connection', (ws) => {
    const child = spawn('python3', ['-u', `${root}/pty-fixture.py`], { stdio: ['pipe', 'pipe', 'inherit'] });
    children.add(child);
    child.stdin.on('error', () => ws.close());
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (ws.readyState === ws.OPEN) ws.send(line);
    });
    ws.on('message', (data) => child.stdin.write(`${data}\n`));
    ws.on('close', () => child.stdin.end());
    child.on('exit', () => { children.delete(child); ws.close(); });
  });
  await vite.listen();
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const ws of sockets.clients) ws.terminate();
      for (const child of children) child.stdin.end();
      sockets.close();
      await vite.close();
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await serve();
  console.log(`Terminal research spike: ${server.url}`);
  process.once('SIGINT', async () => { await server.close(); process.exit(); });
  process.once('SIGTERM', async () => { await server.close(); process.exit(); });
}
