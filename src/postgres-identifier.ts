import { POSTGRES_LIMIT } from './constants/postgres-limit.constant';

/**
 * Имя так, как его сохранит Postgres: длиннее 63 байт обрезается по границе
 * символа (имя индекса или ограничения из снимка drizzle-kit бывает длиннее —
 * в каталоге оно уже обрезано, и сравнение полных имён давало бы ложное
 * «нет такого» и «лишний» на одном объекте).
 */
export function postgresIdentifier(name: string): string {
  if (Buffer.byteLength(name, 'utf8') <= POSTGRES_LIMIT.MAX_IDENTIFIER_BYTES) {
    return name;
  }
  let out = '';
  for (const char of name) {
    if (Buffer.byteLength(out + char, 'utf8') > POSTGRES_LIMIT.MAX_IDENTIFIER_BYTES) {
      break;
    }
    out += char;
  }
  return out;
}
