import { MultiSchemaMigrationError, runMigrationsForSchemas } from '@hoshinotatsuya/pg-migrate';
import type { Client } from 'pg';

/** The same migrations in every tenant schema; each schema keeps its own journal. */
export async function migrateTenants(client: Client, migrationsFolder: string, tenants: readonly string[]) {
  try {
    const reports = await runMigrationsForSchemas(client, {
      schemas: tenants.map((tenant) => `tenant_${tenant}`),
      lockKey: 'billing:tenant-migrations',
      migrationsFolder,
      log: console.log,
      continueOnError: true, // try every schema, then report all failures at once
    });
    return reports.map((report) => `${report.schema}: ${report.status}`);
  } catch (error) {
    if (error instanceof MultiSchemaMigrationError) {
      // error.reports: { schema, status: 'applied' | 'failed' | 'not-started', report?, error? }[]
    }
    throw error;
  }
}
