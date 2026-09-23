import { type ChildProcess, spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appClient,
  createApplication,
  createHousehold,
  createTenant,
  ownerClient,
} from './helpers/db';

/**
 * The agent's browser tool against a real Chromium and the form fixture, with
 * no model involved.
 *
 * This is the layer beneath the cold path: if these pass, whatever a model asks
 * for goes through the same checks. The tool is given the real Riverside WIC
 * URL and lands on the fixture through the test-only origin override, so the
 * allowlist being exercised is the production one.
 */

const PORT = 4311;
const SESSION_ID = `test-${Date.now()}`;

let fixture: ChildProcess;
let browserTool: {
  execute: (
    input: unknown,
    ctx: unknown,
  ) => Promise<{
    success: boolean;
    output: string | null;
    error: string | null;
    refused?: boolean;
  }>;
};
let ctx: unknown;

async function waitForFixture() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Fixture server did not start.');
}

beforeAll(async () => {
  const owner = ownerClient();
  const tenant = await createTenant(owner);
  const householdId = await createHousehold(owner, tenant.id);
  const applicationId = await createApplication(owner, tenant.id, householdId);
  await owner.end();

  fixture = spawn('node_modules/.bin/tsx', ['tests/fixtures/serve.ts'], {
    env: { ...process.env, FIXTURE_PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitForFixture();

  // The tool reaches Postgres as the application role, so RLS is in force.
  const app = new URL(process.env.POSTGRES_TEST_URL as string);
  app.username = 'nava_api';
  app.password = 'nava_api_test';
  process.env.POSTGRES_URL = app.toString();
  process.env.BROWSER_ORIGIN_OVERRIDE = `https://www.ruhealth.org=http://localhost:${PORT}`;
  appClient();

  browserTool = (await import('@/agent/tools/browser')).default as unknown as typeof browserTool;
  const attributes = { tenantId: tenant.id, applicationId, householdId };
  ctx = {
    session: {
      id: SESSION_ID,
      auth: {
        current: { principalId: 'test', attributes },
        initiator: { principalId: 'test', attributes },
      },
    },
  };
}, 60_000);

afterAll(async () => {
  if (browserTool) await browserTool.execute({ command: ['close'] }, ctx).catch(() => {});
  fixture?.kill();
});

const run = (command: string[]) => browserTool.execute({ command }, ctx);

describe('browser tool', () => {
  it('opens the real application URL and lands on the fixture', async () => {
    const result = await run(['open', 'https://www.ruhealth.org/appointments/apply-4-wic-form']);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Apply for WIC');
  }, 60_000);

  it('refuses to leave the application site', async () => {
    const result = await run(['open', 'https://example.com/']);
    expect(result.refused).toBe(true);
  });

  it('fills a field and reads back what actually landed', async () => {
    const snapshot = await run(['snapshot', '-i']);
    expect(snapshot.output).toContain('Zip code');
    const zipRef = /textbox "Zip code".*?ref=(e\d+)/.exec(snapshot.output ?? '')?.[1];
    expect(zipRef).toBeTruthy();

    expect((await run(['fill', `@${zipRef}`, '92501'])).success).toBe(true);
    const readback = await run(['get', 'value', `@${zipRef}`]);
    // The fixture's maxlength truncates. The write "succeeded"; the readback
    // is what shows it did not land.
    expect(readback.output).toContain('9250');
    expect(readback.output).not.toContain('92501');
  }, 60_000);

  it('refuses to click Submit', async () => {
    const snapshot = await run(['snapshot', '-i']);
    const submitRef = /button "Submit".*?ref=(e\d+)/.exec(snapshot.output ?? '')?.[1];
    expect(submitRef).toBeTruthy();
    const result = await run(['click', `@${submitRef}`]);
    expect(result.refused).toBe(true);
    expect(result.error).toMatch(/final submission/);
  }, 60_000);

  it('refuses Enter, which would submit from a text field', async () => {
    const result = await run(['press', 'Enter']);
    expect(result.refused).toBe(true);
  });
});
