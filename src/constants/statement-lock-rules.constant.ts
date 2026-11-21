import { statementLock } from '../statement-lock';
import type { StatementLock } from '../types/statement-lock.type';

/**
 * Какую блокировку берёт оператор — по началу текста (без комментариев).
 * Порядок важен: первое совпадение. Это подсказка ревью деплоя, а не разбор
 * SQL: незнакомое — «не классифицировано», а не «безопасно».
 */
export const STATEMENT_LOCK_RULES: ReadonlyArray<readonly [RegExp, StatementLock]> = Object.freeze([
  [
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i,
    statementLock(
      'SHARE UPDATE EXCLUSIVE',
      false,
      false,
      'строит индекс без остановки записи; вне транзакции',
    ),
  ],
  [
    /^CREATE\s+(UNIQUE\s+)?INDEX\b/i,
    statementLock('SHARE', true, false, 'запись в таблицу стоит всё время построения индекса'),
  ],
  [
    /^REINDEX\b.*\bCONCURRENTLY\b/is,
    statementLock('SHARE UPDATE EXCLUSIVE', false, false, 'пересборка без остановки записи; вне транзакции'),
  ],
  [/^REINDEX\b/i, statementLock('SHARE', true, true, 'запись стоит, чтение по индексу ждёт')],
  [
    /^DROP\s+INDEX\s+CONCURRENTLY\b/i,
    statementLock('SHARE UPDATE EXCLUSIVE', false, false, 'вне транзакции'),
  ],
  [
    /^DROP\s+INDEX\b/i,
    statementLock('ACCESS EXCLUSIVE', true, true, 'коротко, но ждёт всех читателей таблицы'),
  ],
  [
    /^ALTER\s+TABLE\b.*\bVALIDATE\s+CONSTRAINT\b/is,
    statementLock('SHARE UPDATE EXCLUSIVE', false, false, 'проверка строк без остановки записи'),
  ],
  [
    /^ALTER\s+TABLE\b.*\bNOT\s+VALID\b/is,
    statementLock('ACCESS EXCLUSIVE', true, true, 'коротко: строки не проверяются'),
  ],
  [
    /^ALTER\s+TABLE\b.*\b(FOREIGN\s+KEY|REFERENCES)\b/is,
    statementLock(
      'SHARE ROW EXCLUSIVE',
      true,
      false,
      'обе таблицы: запись стоит, пока проверяются все строки; NOT VALID + VALIDATE — без остановки',
    ),
  ],
  [
    /^ALTER\s+TABLE\b.*\bSET\s+NOT\s+NULL\b/is,
    statementLock('ACCESS EXCLUSIVE', true, true, 'держится, пока проверяются все строки'),
  ],
  [
    /^ALTER\s+TABLE\b.*\bALTER\s+(COLUMN\s+)?\S+\s+(SET\s+DATA\s+)?TYPE\b/is,
    statementLock('ACCESS EXCLUSIVE', true, true, 'смена типа обычно переписывает таблицу целиком'),
  ],
  [
    /^ALTER\s+TABLE\b/i,
    statementLock(
      'ACCESS EXCLUSIVE',
      true,
      true,
      'коротко для метаданных; любое ожидание держит очередь запросов за собой',
    ),
  ],
  [/^(DROP\s+TABLE|TRUNCATE)\b/i, statementLock('ACCESS EXCLUSIVE', true, true, 'таблица недоступна')],
  [
    /^(UPDATE|DELETE|MERGE)\b/i,
    statementLock(
      'ROW EXCLUSIVE',
      false,
      false,
      'блокировки строк держатся до конца транзакции — бэкфилл порциями (batched)',
    ),
  ],
  [/^INSERT\b/i, statementLock('ROW EXCLUSIVE', false, false, 'обычная запись')],
  [
    /^CREATE\s+(TABLE|SCHEMA|TYPE|SEQUENCE|EXTENSION|(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|VIEW))\b/i,
    statementLock('—', false, false, 'новый объект: существующие таблицы не блокируются'),
  ],
]);
