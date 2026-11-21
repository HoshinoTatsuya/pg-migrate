/**
 * Текст оператора без комментариев (`--`, вложенные `/* … *\/`), строк
 * (`'…'`, `E'…'` с `\'`, `$тег$…$тег$`) и идентификаторов в кавычках — на их
 * месте пробел. По нему ищется то, что видит сервер как код: `$1` в комментарии
 * или строке — не параметр. Незакрытая строка или комментарий — остаток до
 * конца текста считается данными (сервер такой оператор всё равно отвергнет).
 */
export function sqlWithoutLiterals(text: string): string {
  let out = '';
  let i = 0;
  const skipTo = (end: number): void => {
    out += ' ';
    i = end;
  };
  while (i < text.length) {
    const char = text[i] as string;
    const next = text[i + 1];
    if (char === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      skipTo(end === -1 ? text.length : end);
      continue;
    }
    if (char === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      skipTo(j);
      continue;
    }
    if (char === "'" || char === '"') {
      const escapes =
        char === "'" && /[eE]/.test(text[i - 1] ?? '') && !/[\p{L}\p{N}_$]/u.test(text[i - 2] ?? '');
      let j = i + 1;
      while (j < text.length) {
        if (escapes && text[j] === '\\') {
          j += 2;
        } else if (text[j] === char && text[j + 1] === char) {
          j += 2;
        } else if (text[j] === char) {
          j += 1;
          break;
        } else {
          j += 1;
        }
      }
      skipTo(Math.min(j, text.length));
      continue;
    }
    if (char === '$' && !/[\p{L}\p{N}_$]/u.test(text[i - 1] ?? '')) {
      const tag = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(text.slice(i))?.[0];
      if (tag !== undefined) {
        const end = text.indexOf(tag, i + tag.length);
        skipTo(end === -1 ? text.length : end + tag.length);
        continue;
      }
    }
    out += char;
    i += 1;
  }
  return out;
}
