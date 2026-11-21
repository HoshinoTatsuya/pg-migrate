import type { Client } from 'pg';

import { abortableDelay } from './abortable-delay';
import { acquireMigrationLock } from './acquire-migration-lock';
import { applyMigrations } from './apply-migrations';
import { cleanupSession } from './cleanup-session';
import { MIGRATE_DEFAULTS } from './constants/migrate-defaults.constant';
import { STEP_KIND } from './constants/step-kind.constant';
import { isLockTimeout } from './is-lock-timeout';
import { migrationFailure } from './migration-failure';
import { MigrationStepError } from './migration-step.error';
import { refuseInvalidIndexes } from './refuse-invalid-indexes';
import { refuseLockHeldElsewhere } from './refuse-lock-held-elsewhere';
import { refuseOpenTransaction } from './refuse-open-transaction';
import { refuseSkippedMigrations } from './refuse-skipped-migrations';
import { resolveMigrateSettings } from './resolve-migrate-settings';
import { retryPauseMs } from './retry-pause-ms';
import type { MigrateOptions } from './types/migrate-options.type';
import type { MigrationReport } from './types/migration-report.type';
import { withLostConnection } from './with-lost-connection';

/**
 * Применяет миграции drizzle под advisory-локом.
 *
 * Клиент — одно соединение (не пул): лок сессионный, и проверки, хуки и сами
 * миграции обязаны идти в той же сессии, что его держит. Порядок:
 *  1. advisory-лок — второй запуск ждёт первого, а не применяет то же самое;
 *  2. `lock_timeout` — ПОСЛЕ лока: ждущий второй запуск таблиц не держит, и
 *     ограничивать его ожидание незачем (иначе он отказал бы, пока первый
 *     честно работает);
 *  3. отказ на INVALID-индексах и на миграции, которую drizzle молча
 *     пропустил бы (метка старше последней применённой), — до любых изменений;
 *  4. beforeMigrate (оставил транзакцию открытой или прерванной — отказ: шаги
 *     пошли бы внутри неё, а CREATE INDEX CONCURRENTLY — отказом 25001) →
 *     снова проверка пропусков (хук мог записать журнал) →
 *     миграции (повтор по 55P03 — с проверкой INVALID перед каждым) →
 *     проверка INVALID после → afterMigrate;
 *  5. в finally — RESET потолков и снятие лока: клиент может быть не
 *     последним пользователем сессии. Транзакцию, которую хук оставил
 *     прерванной или открытой, уборка сперва откатывает.
 *
 * На время запуска на клиенте стоит обработчик `'error'`: разрыв сессии
 * сервером без активного запроса (pg_terminate_backend, рестарт, failover)
 * без слушателя — падение процесса. Причина разрыва — строкой в отказе.
 *
 * Возвращает отчёт: шаги с длительностью и миграции, отложенные до фазы contract.
 */
