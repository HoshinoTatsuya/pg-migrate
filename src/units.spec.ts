import type { MigrationMeta } from 'drizzle-orm/migrator';

import { abortableDelay } from './abortable-delay';
import { classifyStatementLock } from './classify-statement-lock';
import { MIGRATE_DEFAULTS } from './constants/migrate-defaults.constant';
import { STEP_KIND } from './constants/step-kind.constant';
import { TIMER_LIMIT } from './constants/timer-limit.constant';
import { migrationFailure } from './migration-failure';
import { MigrationStepError } from './migration-step.error';
import { normalizeColumnType } from './normalize-column-type';
import { planSteps } from './plan-steps';
import { readDirectives } from './read-directives';
import { resolveMigrateSettings } from './resolve-migrate-settings';
import { retryPauseMs } from './retry-pause-ms';
import type { PendingMigration } from './types/pending-migration.type';

const migration = (tag: string, when: number, header = ''): PendingMigration => ({
  index: 0,
  tag,
  file: { sql: ['SELECT 1'], bps: true, folderMillis: when, hash: tag } as MigrationMeta,
  directives: readDirectives(tag, `${header}\nSELECT 1`),
});

describe('заголовок файла миграции', () => {
  it('вид, порции и фаза; без заголовка — транзакция', () => {
    expect(readDirectives('a', 'CREATE TABLE x ()')).toEqual({
      kind: STEP_KIND.transaction,
      batchSize: undefined,
      pauseMs: undefined,
      phase: undefined,
    });
    expect(readDirectives('a', '-- pg-migrate:no-transaction\nCREATE INDEX CONCURRENTLY')).toMatchObject({
      kind: STEP_KIND.noTransaction,
    });
    expect(readDirectives('a', '-- pg-migrate:batched\nUPDATE x')).toEqual({
      kind: STEP_KIND.batched,
      batchSize: MIGRATE_DEFAULTS.BATCH_SIZE,
      pauseMs: MIGRATE_DEFAULTS.BATCH_PAUSE_MS,
      phase: undefined,
    });
    expect(
      readDirectives('a', '-- pg-migrate:batched batch=10 pause=0\n-- pg-migrate:phase=contract\nUPDATE x'),
    ).toEqual({ kind: STEP_KIND.batched, batchSize: 10, pauseMs: 0, phase: 'contract' });
    // Обычный комментарий заканчивает заголовок: директива после него не читается.
    expect(readDirectives('a', '-- комментарий\n-- pg-migrate:no-transaction\nX').kind).toBe(
      STEP_KIND.transaction,
    );
  });

  it.each([
    ['-- pg-migrate:no-transation', 'незнакомая директива'],
    ['-- pg-migrate:batched batch=0', 'параметр «batch=0»'],
    ['-- pg-migrate:batched size=10', 'параметр «size=10»'],
    ['-- pg-migrate:batched pause=-1', 'параметр «pause=-1»'],
    ['-- pg-migrate:phase=later', 'фаза — expand | contract'],
    ['-- pg-migrate:no-transaction now', 'незнакомая директива'],
  ])('%s — отказ', (header, reason) => {
    expect(() => readDirectives('0001_x', `${header}\nSELECT 1`)).toThrow(
      `миграция 0001_x: «${header}» — ${reason}`,
    );
  });
});

