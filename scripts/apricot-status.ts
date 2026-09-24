import { resolveCredentials } from '@/lib/connectors/apricot-live';
import { config } from 'dotenv';

/**
 * Reports whether the Riverside Apricot sandbox answers, without printing
 * credentials or tokens. A timeout here means this machine cannot reach the
 * host; the secrets can still be present.
 */
config({ path: '.env.local' });

async function main() {
  let credentials: ReturnType<typeof resolveCredentials>;
  try {
    credentials = resolveCredentials('env:APRICOT_RIVERSIDE');
  } catch (error) {
    console.log(error instanceof Error ? error.message : 'Apricot credentials are not configured.');
    process.exit(1);
  }
  const host = new URL(credentials.baseUrl).hostname;
  const response = await fetch(`${credentials.baseUrl}/${credentials.environment}/oauth/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(12_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  }).catch((error: unknown) => error);
  if (response instanceof Response) {
    console.log(
      `apricot ${credentials.environment} token: http ${response.status} host=${host} token=${response.ok}`,
    );
    process.exit(response.ok ? 0 : 1);
  }
  const name = response instanceof Error ? response.name : 'error';
  console.log(`apricot ${credentials.environment} token: ${name} host=${host}`);
  process.exit(1);
}

main();
