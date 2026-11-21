import { deepFreeze } from '../deep-freeze';

/** Как применяется шаг: транзакцией drizzle, оператор за оператором вне транзакции, порциями. */
export const STEP_KIND = {
  transaction: 'transaction',
  noTransaction: 'no-transaction',
  batched: 'batched',
} as const;

deepFreeze(STEP_KIND);
