/** Какую блокировку оператор берёт на существующую таблицу и что она останавливает. */
export interface StatementLock {
  /** Режим блокировки Postgres; `undefined` — не классифицировано (проверять вручную). */
  readonly mode: string | undefined;
  readonly blocksWrites: boolean;
  readonly blocksReads: boolean;
  readonly note: string;
}
