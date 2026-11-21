import { detectSchemaDrift, formatMigrationPlan, planMigrations } from '@hoshinotatsuya/pg-migrate';
import type { Client } from 'pg';

/** `deploy --plan`: what would run and which locks each statement takes. Reads the journal only. */
export async function printPlan(client: Client, migrationsFolder: string): Promise<void> {
  const plan = await planMigrations(client, { migrationsFolder, phase: 'expand' });
  for (const line of formatMigrationPlan(plan)) {
    console.log(line);
  }
  for (const step of plan.steps) {
    for (const migration of step.migrations) {
      if (migration.statements.some((statement) => statement.lock.blocksWrites)) {
        console.warn(`${migration.tag} blocks writes while it runs`);
      }
    }
  }
}

/** After deploy: the live database against the drizzle-kit snapshot of the last applied migration. */
export async function assertNoDrift(client: Client, migrationsFolder: string): Promise<void> {
  const drift = await detectSchemaDrift(client, { migrationsFolder });
  if (drift.length > 0) {
    throw new Error(drift.map((item) => `${item.kind} ${item.object}`).join('\n'));
  }
}
