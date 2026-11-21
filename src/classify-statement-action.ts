import { STATEMENT_LOCK_RULES } from './constants/statement-lock-rules.constant';
import type { StatementLock } from './types/statement-lock.type';

/** Одно действие — первое совпавшее правило. */
export function classifyStatementAction(text: string): StatementLock {
  for (const [pattern, lock] of STATEMENT_LOCK_RULES) {
    if (pattern.test(text)) {
      return lock;
    }
  }
  return {
    mode: undefined,
    blocksWrites: false,
    blocksReads: false,
    note: 'не классифицировано — проверить вручную',
  };
}
