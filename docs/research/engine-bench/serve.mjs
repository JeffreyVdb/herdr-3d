import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const types = { '.js': 'text/javascript', '.html': 'text/html', '.glb': 'model/gltf-binary', '.png': 'image/png' };
export function serve(port) { return new Promise((res) => { const s = http.createServer((q, r) => {
  let u = decodeURIComponent(q.url.split('?')[0]); if (u === '/') u = '/index.html';
  const p = path.join(root, u); fs.readFile(p, (e, d) => { if (e) { r.statusCode = 404; return r.end(); } r.setHeader('content-type', types[path.extname(p)] || 'application/octet-stream'); r.end(d); });
}).listen(port, '127.0.0.1', () => res(s)); }); }
if (process.argv[2] === 'serve') serve(+process.argv[3] || 18770).then(() => console.log('serving'));
