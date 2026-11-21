/** Опции сверки схемы. */
export interface DriftOptions {
  /** Каталог миграций drizzle-kit: `meta/_journal.json` и `meta/<idx>_snapshot.json`. */
  readonly migrationsFolder: string;
  /**
   * Схема таблиц снимка, записанных без схемы (`schema: ""`), — по умолчанию
   * `public`. Для схемы арендатора (`runMigrationsForSchemas`) — её имя, а
   * журнал — `migrationsSchema` той же схемы.
   */
  readonly schema?: string;
  /** Таблицы `схема.таблица`, которых в снимке нет законно (чужие, служебные). */
  readonly ignoreTables?: readonly string[];
  /** Журнал миграций — служебная таблица, лишней не считается (по умолчанию `drizzle.__drizzle_migrations`). */
  readonly migrationsSchema?: string;
  readonly migrationsTable?: string;
}