export async function runMigrations(client: Client, options: MigrateOptions): Promise<MigrationReport> {
  const settings = resolveMigrateSettings(options);
  const startedAt = performance.now();
  if (settings.schema !== MIGRATE_DEFAULTS.SCHEMA && options.migrationsSchema === undefined) {
    // `schema` журнал не переносит: перенос молча сменил бы журнал у тех, кто
    // уже задал схему, и drizzle применил бы все миграции заново к пустому.
    // Журнал по умолчанию общий у всех сервисов базы с журналом по умолчанию,
    // а drizzle пропускает миграцию старше последней записи журнала — чужой.
    options.log(
      `схема ${settings.schema}, а журнал миграций — ${settings.journal.schema}.${settings.journal.table} ` +
        '(по умолчанию drizzle, общий для сервисов базы); свой журнал — опция migrationsSchema',
    );
  }
  options.signal?.throwIfAborted();
  let lost: Error | undefined;
  const onError = (error: Error): void => {
    if (lost === undefined) {
      lost = error;
      options.log(`соединение мигратора разорвано: ${error.message}`);
    }
  };
  client.on('error', onError);
  try {
    await acquireMigrationLock(client, options, settings.hash, settings.lockPollMs);
    let report: MigrationReport;
    try {
      await refuseLockHeldElsewhere(client, options.lockKey, settings.hash);
      // SET параметров не принимает; set_config — тот же параметр сессии.
      for (const [name, value] of settings.sessionSettings) {
        await client.query('SELECT set_config($1, $2, false)', [name, `${value}ms`]);
      }
      // Строка об обрубке — одна за прогон: проверки до, между повторами и после
      // видят тот же обрубок, и без учёта он печатался по разу на каждую.
      const announced = new Set<string>();
      const announceOnce = (line: string): void => {
        if (!announced.has(line)) {
          announced.add(line);
          options.log(line);
        }
      };
      const refuseInvalid = async (): Promise<void> => {
        for (const schema of settings.invalidIndexSchemas) {
          await refuseInvalidIndexes(client, announceOnce, schema);
        }
      };
      await refuseInvalid();
      await refuseSkippedMigrations(client, options.log, options.migrationsFolder, settings.journal);
      await options.beforeMigrate?.(client);
      await refuseOpenTransaction(client, 'beforeMigrate');
      options.signal?.throwIfAborted();
      // Хук (пометка базовой миграции) пишет в журнал: пропуск мог появиться после первой проверки.
      await refuseSkippedMigrations(client, options.log, options.migrationsFolder, settings.journal);
      let applied: Awaited<ReturnType<typeof applyMigrations>> | undefined;
      for (let attempt = 1; applied === undefined; attempt += 1) {
        try {
          applied = await applyMigrations(client, options.migrationsFolder, {
            journal: settings.journal,
            log: options.log,
            lockTimeoutMs: settings.lockTimeoutMs,
            noTransactionLockTimeoutMs: settings.noTransactionLockTimeoutMs,
            invalidIndexSchemas: settings.invalidIndexSchemas,
            cleanupInvalidIndexes: options.cleanupInvalidIndexes === true,
            transactionPerMigration: options.transactionPerMigration === true,
            phase: options.phase,
            slowMigrationMs: settings.slowMigrationMs,
            signal: options.signal,
          });
        } catch (error) {
          const step = error instanceof MigrationStepError ? error : undefined;
          // Шаг вне транзакции оставил INVALID-индекс: повтор с IF NOT EXISTS
          // пропустил бы его и записал миграцию применённой.
          const leftInvalid = (step?.leftInvalidIndexes.length ?? 0) > 0;
          // Свой потолок — только у шага вне транзакции; порционный идёт под общим.
          const waitedMs =
            step?.kind === STEP_KIND.noTransaction
              ? settings.noTransactionLockTimeoutMs
              : settings.lockTimeoutMs;
          if (attempt >= settings.attempts || !isLockTimeout(error) || leftInvalid) {
            throw migrationFailure(error, waitedMs);
          }
          const pause = retryPauseMs(attempt, settings.backoffMs, Math.random);
          const outside = step !== undefined && step.kind !== STEP_KIND.transaction;
          options.log(
            `миграция ${step?.tags.join(', ') ?? ''} ждала блокировку дольше ` +
              `${waitedMs} мс ` +
              `(попытка ${attempt} из ${settings.attempts}) — ` +
              (outside
                ? 'шаг вне транзакции: операторы до отказа остались применёнными, в журнал не записана, ' +
                  'INVALID-индексов не осталось'
                : 'её транзакция откачена целиком') +
              `, повтор через ${Math.round(pause)} мс`,
          );
          await abortableDelay(pause, options.signal);
          // Перед повтором — снова INVALID: повтор с IF NOT EXISTS пропустил бы недостроенный индекс.
          await refuseInvalid();
        }
      }
      // И после: тех же схем, что до. Миграция записана применённой — индекс обязан быть целым.
      await refuseInvalid();
      await options.afterMigrate?.(client);
      options.log('миграции применены');
      report = {
        steps: applied.steps,
        deferred: applied.deferred,
        durationMs: performance.now() - startedAt,
      };
    } catch (error) {
      await cleanupSession(client, settings.sessionSettings, settings.hash, options.lockKey, true);
      throw error;
    }
    await cleanupSession(client, settings.sessionSettings, settings.hash, options.lockKey, false);
    return report;
  } catch (error) {
    throw withLostConnection(error, lost);
  } finally {
    client.off('error', onError);
  }
}
