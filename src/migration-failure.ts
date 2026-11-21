import { MIGRATE_DEFAULTS } from './constants/migrate-defaults.constant';
import { POSTGRES_ERROR_CODE } from './constants/postgres-error-code.constant';
import { STEP_KIND } from './constants/step-kind.constant';
import { MigrationStepError } from './migration-step.error';
import { quoteIdent } from './quote-ident';
import { valueText } from './value-text';

/**
 * Отказ мигратора с причиной в тексте.
 *
 * Drizzle заворачивает ошибку Postgres в `Failed query: <оператор>` и кладёт её
 * в `cause`, шаг применения — ещё раз в `MigrationStepError`. Точка входа
 * деплоя пишет `message`, то есть оператор видел бы весь SQL и не видел бы,
 * ПОЧЕМУ он упал. Сюда поднимаются сообщение, detail и hint самой глубокой
 * ошибки цепочки; какой шаг и каким способом шёл — строкой; исходная ошибка
 * остаётся в `cause`.
 *
 * Подсказка 55P03 говорит правду о сделанном по виду шага: транзакция шага
 * откачена целиком, а шаг вне транзакции не откатывается.
 */
export function migrationFailure(
  error: unknown,
  lockTimeoutMs: number = MIGRATE_DEFAULTS.LOCK_TIMEOUT_MS,
): Error {
  let reason: unknown = error;
  let step: MigrationStepError | undefined;
  for (let depth = 0; reason instanceof Error && depth < 6; depth += 1) {
    if (reason instanceof MigrationStepError) {
      step ??= reason;
    }
    if (!(reason.cause instanceof Error)) {
      break;
    }
    reason = reason.cause;
  }
  if (!(reason instanceof Error)) {
    return new Error(`Миграции не применены: ${valueText(reason)}`, { cause: error });
  }
  const extra = reason as Error & { code?: unknown; detail?: unknown; hint?: unknown };
  const lines = [`Миграции не применены: ${reason.message}`];
  if (typeof extra.detail === 'string' && extra.detail !== '') {
    lines.push(`подробности: ${extra.detail}`);
  }
  if (typeof extra.hint === 'string' && extra.hint !== '') {
    lines.push(`подсказка: ${extra.hint}`);
  }
  const outside = step !== undefined && step.kind !== STEP_KIND.transaction;
  if (step !== undefined) {
    lines.push(`миграция: ${step.tags.join(', ')} (${outside ? 'вне транзакции' : 'в транзакции'})`);
  }
  if (extra.code === POSTGRES_ERROR_CODE.LOCK_NOT_AVAILABLE) {
    const done = outside
      ? 'Шаг вне транзакции не откатывается: операторы до отказа остались применёнными, в журнал миграция ' +
        'не записана; повтор безопасен, только если её операторы повторяемы (IF NOT EXISTS) и оставленные ' +
        'INVALID-индексы убраны'
      : 'Транзакция миграции, на которой случился отказ, откачена целиком; шаги, применённые раньше в этом ' +
        'запуске, остаются применёнными и записаны в журнал — повтор безопасен';
    lines.push(
      `подсказка: миграция ждала блокировку дольше ${lockTimeoutMs} мс — её держит чужая транзакция ` +
        `(дамп, сессия psql, зависшая транзакция). ${done}. Кто держит: SELECT pid, application_name, state, ` +
        'xact_start, left(query, 120) FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY xact_start; ' +
        'дождаться её конца или завершить её и повторить деплой',
    );
  }
  if (step !== undefined && step.leftInvalidIndexes.length > 0) {
    lines.push(
      `оставлены INVALID-индексы: ${step.leftInvalidIndexes.map((index) => `${index.schema}.${index.index} (таблица ${index.table})`).join(', ')}. ` +
        'Повтор с IF NOT EXISTS пропустил бы их и записал миграцию применённой; убрать до повтора: ' +
        step.leftInvalidIndexes
          .map((index) => `DROP INDEX CONCURRENTLY ${quoteIdent(index.schema)}.${quoteIdent(index.index)}`)
          .join('; ') +
        ' (или опция cleanupInvalidIndexes)',
    );
  }
  return new Error(lines.join('\n'), { cause: error });
}
