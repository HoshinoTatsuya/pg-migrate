/**
 * Действия составного `ALTER TABLE t a, b, c` — по запятым верхнего уровня
 * (не внутри скобок, строк и идентификаторов в кавычках). Каждое, кроме
 * первого, возвращается с началом `ALTER TABLE _ `, чтобы правила блокировок
 * узнавали его так же, как отдельный оператор. Не `ALTER TABLE` или одно
 * действие — `[statement]`.
 */
export function alterTableActions(statement: string): string[] {
  if (!/^ALTER\s+TABLE\b/i.test(statement)) {
    return [statement];
  }
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < statement.length; i += 1) {
    const char = statement[i];
    if (char === "'" || char === '"') {
      const close = statement.indexOf(char, i + 1);
      i = close === -1 ? statement.length : close;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(statement.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(statement.slice(start));
  return parts.map((part, index) => (index === 0 ? part.trim() : `ALTER TABLE _ ${part.trim()}`));
}
