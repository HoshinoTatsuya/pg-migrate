import type { LockKeyHash } from '../constants/lock-key-hash.constant';
import type { JournalLocation } from './journal-location.type';

/** Опции `runMigrations`, проверенные до лока, со значениями по умолчанию. */
export interface ResolvedMigrateSettings {
  readonly lockTimeoutMs: number;
  readonly noTransactionLockTimeoutMs: number;
  readonly lockPollMs: number;
  readonly hash: LockKeyHash;
  readonly sessionSettings: readonly [string, number][];
  readonly schema: string;
  readonly journal: JournalLocation;
  readonly invalidIndexSchemas: readonly string[];
  readonly attempts: number;
  readonly backoffMs: number;
  readonly slowMigrationMs: number;
}
