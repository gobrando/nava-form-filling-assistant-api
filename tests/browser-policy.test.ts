import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkCommand, isFinalAction, originOverrides, rewriteUrl } from '@/lib/browser/policy';
import { describe, expect, it } from 'vitest';

const WIC = { allowedOrigins: ['https://www.ruhealth.org', 'https://ruhealth.org'] };
const labels: Record<string, string> = {
  '@e2': 'Name',
  '@e8': 'Submit',
  '@e9': 'Next',
  '@e10': 'Continue to income',
  '@e11': 'I certify this is true',
};
const ctx = { ...WIC, labelFor: (target: string) => labels[target] ?? null };

describe('browser policy', () => {
  it('allows the application site and nothing else', () => {
    expect(
      checkCommand(['open', 'https://www.ruhealth.org/appointments/apply-4-wic-form'], ctx).allowed,
    ).toBe(true);
    expect(checkCommand(['open', 'https://evil.example/phish'], ctx).allowed).toBe(false);
    expect(checkCommand(['open', 'https://www.ruhealth.org.evil.example/'], ctx).allowed).toBe(
      false,
    );
    expect(checkCommand(['open', 'javascript:alert(1)'], ctx).allowed).toBe(false);
  });

  it('refuses the final submission control, and allows page-to-page navigation', () => {
    expect(checkCommand(['click', '@e8'], ctx).allowed).toBe(false);
    expect(checkCommand(['click', '@e11'], ctx).allowed).toBe(false);
    expect(checkCommand(['click', '@e9'], ctx).allowed).toBe(true);
    expect(checkCommand(['click', '@e10'], ctx).allowed).toBe(true);
    expect(checkCommand(['click', '@e2'], ctx).allowed).toBe(true);
  });

  it('refuses a click on a control it cannot label', () => {
    const verdict = checkCommand(['click', '@e99'], ctx);
    expect(verdict.allowed).toBe(false);
  });

  it('refuses submitting through find, Enter, or eval', () => {
    expect(checkCommand(['find', 'role', 'button', 'click', '--name', 'Submit'], ctx).allowed).toBe(
      false,
    );
    expect(checkCommand(['find', 'text', 'Submit', 'click'], ctx).allowed).toBe(false);
    expect(checkCommand(['find', 'label', 'Name', 'fill', 'Jordan'], ctx).allowed).toBe(true);
    expect(checkCommand(['press', 'Enter'], ctx).allowed).toBe(false);
    expect(checkCommand(['press', 'Tab'], ctx).allowed).toBe(true);
    expect(checkCommand(['eval', 'document.forms[0].submit()'], ctx).allowed).toBe(false);
    expect(checkCommand(['eval', "document.querySelector('#x').click()"], ctx).allowed).toBe(false);
    expect(checkCommand(['eval', 'document.title'], ctx).allowed).toBe(true);
  });

  it('refuses commands it does not recognize', () => {
    for (const verb of [
      'upload',
      'download',
      'cookies',
      'storage',
      'network',
      'connect',
      'set',
      'tab',
    ]) {
      expect(checkCommand([verb, 'x'], ctx).allowed).toBe(false);
    }
  });

  it('classifies final actions by label', () => {
    for (const label of ['Submit', 'Submit application', 'Sign and submit', 'I agree', 'Finish']) {
      expect(isFinalAction(label)).toBe(true);
    }
    for (const label of ['Next', 'Continue', 'Save and continue', 'Back', 'Assign clinic']) {
      expect(isFinalAction(label)).toBe(false);
    }
  });

  it('rewrites the real site to the fixture outside production only', () => {
    const env = { BROWSER_ORIGIN_OVERRIDE: 'https://www.ruhealth.org=http://localhost:4300' };
    const overrides = originOverrides({ ...env, NODE_ENV: 'test' });
    expect(rewriteUrl('https://www.ruhealth.org/appointments/apply-4-wic-form', overrides)).toBe(
      'http://localhost:4300/appointments/apply-4-wic-form',
    );
    expect(originOverrides({ ...env, NODE_ENV: 'production' }).size).toBe(0);
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('subagent copies', () => {
  // Eve subagents inherit nothing, so fill carries its own copy of the skill.
  it('keeps the fill subagent’s form-completion skill identical to the root’s', () => {
    const root = 'agent/skills/form-completion';
    const copy = 'agent/subagents/fill/skills/form-completion';
    const rootFiles = files(root)
      .map((path) => relative(root, path))
      .sort();
    expect(
      files(copy)
        .map((path) => relative(copy, path))
        .sort(),
    ).toEqual(rootFiles);
    for (const file of rootFiles) {
      expect(readFileSync(join(copy, file), 'utf8')).toBe(readFileSync(join(root, file), 'utf8'));
    }
  });
});
