import { Client, type ClientConfig } from 'pg';

import { abortableDelay } from './abortable-delay';
import { MIGRATE_DEFAULTS } from './constants/migrate-defaults.constant';
import { TIMER_LIMIT } from './constants/timer-limit.constant';
import { valueText } from './value-text';

/**
 * Соединение с повторами до дедлайна. Мигратор стартует рядом с базой
 * (`depends_on: service_started` готовности не ждёт), и первые секунды после
 * перезагрузки хоста база отвечает отказом. Каждая попытка — строкой в лог;
 * дедлайн — отказ с числом попыток и последней причиной.
 *
 * Новая попытка — только если до дедлайна остаётся хотя бы
 * `MIGRATE_DEFAULTS.MIN_CONNECT_ATTEMPT_MS` (или свой потолок вызывающего,
 * если он меньше): попытка с потолком в единицы мс не успевает ничего и
 * подменяет настоящую причину отказа таймаутом.
 *
 * У возвращённого клиента стоит обработчик `'error'` (строка в лог): разрыв
 * сессии сервером без активного запроса без слушателя роняет процесс.
 */
export async function connectWithRetry(
  config: ClientConfig,
  deadlineMs: number,
  intervalMs: number,
  log: (line: string) => void,
  options: { readonly signal?: AbortSignal } = {},
): Promise<Client> {
  // NaN в дедлайне или интервале делает сравнение с дедлайном ложным всегда:
  // повторы шли бы вечно. Дедлайн больше потолка таймера стал бы потолком
  // попытки, а его setTimeout превращает в 1 мс — ни одна попытка не успела бы.
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > TIMER_LIMIT.MAX_DELAY_MS) {
    throw new Error(
      `connectWithRetry: deadlineMs — число больше нуля и не больше ${TIMER_LIMIT.MAX_DELAY_MS}, получено ${deadlineMs}`,
    );
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error(`connectWithRetry: intervalMs — неотрицательное число, получено ${intervalMs}`);
  }
  const startedAt = Date.now();
  let attempt = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    attempt += 1;
    // Попытка не дольше остатка до дедлайна: без потолка соединения хост,
    // молча роняющий пакеты (security group, чёрная дыра маршрута), держал
    // бы ОДНУ попытку до таймаута TCP ОС — минуты поверх дедлайна.
    const remaining = Math.max(1, deadlineMs - (Date.now() - startedAt));
    const ownCeiling = config.connectionTimeoutMillis;
    const client = new Client({
      ...config,
      connectionTimeoutMillis:
        ownCeiling !== undefined && ownCeiling > 0 ? Math.min(ownCeiling, remaining) : remaining,
    });
    // Отмена прерывает и саму попытку: без этого она ждала бы потолка соединения
    // (до всего дедлайна), а не уходила сразу.
    const onAbort = (): void => {
      (
        client as unknown as { connection?: { stream?: { destroy?: () => void } } }
      ).connection?.stream?.destroy?.();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await client.connect();
      client.on('error', (error: Error) => log(`соединение с базой разорвано: ${error.message}`));
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      options.signal?.throwIfAborted();
      const reason = error instanceof Error ? error.message : valueText(error);
      const floor =
        ownCeiling !== undefined && ownCeiling > 0
          ? Math.min(ownCeiling, MIGRATE_DEFAULTS.MIN_CONNECT_ATTEMPT_MS)
          : MIGRATE_DEFAULTS.MIN_CONNECT_ATTEMPT_MS;
      // Остаток после паузы меньше порога — следующая попытка ничего не успела бы.
      if (deadlineMs - (Date.now() - startedAt + intervalMs) < Math.min(floor, deadlineMs)) {
        throw new Error(
          `База недоступна за ${deadlineMs} мс (${attempt} попыток), последняя причина: ${reason}`,
        );
      }
      log(`база ещё не отвечает (попытка ${attempt}): ${reason}`);
      await abortableDelay(intervalMs, options.signal);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}
