import type { JournalLocation } from './journal-location.type';

/** Что шагу применения нужно от запуска. */
export interface StepContext {
  readonly journal: JournalLocation;
  readonly log: (line: string) => void;
  /** `lock_timeout` сессии мигратора, мс — восстанавливается после шага вне транзакции. */
  readonly lockTimeoutMs: number;
  /** `lock_timeout` шага вне транзакции, мс. */
  readonly noTransactionLockTimeoutMs: number;
  /** Схемы, в которых ищутся INVALID-индексы. */
  readonly invalidIndexSchemas: readonly string[];
  /** Убирать INVALID-индексы, оставленные упавшим шагом вне транзакции. */
  readonly cleanupInvalidIndexes: boolean;
  readonly signal: AbortSignal | undefined;
}
