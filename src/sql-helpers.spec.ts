import { postgresIdentifier } from './postgres-identifier';
import { sqlWithoutLiterals } from './sql-without-literals';

describe('текст SQL: $1 вне литералов, имена как их сохранит Postgres', () => {
  it.each([
    ['UPDATE t SET a = 1 WHERE id IN (SELECT id FROM t WHERE a IS NULL LIMIT $1)', true],
    ['UPDATE t SET a = 1 -- порция $1\nWHERE a IS NULL', false],
    ["UPDATE t SET note = 'стоимость $1' WHERE note IS NULL", false],
    ['UPDATE t SET note = $$цена $1$$ WHERE note IS NULL', false],
    ['/* $1 */ UPDATE t SET a = 1 WHERE a IS NULL', false],
    ['UPDATE t SET "col$1" = 1 WHERE a IS NULL', false],
    ['UPDATE t SET a = $10 WHERE a IS NULL', false],
  ])('$1 вне комментариев и строк: %s → %s', (statement, parameter) => {
    expect(/\$1(?!\d)/.test(sqlWithoutLiterals(statement))).toBe(parameter);
  });

  it('имя длиннее 63 байт — так, как его обрежет Postgres (по границе символа)', () => {
    expect(postgresIdentifier('a'.repeat(70))).toBe('a'.repeat(63));
    expect(postgresIdentifier('я'.repeat(40))).toBe('я'.repeat(31));
    expect(postgresIdentifier('short')).toBe('short');
  });
});
