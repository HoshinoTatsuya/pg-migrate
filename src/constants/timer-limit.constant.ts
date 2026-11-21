import { deepFreeze } from '../deep-freeze';

/**
 * Потолок таймеров Node: `setTimeout` с задержкой больше 2^31−1 мс (и с NaN,
 * нулём, отрицательной) срабатывает через 1 мс. Опрос лока с такой паузой —
 * это цикл запросов к базе без паузы.
 */
export const TIMER_LIMIT = {
  MAX_DELAY_MS: 2_147_483_647,
} as const;

deepFreeze(TIMER_LIMIT);
