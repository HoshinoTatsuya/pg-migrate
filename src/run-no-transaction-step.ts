import type { Client } from 'pg';

import { LEFTOVER_INDEX_NAME } from './constants/leftover-index-name.constant';
import { listInvalidIndexes } from './list-invalid-indexes';
import { MigrationStepError } from './migration-step.error';
import { quoteIdent } from './quote-ident';
import { recordInJournal } from './record-in-journal';
import { setLockTimeout } from './set-lock-timeout';
import type { InvalidIndex } from './types/invalid-index.type';
import type { PendingMigration } from './types/pending-migration.type';
import type { StepContext } from './types/step-context.type';

/**
 * Миграция ВНЕ транзакции: оператор за оператором в автокоммите, затем
 * запись в журнал.
 *
 *  - Свой `lock_timeout`: `CREATE INDEX CONCURRENTLY` ждёт конца каждой
 *    транзакции, пишущей в таблицу или держащей старый снимок. Под общим
 *    потолком (5 с) он отказывал при любом писателе старше и оставлял
 *    INVALID-индекс; его ожидание запись не блокирует.
 *  - Перед записью в журнал — проверка INVALID: `IF NOT EXISTS` пропускает
 *    индекс с таким именем, даже недостроенный, и миграция записалась бы
 *    «применённой» с INVALID-индексом.
 *  - Отказ: INVALID-индексы, которых до шага не было, — в ошибке шага (повтор
 *    по ним невозможен), а с `cleanupInvalidIndexes` — убираются
 *    `DROP INDEX CONCURRENTLY`, и повтор строит их заново.
 */
export async function runNoTransactionStep(
  client: Client,
  migration: PendingMigration,
  context: StepContext,
): Promise<void> {
  const key = (index: InvalidIndex): string => `${index.schema}.${index.index}`;
  const before = new Set((await listInvalidIndexes(client, context.invalidIndexSchemas)).map(key));
  const fresh = async (): Promise<InvalidIndex[]> =>
    (await listInvalidIndexes(client, context.invalidIndexSchemas)).filter(
      (index) => !before.has(key(index)),
    );
  await setLockTimeout(client, context.noTransactionLockTimeoutMs);
  let failure: unknown;
  try {
    for (const statement of migration.file.sql) {
      if (statement.trim() !== '') {
        await client.query(statement);
      }
    }
  } catch (error) {
    failure = error;
  }
  let outcome: MigrationStepError | undefined;
  try {
    if (failure !== undefined) {
      // Каталог не прочитан (обрыв, таймаут) — оставленные индексы неизвестны:
      // повтор всё равно идёт только после проверки INVALID (runMigrations).
      let left = await fresh().catch(() => [] as InvalidIndex[]);
      if (context.cleanupInvalidIndexes && left.length > 0) {
        for (const index of left) {
          const qualified = `${quoteIdent(index.schema)}.${quoteIdent(index.index)}`;
          try {
            await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${qualified}`);
            context.log(
              `миграция ${migration.tag}: убран INVALID-индекс ${qualified}, оставленный отказом шага вне транзакции`,
            );
          } catch (cleanup) {
            // Уборка не прошла — индекс остаётся в отказе шага (с тегом), а не
            // подменяет его сырой ошибкой DROP.
            context.log(
              `миграция ${migration.tag}: INVALID-индекс ${qualified} не убран — ` +
                `${cleanup instanceof Error ? cleanup.message : String(cleanup)}`,
            );
          }
        }
        // Не прочитали заново — остаются те, что знали: «пусто» значило бы «убраны».
        left = await fresh().catch(() => left);
      }
      outcome = new MigrationStepError([migration.tag], migration.directives.kind, failure, left);
    } else {
      // Все INVALID схем, а не только новые: IF NOT EXISTS пропускает и
      // недостроенный индекс, оставшийся от прошлой попытки или чужой операции.
      const left = (await listInvalidIndexes(client, context.invalidIndexSchemas)).filter(
        (index) => !LEFTOVER_INDEX_NAME.test(index.index),
      );
      if (left.length > 0) {
        outcome = new MigrationStepError(
          [migration.tag],
          migration.directives.kind,
          new Error(
            `после операторов остались INVALID-индексы ${left.map(key).join(', ')} — в журнал не записана: ` +
              'IF NOT EXISTS пропустил недостроенный индекс с тем же именем',
          ),
          left,
        );
      }
    }
  } finally {
    // Потолок сессии — обратно, даже после отказа: следующие шаги транзакционные.
    try {
      await setLockTimeout(client, context.lockTimeoutMs);
    } catch (restore) {
      if (failure === undefined && outcome === undefined) {
        // biome-ignore lint/correctness/noUnsafeFinally: отказ восстановления — единственная ошибка шага
        throw restore;
      }
    }
  }
  if (outcome !== undefined) {
    throw outcome;
  }
  await recordInJournal(client, context.journal, migration.file);
}
