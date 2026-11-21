/**
 * В каком состоянии хук оставил сессию мигратора перед уборкой. `failed` —
 * прерванная транзакция (25P02): в ней не проходят ни RESET, ни снятие лока,
 * `open` — незавершённая: RESET в ней откатится вместе с ней. `unknown` —
 * сессия не ответила (обрыв), уборка всё равно пробует каждый шаг.
 */
export const SESSION_TRANSACTION = {
  none: 'none',
  open: 'open',
  failed: 'failed',
  unknown: 'unknown',
} as const;

export type SessionTransaction = (typeof SESSION_TRANSACTION)[keyof typeof SESSION_TRANSACTION];
