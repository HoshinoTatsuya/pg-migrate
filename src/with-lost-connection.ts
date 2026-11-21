import { valueText } from './value-text';
/**
 * Отказ после разрыва сессии — с причиной разрыва: «not queryable» следующего
 * запроса ничего не объясняет. Уже дополненный отказ не дополняется второй раз.
 */
export function withLostConnection(error: unknown, lost: Error | undefined): unknown {
  if (lost === undefined || (error as { lostConnection?: unknown } | null)?.lostConnection === lost) {
    return error;
  }
  const text = error instanceof Error ? error.message : valueText(error);
  return Object.assign(
    new Error(`${text}\nсоединение мигратора разорвано сервером: ${lost.message}`, { cause: error }),
    { lostConnection: lost },
  );
}
