// File: scripts/build-client.mjs · Node 22+ ESM
// Builds the shippable ACME client into dist/<variant>/ (gitignored): index.html, app.bundle.js, a real
// source map, and config.js (the PUBLIC config the server would echo — App ID, JS key, server URL; never a
// provider key). Two variants:
//
//   default            `npm run build:client` — the post's recommended build. __LLM_CALL__ becomes the Cloud
//                      function path; the provider-key placeholders are REMOVED, not just left empty.
//   demo-key-in-client `DEMO_KEY_IN_CLIENT=1 npm run build:client -- --demo-key-in-client` — the deliberately
//                      vulnerable "before" build (T10). Requires BOTH the env var and the flag (off by
//                      default, twice): the synthetic CANARY key from cloud/config.js is baked into the
//                      bundle and the client calls the provider directly. It must never be deployed; it
//                      exists so the extraction demo has something honest to extract, with nothing at risk.
//
// Exports buildClient() and startWebServer() for the test suites (T2/T10/T11 inspect the built bytes and the
// served surfaces).
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, LOCAL, SIM_PORT, args, ensureCloudConfig } from './lib/env.mjs';

ensureCloudConfig();
const config = createRequire(import.meta.url)('../cloud/config.js');

/**
 * buildClient({ demoKeyInClient, serverUrl, providerUrl }) → { dir, files }
 * Throws if the demo build is requested without DEMO_KEY_IN_CLIENT=1 in the environment.
 */
export function buildClient({ demoKeyInClient = false, serverUrl = LOCAL.SERVER_URL, providerUrl = `http://127.0.0.1:${SIM_PORT}` } = {}) {
  if (demoKeyInClient && process.env.DEMO_KEY_IN_CLIENT !== '1') {
    throw new Error('the demo-key-in-client build requires DEMO_KEY_IN_CLIENT=1 in the environment (off by default, on purpose)');
  }
  const variant = demoKeyInClient ? 'demo-key-in-client' : 'default';
  const dir = path.join(ROOT, 'dist', variant);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const source = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  let bundle;
  if (demoKeyInClient) {
    bundle = source
      .replace('__LLM_CALL__', 'askProviderDirectly')
      .replace('__DEMO_PROVIDER_KEY__', config.CANARY_KEY)
      .replace('__DEMO_MODEL__', config.MODEL);
  } else {
    // The default build removes the direct-provider function entirely: no dead code holding placeholder
    // key-shaped strings ships to anyone.
    const start = source.indexOf('  // DEMO build only');
    const end = source.indexOf('  void askViaCloudFunction');
    bundle = (source.slice(0, start) + source.slice(end))
      .replace('__LLM_CALL__', 'askViaCloudFunction')
      .replace('void askViaCloudFunction; void askProviderDirectly; // the build keeps exactly one of them wired in',
        'void askViaCloudFunction;');
  }
  const banner = `/* llm-proxy-lab client · variant: ${variant} · built ${new Date().toISOString()} */\n`;
  const bundleName = 'app.bundle.js';
  const mapName = bundleName + '.map';
  writeFileSync(path.join(dir, bundleName), banner + bundle + `\n//# sourceMappingURL=${mapName}\n`);
  // A real (if trivial) source map with sourcesContent — source maps are one of the inspected leak surfaces.
  writeFileSync(path.join(dir, mapName), JSON.stringify({
    version: 3, file: bundleName, sources: ['public/app.js'], sourcesContent: [bundle], names: [], mappings: '',
  }));
  writeFileSync(path.join(dir, 'index.html'), readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'));
  // The public config the web server serves at /config.js — the pattern our templates use for PUBLIC keys.
  // The provider key must never ride this channel (brief §4.3.3); PROVIDER_URL is only present in the demo
  // variant because only that build talks to a provider from the browser.
  const pub = { APP_ID: LOCAL.APP_ID, JS_KEY: LOCAL.JS_KEY, SERVER_URL: serverUrl };
  if (demoKeyInClient) pub.PROVIDER_URL = providerUrl;
  writeFileSync(path.join(dir, 'config.js'), `window.LAB_CONFIG = ${JSON.stringify(pub, null, 2)};\n`);
  return { dir, variant, files: ['index.html', bundleName, mapName, 'config.js'] };
}

/** Serves a built variant the way a Containers app would (static files + /config.js). Returns {url, close}. */
export async function startWebServer({ dir, port = 0 } = {}) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };
  const server = http.createServer((req, res) => {
    const name = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    try {
      const file = readFileSync(path.join(dir, path.normalize(name).replace(/^(\.\.[/\\])+/, '')));
      res.writeHead(200, { 'content-type': types[path.extname(name)] || 'application/octet-stream' });
      res.end(file);
    } catch {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

if (process.argv[1] && process.argv[1].endsWith('build-client.mjs')) {
  const a = args();
  const out = buildClient({ demoKeyInClient: !!a['demo-key-in-client'] });
  console.log(`built dist/${out.variant}/ (${out.files.join(', ')})`);
  if (out.variant === 'demo-key-in-client') console.log('WARNING: this build ships the synthetic canary key in the bundle. Never deploy it.');
}
