/**
 * Написание типа в снимке drizzle-kit → как его печатает `format_type`
 * Postgres. serial — integer с DEFAULT nextval: в снимке это тип, в базе — нет.
 * Синоним заменяется и у массива (`int[]` → `integer[]`), точность у типа с
 * зоной встаёт до неё (`timestamptz(3)` → `timestamp(3) with time zone`), а
 * `char` без длины — `character(1)`, как его создаёт Postgres.
 */
export const TYPE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/^varchar\b/, 'character varying'],
  [/^char\b/, 'character'],
  [/^serial(?=(?:\[\])*$)/, 'integer'],
  [/^serial4(?=(?:\[\])*$)/, 'integer'],
  [/^bigserial(?=(?:\[\])*$)/, 'bigint'],
  [/^serial8(?=(?:\[\])*$)/, 'bigint'],
  [/^smallserial(?=(?:\[\])*$)/, 'smallint'],
  [/^int(?=(?:\[\])*$)/, 'integer'],
  [/^int4(?=(?:\[\])*$)/, 'integer'],
  [/^int8(?=(?:\[\])*$)/, 'bigint'],
  [/^int2(?=(?:\[\])*$)/, 'smallint'],
  [/^bool(?=(?:\[\])*$)/, 'boolean'],
  [/^float8(?=(?:\[\])*$)/, 'double precision'],
  [/^float4(?=(?:\[\])*$)/, 'real'],
  [/^decimal\b/, 'numeric'],
  [/^timestamptz(\(\d+\))?(?=(?:\[\])*$)/, 'timestamp$1 with time zone'],
  [/^timetz(\(\d+\))?(?=(?:\[\])*$)/, 'time$1 with time zone'],
  [/^character(?=(?:\[\])*$)/, 'character(1)'],
]);
