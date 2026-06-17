/**
 * deploy-console-server.js — local control panel backend for the PROD deploy
 * pipeline. Serves PROD-DEPLOY-PIPELINE.html and runs the (allowlisted) hardhat
 * deploy scripts when a button is clicked, streaming the live output back.
 *
 * A plain HTML opened with file:// CANNOT run shell commands — the browser
 * sandboxes JS. This tiny server is the bridge: the page POSTs {script, network,
 * env} and the server spawns `npx hardhat run scripts/<script> --network <net>`
 * with the provided env, streaming stdout/stderr to the page.
 *
 * SAFETY:
 *   - binds to 127.0.0.1 only (never exposed to the network)
 *   - SCRIPT allowlist — only the deploy/transfer scripts can run (no arbitrary
 *     command injection)
 *   - ENV allowlist — only the known deploy env vars are forwarded
 *   - network allowlist — hoodi / sepolia / mainnet
 *   - no private keys here — the scripts read PRIVATE_KEY from .env as usual
 *
 * Run:  node deploy-console-server.js     →  http://127.0.0.1:8899
 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8899;
const ROOT = __dirname;
const HTML = path.join(ROOT, 'PROD-DEPLOY-PIPELINE.html');

// Only these scripts may be run from the console.
const SCRIPTS = new Set([
  'deploy-mainnet-core.js',
  'deploy-fyusd-earn-vault.js',
  'deploy-earn-lock-registry.js',
  'deploy-operator-safe.js',
  'grant-admin-to-safe.js',
  'transfer-proxy-admin-to-safe.js',
  'transfer-lock-registry-owner.js',
]);
const NETWORKS = new Set(['hoodi', 'sepolia', 'mainnet']);
// Only these env vars are forwarded from the page (deploy params, never keys).
const ALLOWED_ENV = new Set([
  'STABLE_ADDRESS', 'CONCRETE_VAULT_ADDRESS', 'SETTING_MANAGEMENT_ADDRESS',
  'ADMIN_ADDRESS', 'WATCHDOG_ADDRESS', 'RELAYER_ADDRESS', 'OPERATOR_SAFE_ADDRESS',
  'PROXY_ADDRESSES', 'SAFE_THRESHOLD',
]);
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(HTML, (err, buf) => {
      if (err) { res.writeHead(500); res.end('PROD-DEPLOY-PIPELINE.html not found next to this server'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, cwd: ROOT });
  }
  if (req.method === 'POST' && req.url === '/run') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let p;
      try { p = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
      const { script, network } = p;
      const env = p.env && typeof p.env === 'object' ? p.env : {};
      if (!SCRIPTS.has(script)) return json(res, 400, { error: 'script not in allowlist' });
      if (!NETWORKS.has(network)) return json(res, 400, { error: 'network not in allowlist' });

      // Build child env: inherit process.env (so PRIVATE_KEY/RPC from .env flow
      // through hardhat) + the page's allowlisted, validated address vars.
      const childEnv = { ...process.env };
      for (const [k, v] of Object.entries(env)) {
        if (!ALLOWED_ENV.has(k) || typeof v !== 'string' || v.trim() === '') continue;
        const val = v.trim();
        if (k === 'PROXY_ADDRESSES') {
          if (!val.split(',').every((a) => ADDR_RE.test(a.trim()))) return json(res, 400, { error: `${k} must be comma-separated 0x… addresses` });
        } else if (k === 'SAFE_THRESHOLD') {
          if (!/^[1-9][0-9]*$/.test(val)) return json(res, 400, { error: 'SAFE_THRESHOLD must be a positive integer' });
        } else if (!ADDR_RE.test(val)) {
          return json(res, 400, { error: `${k} must be a 0x-prefixed 40-hex address` });
        }
        childEnv[k] = val;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.write(`$ npx hardhat run scripts/${script} --network ${network}\n\n`);
      let child;
      try {
        child = spawn('npx', ['hardhat', 'run', path.join('scripts', script), '--network', network],
          { cwd: ROOT, env: childEnv });
      } catch (e) { res.end(`[spawn failed: ${e.message}]\n`); return; }
      let finished = false;
      child.stdout.on('data', (d) => res.write(d));
      child.stderr.on('data', (d) => res.write(d));
      child.on('error', (e) => { finished = true; res.write(`\n[spawn error: ${e.message}]\n`); res.end(); });
      child.on('close', (code, signal) => {
        finished = true;
        res.write(`\n\n[exit code ${code === null ? 'null' : code}${signal ? ' signal ' + signal : ''}]\n`);
        res.end();
      });
      // Kill the child ONLY if the client actually disconnects mid-run. Use the
      // response's 'close' (fires on real disconnect / after res.end) — NOT
      // req's 'close', which fires as soon as the POST body is read and would
      // SIGTERM hardhat before it prints anything (→ "exit code null").
      res.on('close', () => { if (!finished) { try { child.kill(); } catch {} } });
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Deploy console  →  http://127.0.0.1:${PORT}\n  cwd: ${ROOT}\n  (Ctrl-C to stop)\n`);
});
