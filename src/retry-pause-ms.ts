import { TIMER_LIMIT } from './constants/timer-limit.constant';

/**
 * Пауза перед повтором после попытки `attempt` (с 1): случайная доля от нуля
 * до `backoffMs × 2^(попытка−1)` (full jitter), не выше потолка таймера.
 */
export function retryPauseMs(attempt: number, backoffMs: number, random: () => number): number {
  return Math.min(TIMER_LIMIT.MAX_DELAY_MS, random() * backoffMs * 2 ** (attempt - 1));
}
