import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

/**
 * Serves the form fixtures over HTTP.
 *
 * `tests/e2e.test.ts` reads the fixture off disk, which is enough to exercise
 * the warm path. The cold path cannot work that way: the agent drives a real
 * browser, so it needs a URL to navigate to. This is that URL, and it exists so
 * that testing the agent never requires pointing it at a county's production
 * intake form.
 *
 *   pnpm fixture
 *   BROWSER_ORIGIN_OVERRIDE="https://www.ruhealth.org=http://localhost:4300"
 *
 * The routes mirror the real site's paths, so the agent is given the real
 * application URL and the browser tool's override lands it here instead.
 */

const PORT = Number(process.env.FIXTURE_PORT ?? 4300);

const ROUTES: Record<string, string> = {
  '/': 'wic-form.html',
  '/wic-application': 'wic-form.html',
  // The real Riverside path, so the program catalog's URL works verbatim.
  '/appointments/apply-4-wic-form': 'wic-form.html',
};

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', `http://localhost:${PORT}`).pathname;
  const file = ROUTES[path];

  if (!file) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end(`No fixture at ${path}. Try one of: ${Object.keys(ROUTES).join(', ')}\n`);
    return;
  }

  // A form that submits nowhere. The fixture's own form has no action, but
  // denying POST outright makes the guarantee structural rather than incidental:
  // nothing you do in this browser can submit anything.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { 'content-type': 'text/plain' });
    response.end('The fixture does not accept submissions.\n');
    return;
  }

  // `?variant=clean` drops the ZIP field's truncating maxlength, so the same
  // form can show both the caught silent failure and a run that completes.
  const variant = new URL(request.url ?? '/', `http://localhost:${PORT}`).searchParams.get(
    'variant',
  );
  const raw = readFileSync(join('tests/fixtures', file), 'utf8');
  const body = variant === 'clean' ? raw.replace(/ maxlength="\d+"/g, '') : raw;
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
});

server.listen(PORT, () => {
  console.log(`Form fixtures on http://localhost:${PORT}`);
  for (const path of Object.keys(ROUTES)) console.log(`  http://localhost:${PORT}${path}`);
});
