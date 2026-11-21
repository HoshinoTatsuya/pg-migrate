import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';

/** Отдельная база на тест: миграции и локи одного теста не видны другому. */
export const createTestDatabase = async (
  adminUrl: string,
): Promise<{ url: string; drop(): Promise<void> }> => {
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
};

/**
 * Каталог миграций в формате drizzle-kit: `meta/_journal.json` и `<tag>.sql`,
 * операторы разделены `--> statement-breakpoint`.
 */
export const writeMigrations = (
  migrations: ReadonlyArray<{ tag: string; statements: readonly string[]; when?: number }>,
): string => {
  const folder = mkdtempSync(join(tmpdir(), 'pg-migrate-spec-'));
  mkdirSync(join(folder, 'meta'));
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: migrations.map(({ tag, when }, idx) => ({
        idx,
        version: '7',
        when: when ?? 1_700_000_000_000 + idx,
        tag,
        breakpoints: true,
      })),
    }),
  );
  for (const { tag, statements } of migrations) {
    writeFileSync(join(folder, `${tag}.sql`), statements.join('\n--> statement-breakpoint\n'));
  }
  return folder;
};

export const removeFolder = (folder: string): void => {
  rmSync(folder, { recursive: true, force: true });
};
