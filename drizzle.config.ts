import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

config({ path: '.env.local' });

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './lib/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // biome-ignore lint/style/noNonNullAssertion: drizzle-kit is a CLI; failing loudly here is correct.
    url: process.env.POSTGRES_URL!,
  },
});
