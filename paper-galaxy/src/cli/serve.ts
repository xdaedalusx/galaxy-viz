import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `Serve the viewer (public/) on localhost. No dependencies.

Usage: node src/cli/serve.ts [--port 8080] [--dir public]
`;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

try {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '8080' },
      dir: { type: 'string', default: 'public' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0-65535 (got "${values.port}")`);
  const root = resolve(values.dir);
  if (!existsSync(join(root, 'index.html'))) throw new Error(`${join(root, 'index.html')} not found (run from the project folder)`);
  if (!existsSync(join(root, 'data', 'graph.json'))) {
    console.warn('Note: no data/graph.json yet. Run `npm run demo` first, or drop your own graph.json onto the page.');
  }

  const server = createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      const rel = normalize(urlPath === '/' ? '/index.html' : urlPath);
      const file = join(root, rel);
      // stay inside the served folder, whatever the request path says
      if (file !== root && !file.startsWith(root + '/') && !file.startsWith(root + '\\')) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      if (!existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(400).end('Bad request');
    }
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use. Try: npm run view -- --port ${port + 1}` : `Error: ${err.message}`);
    process.exit(1);
  });
  // localhost only: this serves the user's own files and should not be reachable from the network
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    const p = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`Paper Galaxy: http://localhost:${p}   (Ctrl+C to stop)`);
  });
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
