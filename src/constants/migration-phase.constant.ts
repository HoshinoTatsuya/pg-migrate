import { deepFreeze } from '../deep-freeze';

/**
 * Фаза миграции для совместимости двух версий приложения (expand/contract).
 * `expand` — добавляет (колонки, таблицы, индексы): старый код с ней работает.
 * `contract` — убирает то, чем пользовался СТАРЫЙ код (DROP COLUMN, NOT NULL на
 * новой колонке): применять только после выкатки кода, который этим уже не
 * пользуется. Пометка — строка `-- pg-migrate:phase=contract` в заголовке файла.
 */
export const MIGRATION_PHASE = {
  expand: 'expand',
  contract: 'contract',
} as const;

deepFreeze(MIGRATION_PHASE);
