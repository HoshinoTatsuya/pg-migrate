import { Client } from 'pg';

import { connectWithRetry } from './connect-with-retry';
import { migrationFailure } from './migration-failure';
import { withLostConnection } from './with-lost-connection';

const STRANGE = [
  ['без прототипа', (): unknown => Object.create(null)],
  [
    'с бросающим toString',
    (): unknown => ({
      toString: () => {
        throw new Error('toString');
      },
    }),
  ],
] as const;

/**
 * Отказ, у которого `String()` бросает: текст причины строится без TypeError —
 * ветка, разбирающая отказ мигратора, иначе прятала бы исходную причину.
 */
describe('текст отказа мигратора не бросает', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(STRANGE)('migrationFailure: отказ %s — Error с текстом', (_label, make) => {
    const failure = migrationFailure(make());
    expect(failure.message).toBe('Миграции не применены: [object Object]');
  });

  it.each(STRANGE)('withLostConnection: отказ %s — дополнен причиной разрыва', (_label, make) => {
    const result = withLostConnection(make(), new Error('terminating connection')) as Error;
    expect(result.message).toBe(
      '[object Object]\nсоединение мигратора разорвано сервером: terminating connection',
    );
  });

  it.each(STRANGE)(
    'connectWithRetry: подключение отказало %s — отказ по дедлайну с текстом причины',
    async (_label, make) => {
      jest.spyOn(Client.prototype, 'connect').mockImplementation(() => Promise.reject(make()));
      jest.spyOn(Client.prototype, 'end').mockImplementation(() => Promise.resolve());
      const lines: string[] = [];
      await expect(
        connectWithRetry({ host: '127.0.0.1', port: 1 }, 1, 1, (line) => lines.push(line)),
      ).rejects.toThrow(/последняя причина: \[object Object\]$/);
    },
  );
});
