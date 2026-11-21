import { MIGRATE_DEFAULTS } from './constants/migrate-defaults.constant';
import { migrationFailure } from './migration-failure';

/**
 * Причина отказа миграции доходит до текста ошибки: точка входа деплоя пишет в
 * лог только `message`, а Drizzle кладёт туда SQL, а причину — в `cause`.
 */
describe('migrationFailure', () => {
  const drizzleFailure = (cause: unknown): Error =>
    new Error('Failed query: DO $$ … $$\nparams: ', { cause });

  it('сообщение, detail и hint ошибки базы — в тексте; SQL оператора — нет', () => {
    const database = Object.assign(new Error('зона сессии миграции «UTC»'), {
      detail: 'строки есть',
      hint: 'проверьте SHOW timezone',
    });

    const failure = migrationFailure(drizzleFailure(database));

    expect(failure.message).toBe(
      'Миграции не применены: зона сессии миграции «UTC»\nподробности: строки есть\nподсказка: проверьте SHOW timezone',
    );
    expect(failure.message).not.toContain('Failed query');
    expect((failure.cause as Error).cause).toBe(database);
  });

  it('ошибка без cause (отказ подключения) — её собственное сообщение', () => {
    expect(migrationFailure(new Error('connect ECONNREFUSED')).message).toBe(
      'Миграции не применены: connect ECONNREFUSED',
    );
  });

  // Postgres на истёкший lock_timeout отвечает одной строкой без таблицы и без
  // держателя; без подсказки оператор не отличит это от сбоя базы.
  it('отказ по lock_timeout (55P03) — с подсказкой: кто держит, что повтор безопасен, потолок вызывающего', () => {
    const database = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

    const lines = migrationFailure(drizzleFailure(database), 12_345).message.split('\n');

    expect(lines[0]).toBe('Миграции не применены: canceling statement due to lock timeout');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('дольше 12345 мс');
    expect(lines[1]).toContain('повтор безопасен');
    expect(lines[1]).toContain('FROM pg_stat_activity');
  });

  it('без потолка вызывающего — потолок по умолчанию', () => {
    const database = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

    expect(migrationFailure(drizzleFailure(database)).message).toContain(
      `дольше ${MIGRATE_DEFAULTS.LOCK_TIMEOUT_MS} мс`,
    );
  });

  it('подсказка про блокировку — только у 55P03, а не у любого кода', () => {
    const database = Object.assign(new Error('duplicate key value'), { code: '23505' });

    expect(migrationFailure(drizzleFailure(database)).message).toBe(
      'Миграции не применены: duplicate key value',
    );
  });

  it('не Error — строкой, а не пропадает', () => {
    expect(migrationFailure('обрыв').message).toBe('Миграции не применены: обрыв');
  });
});
