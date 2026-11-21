import { deepFreeze } from '../deep-freeze';

/**
 * Строки заголовка файла миграции (подряд с первой строки), которые читает
 * pg-migrate. Незнакомая строка с префиксом `-- pg-migrate:` — отказ: опечатка
 * в `batched` молча выполнила бы бэкфилл одним UPDATE на всю таблицу.
 */
export const MIGRATION_DIRECTIVE = {
  prefix: '-- pg-migrate:',
  /** Вне транзакции, оператор за оператором (`CREATE INDEX CONCURRENTLY`). То же, что `NO_TRANSACTION_MARKER`. */
  noTransaction: 'no-transaction',
  /**
   * Порциями: каждый оператор повторяется в автокоммите, пока не затронет ноль
   * строк; `$1` в операторе — размер порции. Параметры — `batch=1000 pause=50`.
   */
  batched: 'batched',
  /** `phase=expand` или `phase=contract`. */
  phase: 'phase',
} as const;

deepFreeze(MIGRATION_DIRECTIVE);
