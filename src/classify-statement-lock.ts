import { alterTableActions } from './alter-table-actions';
import { classifyStatementAction } from './classify-statement-action';
import { LOCK_MODE_STRENGTH } from './constants/lock-mode-strength.constant';
import { sqlWithoutLiterals } from './sql-without-literals';
import type { StatementLock } from './types/statement-lock.type';

/**
 * Блокировка оператора миграции по правилам `STATEMENT_LOCK_RULES`; комментарии,
 * директивы и содержимое строк — не в счёт. Составной `ALTER TABLE t a, b` — каждое действие
 * отдельно, итог — сильнейший режим, «останавливает» — если останавливает хоть
 * одно, пояснения — всех: `… VALIDATE CONSTRAINT c, ADD COLUMN x` иначе выглядел
 * бы проверкой без остановки записи, хотя ADD COLUMN берёт ACCESS EXCLUSIVE.
 */
export function classifyStatementLock(statement: string): StatementLock {
  // Без комментариев И строк: `DEFAULT 'VALIDATE CONSTRAINT x'` — данные, а не
  // действие (прежде такая строка делала ADD COLUMN «проверкой без остановки записи»).
  const text = sqlWithoutLiterals(statement).trim();
  const locks = alterTableActions(text).map(classifyStatementAction);
  const [first] = locks;
  if (locks.length === 1 && first !== undefined) {
    return first;
  }
  if (locks.some((lock) => lock.mode === undefined)) {
    return {
      mode: undefined,
      blocksWrites: false,
      blocksReads: false,
      note: 'не классифицировано — проверить вручную',
    };
  }
  const strength = (lock: StatementLock): number => LOCK_MODE_STRENGTH.indexOf(lock.mode as string);
  const strongest = locks.reduce((best, lock) => (strength(lock) > strength(best) ? lock : best));
  return Object.freeze({
    mode: strongest.mode,
    blocksWrites: locks.some((lock) => lock.blocksWrites),
    blocksReads: locks.some((lock) => lock.blocksReads),
    note: [...new Set(locks.map((lock) => lock.note))].join('; '),
  });
}
