import type { StatementLock } from './types/statement-lock.type';

/** Описание блокировки оператора — замороженным: правила общие для процесса. */
export function statementLock(
  mode: string,
  blocksWrites: boolean,
  blocksReads: boolean,
  note: string,
): StatementLock {
  return Object.freeze({ mode, blocksWrites, blocksReads, note });
}
