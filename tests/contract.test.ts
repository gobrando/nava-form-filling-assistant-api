import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

/**
 * `openapi.yaml` is the contract, and it is also what configures GCP API
 * Gateway. A route that exists but is undocumented is invisible to the gateway;
 * a documented route that no longer exists is a 404 a partner wrote code
 * against. Both are silent until a partner hits them, so they are asserted here
 * instead.
 */

const spec = YAML.parse(readFileSync('openapi.yaml', 'utf8'));

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) routeFiles(path, out);
    else if (entry === 'route.ts') out.push(path);
  }
  return out;
}

/** `app/v1/households/[id]/facts/route.ts` -> `/v1/households/{id}/facts` */
function toSpecPath(file: string): string {
  return `/${file
    .replace(/^app\//, '')
    .replace(/\/route\.ts$/, '')
    .replace(/\[(\w+)\]/g, '{$1}')}`;
}

const files = routeFiles('app');
const implemented = files.map(toSpecPath);

describe('openapi.yaml matches the implementation', () => {
  it('documents every route handler', () => {
    const documented = new Set(Object.keys(spec.paths));
    expect(implemented.filter((path) => !documented.has(path))).toEqual([]);
  });

  it('does not document routes that do not exist', () => {
    expect(Object.keys(spec.paths).filter((path) => !implemented.includes(path))).toEqual([]);
  });

  it('documents every exported HTTP method', () => {
    const gaps: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const path = toSpecPath(file);
      const exported = [
        ...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g),
      ].map((match) => match[1].toLowerCase());
      const inSpec = Object.keys(spec.paths[path] ?? {});
      for (const method of exported) {
        if (!inSpec.includes(method)) gaps.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it('requires authentication on every operation', () => {
    const unsecured: string[] = [];
    for (const [path, operations] of Object.entries(spec.paths as Record<string, object>)) {
      for (const [method, operation] of Object.entries(operations as Record<string, unknown>)) {
        if (method === 'options' || method === 'parameters') continue;
        const declared = (operation as { security?: unknown[] }).security;
        const security = declared ?? (spec.security as unknown[]);
        // An empty array opts out of the global key. That is allowed only when
        // the operation says so: the participant token is the credential, or
        // the route is the local demo and is absent in production.
        const text = JSON.stringify(operation).toLowerCase();
        const openOnPurpose =
          Array.isArray(declared) &&
          declared.length === 0 &&
          (/no api key/.test(text) || /token is the credential/.test(text));
        if ((!security || security.length === 0) && !openOnPurpose) {
          unsecured.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(unsecured).toEqual([]);
  });

  it('never describes a submit operation that submits', () => {
    const submit = spec.paths['/v1/applications/{id}/submit']?.post;
    expect(submit).toBeDefined();
    // The wording is load-bearing. This endpoint records that a human
    // submitted; it must never be documented as performing the submission,
    // because a partner engineer reads this before they read the code.
    const text = JSON.stringify(submit).toLowerCase();
    expect(text).toMatch(/record/);
    expect(text).not.toMatch(/submits the (form|application) on/);
  });
});
