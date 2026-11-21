/** Идентификатор Postgres в двойных кавычках: внутренние кавычки удваиваются. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
