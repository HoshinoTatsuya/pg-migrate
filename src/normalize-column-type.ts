import { TYPE_ALIASES } from './constants/type-aliases.constant';

/**
 * Тип колонки в одной форме для сравнения снимка с базой: нижний регистр, без
 * кавычек и схемы, `timestamp (0)` → `timestamp(0)`, `numeric(10, 2)` →
 * `numeric(10,2)` (drizzle пишет пробел, `format_type` — нет), синонимы → имя Postgres,
 * `timestamp`/`time` без зоны — с явным `without time zone`, как у `format_type`.
 */
export function normalizeColumnType(type: string): string {
  let value = type
    .trim()
    .toLowerCase()
    .replaceAll('"', '')
    .replace(/\s+\(/g, '(')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ');
  value = value.replace(/^[a-z_][a-z0-9_]*\.(?=[a-z_])/, '');
  for (const [pattern, replacement] of TYPE_ALIASES) {
    value = value.replace(pattern, replacement);
  }
  if (/^(timestamp|time)(\(\d+\))?(\[\])*$/.test(value)) {
    value = value.replace(/^(timestamp|time)(\(\d+\))?/, '$1$2 without time zone');
  }
  return value;
}
