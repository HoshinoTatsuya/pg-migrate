import { MIGRATE_DEFAULTS } from './constants/migrate-defaults.constant';
import { MIGRATION_DIRECTIVE } from './constants/migration-directive.constant';
import { MIGRATION_PHASE } from './constants/migration-phase.constant';
import { STEP_KIND } from './constants/step-kind.constant';
import { TIMER_LIMIT } from './constants/timer-limit.constant';
import type { MigrationDirectives } from './types/migration-directives.type';
import type { MigrationPhase } from './types/migration-phase.type';

/**
 * Заголовок файла миграции: строки `-- pg-migrate:…` подряд с первой. Пустые
 * строки и обычные комментарии заголовок заканчивают. Незнакомая директива,
 * параметр или значение — отказ с именем файла.
 */
export function readDirectives(tag: string, text: string): MigrationDirectives {
  let kind: MigrationDirectives['kind'] = STEP_KIND.transaction;
  let batchSize: number | undefined;
  let pauseMs: number | undefined;
  let phase: MigrationPhase | undefined;
  const fail = (line: string, why: string): never => {
    throw new Error(`миграция ${tag}: «${line}» — ${why}`);
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(MIGRATION_DIRECTIVE.prefix)) {
      break;
    }
    const [name = '', ...params] = line.slice(MIGRATION_DIRECTIVE.prefix.length).trim().split(/\s+/);
    if (
      (name === MIGRATION_DIRECTIVE.noTransaction && kind === STEP_KIND.batched) ||
      (name === MIGRATION_DIRECTIVE.batched && kind === STEP_KIND.noTransaction)
    ) {
      // Оба способа сразу: какой из них имелся в виду, заголовок не говорит.
      fail(
        line,
        `${MIGRATION_DIRECTIVE.noTransaction} и ${MIGRATION_DIRECTIVE.batched} взаимоисключающие — ` +
          'порционная миграция и так идёт вне транзакции, порция за порцией',
      );
    }
    if (name === MIGRATION_DIRECTIVE.noTransaction && params.length === 0) {
      kind = STEP_KIND.noTransaction;
      continue;
    }
    if (name === MIGRATION_DIRECTIVE.batched) {
      kind = STEP_KIND.batched;
      for (const param of params) {
        // Значение — всё после первого `=` и только десятичные цифры: `batch=100=abc`,
        // `pause=`, `batch=1e3`, `batch=0x10` — отказ, а не 100, 0, 1000, 16.
        const split = param.indexOf('=');
        const key = split === -1 ? param : param.slice(0, split);
        const text = split === -1 ? '' : param.slice(split + 1);
        const number = /^\d+$/.test(text) ? Number(text) : Number.NaN;
        if (key === 'batch' && Number.isInteger(number) && number > 0) {
          batchSize = number;
        } else if (
          key === 'pause' &&
          Number.isInteger(number) &&
          number >= 0 &&
          number <= TIMER_LIMIT.MAX_DELAY_MS
        ) {
          pauseMs = number;
        } else {
          fail(
            line,
            `параметр «${param}»: batch — целое > 0, pause — целое от 0 до ${TIMER_LIMIT.MAX_DELAY_MS} (мс; больше ` +
              'таймер Node превращает в 1 мс)',
          );
        }
      }
      continue;
    }
    if (name.startsWith(`${MIGRATION_DIRECTIVE.phase}=`) && params.length === 0) {
      const value = name.slice(MIGRATION_DIRECTIVE.phase.length + 1);
      if (!Object.values(MIGRATION_PHASE).includes(value as MigrationPhase)) {
        fail(line, `фаза — ${Object.values(MIGRATION_PHASE).join(' | ')}`);
      }
      phase = value as MigrationPhase;
      continue;
    }
    fail(
      line,
      `незнакомая директива; известны: ${MIGRATION_DIRECTIVE.noTransaction}, ` +
        `${MIGRATION_DIRECTIVE.batched} [batch=N] [pause=мс], ${MIGRATION_DIRECTIVE.phase}=expand|contract`,
    );
  }
  if (kind === STEP_KIND.batched) {
    batchSize ??= MIGRATE_DEFAULTS.BATCH_SIZE;
    pauseMs ??= MIGRATE_DEFAULTS.BATCH_PAUSE_MS;
  }
  return { kind, batchSize, pauseMs, phase };
}
