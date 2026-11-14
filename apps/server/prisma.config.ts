import { defineConfig } from 'prisma/config';

// Prisma 7 reads the connection URL from here, not from schema.prisma, and does not load .env
// files. `generate` needs no database, so DATABASE_URL may be unset for builds; `migrate deploy`
// (run by the server at startup, src/db/migrate.ts) gets it from the environment.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