describe('нарезка на шаги', () => {
  it('без пометок — один шаг; с пометкой — транзакционные подряд одним шагом, помеченная своим', () => {
    const a = migration('a', 1);
    const b = migration('b', 2);
    const c = migration('c', 3, '-- pg-migrate:no-transaction');
    const d = migration('d', 4);
    const e = migration('e', 5);
    expect(planSteps([a, b], { transactionPerMigration: false, phase: undefined }).steps).toEqual([
      { kind: STEP_KIND.transaction, migrations: [a, b] },
    ]);
    expect(
      planSteps([a, b, c, d, e], { transactionPerMigration: false, phase: undefined }).steps.map((step) => [
        step.kind,
        step.migrations.map((m) => m.tag),
      ]),
    ).toEqual([
      [STEP_KIND.transaction, ['a', 'b']],
      [STEP_KIND.noTransaction, ['c']],
      [STEP_KIND.transaction, ['d', 'e']],
    ]);
    expect(
      planSteps([a, b], { transactionPerMigration: true, phase: undefined }).steps.map((step) =>
        step.migrations.map((m) => m.tag),
      ),
    ).toEqual([['a'], ['b']]);
    expect(planSteps([], { transactionPerMigration: false, phase: undefined }).steps).toEqual([]);
  });

  it('неупорядоченные метки — отказ только при нарезке (равные — тоже)', () => {
    const unordered = [migration('a', 2), migration('b', 1)];
    expect(planSteps(unordered, { transactionPerMigration: false, phase: undefined }).steps).toHaveLength(1);
    expect(() => planSteps(unordered, { transactionPerMigration: true, phase: undefined })).toThrow(
      'метки миграций не по порядку: b (when 1) не новее a (when 2)',
    );
    expect(() =>
      planSteps([migration('a', 2), migration('b', 2)], { transactionPerMigration: true, phase: undefined }),
    ).toThrow('не по порядку');
  });

  it('фазы: expand откладывает с первой contract; contract первой в списке — без отказа', () => {
    const contract = migration('c', 2, '-- pg-migrate:phase=contract');
    const { steps, deferred } = planSteps([migration('a', 1), contract, migration('d', 3)], {
      transactionPerMigration: false,
      phase: 'expand',
    });
    expect(steps.flatMap((step) => step.migrations.map((m) => m.tag))).toEqual(['a']);
    expect(deferred.map((m) => m.tag)).toEqual(['c', 'd']);
    expect(
      planSteps([contract, migration('d', 3)], { transactionPerMigration: false, phase: 'contract' }).steps,
    ).toHaveLength(1);
    expect(
      planSteps([migration('a', 1)], { transactionPerMigration: false, phase: 'expand' }).deferred,
    ).toEqual([]);
  });
});

describe('пауза повтора и отказ мигратора', () => {
  it('retryPauseMs: доля от backoffMs × 2^(попытка−1), не выше потолка таймера', () => {
    expect(retryPauseMs(1, 100, () => 1)).toBe(100);
    expect(retryPauseMs(3, 100, () => 0.5)).toBe(200);
    expect(retryPauseMs(2, 100, () => 0)).toBe(0);
    expect(retryPauseMs(60, 1_000, () => 1)).toBe(TIMER_LIMIT.MAX_DELAY_MS);
  });

  it('migrationFailure: шаг и правда о сделанном по его виду; пустые detail и hint — без строк', () => {
    const database = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
      detail: '',
      hint: '',
    });
    const outside = migrationFailure(
      new MigrationStepError(
        ['0001_idx'],
        STEP_KIND.noTransaction,
        new Error('Failed query', { cause: database }),
      ),
      100,
    ).message.split('\n');
    expect(outside[0]).toBe('Миграции не применены: canceling statement due to lock timeout');
    expect(outside[1]).toBe('миграция: 0001_idx (вне транзакции)');
    expect(outside[2]).toContain('Шаг вне транзакции не откатывается');
    expect(outside[2]).not.toContain('откачена целиком');
    expect(outside).toHaveLength(3);
    const inside = migrationFailure(
      new MigrationStepError(['0002_col'], STEP_KIND.transaction, database),
      100,
    );
    expect(inside.message).toContain('миграция: 0002_col (в транзакции)');
    expect(inside.message).toContain('откачена целиком');
    const left = migrationFailure(
      new MigrationStepError(['0001_idx'], STEP_KIND.noTransaction, database, [
        { schema: 's', index: 'i"x', table: 't' },
      ]),
    );
    expect(left.message).toContain('оставлены INVALID-индексы: s.i"x (таблица t)');
    expect(left.message).toContain('DROP INDEX CONCURRENTLY "s"."i""x"');
  });

  it('abortableDelay: отмена снимает таймер — цикл событий не держится до срабатывания', async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = abortableDelay(60_000, controller.signal);
      expect(jest.getTimerCount()).toBe(1);
      controller.abort(new Error('стоп'));
      await expect(pending).rejects.toThrow('стоп');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('проверка опций до лока', () => {
  const base = { lockKey: 'k', migrationsFolder: '/нет', log: () => undefined };

  it.each([
    [{ lockKey: '' }, 'lockKey пуст'],
    [{ lockKey: '   ' }, 'lockKey пуст'],
    [{ lockKey: 'k ' }, 'пробелами по краям'],
    [{ schema: ' ' }, 'schema пуст'],
    [{ migrationsSchema: '' }, 'migrationsSchema пуст'],
    [{ invalidIndexSchemas: ['ok', ' '] }, 'invalidIndexSchemas: пустое имя схемы'],
    [{ noTransactionLockTimeoutMs: 0 }, 'noTransactionLockTimeoutMs — целое больше нуля'],
    [{ lockTimeoutRetry: { attempts: 1, backoffMs: -1 } }, 'lockTimeoutRetry'],
    [{ lockTimeoutRetry: { attempts: 1, backoffMs: TIMER_LIMIT.MAX_DELAY_MS + 1 } }, 'lockTimeoutRetry'],
    [{ lockPollMs: TIMER_LIMIT.MAX_DELAY_MS + 1 }, 'lockPollMs'],
    [{ phase: 'later' }, 'phase — expand | contract'],
    [{ slowMigrationMs: 0 }, 'slowMigrationMs'],
  ])('%p — отказ', (patch, reason) => {
    expect(() => resolveMigrateSettings({ ...base, ...(patch as object) })).toThrow(reason);
  });

  it('границы допустимого принимаются; схемы INVALID-проверки — без повторов', () => {
    const settings = resolveMigrateSettings({
      ...base,
      lockTimeoutRetry: { attempts: 1, backoffMs: TIMER_LIMIT.MAX_DELAY_MS },
      lockPollMs: TIMER_LIMIT.MAX_DELAY_MS,
      schema: 'app',
      migrationsSchema: 'app',
      invalidIndexSchemas: ['app', 'side'],
    });
    expect(settings.invalidIndexSchemas).toEqual(['app', 'side']);
    expect(settings.attempts).toBe(1);
  });
});

describe('сверка типов и блокировки операторов', () => {
  it.each([
    ['varchar(128)', 'character varying(128)'],
    ['timestamp (0) with time zone', 'timestamp(0) with time zone'],
    ['timestamp(3)', 'timestamp(3) without time zone'],
    ['timestamp', 'timestamp without time zone'],
    ['serial', 'integer'],
    ['bigserial', 'bigint'],
    ['"public"."my_enum"', 'my_enum'],
    ['text[]', 'text[]'],
    // format_type печатает без пробела: прежнее ожидание закрепляло ложный column-type.
    ['numeric(10, 2)', 'numeric(10,2)'],
  ])('%s → %s', (input, output) => {
    expect(normalizeColumnType(input)).toBe(output);
  });

  it.each([
    ['CREATE INDEX CONCURRENTLY i ON t (x)', 'SHARE UPDATE EXCLUSIVE', false],
    [
      '-- pg-migrate:no-transaction\nCREATE UNIQUE INDEX CONCURRENTLY i ON t (x)',
      'SHARE UPDATE EXCLUSIVE',
      false,
    ],
    ['CREATE INDEX i ON t (x)', 'SHARE', true],
    ['ALTER TABLE t ADD COLUMN c int', 'ACCESS EXCLUSIVE', true],
    ['ALTER TABLE t VALIDATE CONSTRAINT c', 'SHARE UPDATE EXCLUSIVE', false],
    ['ALTER TABLE t ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES u (id)', 'SHARE ROW EXCLUSIVE', true],
    ['UPDATE t SET a = 1', 'ROW EXCLUSIVE', false],
    ['CREATE TABLE t (x int)', '—', false],
    ['VACUUM t', undefined, false],
  ])('%s — %s', (statement, mode, blocksWrites) => {
    const lock = classifyStatementLock(statement);
    expect([lock.mode, lock.blocksWrites]).toEqual([mode, blocksWrites]);
  });
});
