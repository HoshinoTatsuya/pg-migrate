import { Client } from 'pg';

import { createTestDatabase, removeFolder } from './test-database';

/**
 * База на тест и клиенты к ней для спек мигратора: `beforeEach` создаёт базу,
 * `afterEach` закрывает клиентов, удаляет базу и каталог миграций.
 */
export const migratorDatabase = (adminUrl: string | undefined) => {
  const state = { url: '', drop: async (): Promise<void> => undefined, folder: '', lines: [] as string[] };
  const clients: Client[] = [];
  beforeEach(async () => {
    const database = await createTestDatabase(adminUrl as string);
    state.url = database.url;
    state.drop = database.drop;
    state.lines.length = 0;
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.end().catch(() => undefined);
    }
    await state.drop();
    if (state.folder !== '') {
      removeFolder(state.folder);
      state.folder = '';
    }
  });
  return {
    state,
    log: (line: string): void => {
      state.lines.push(line);
    },
    connect: async (url: string = state.url): Promise<Client> => {
      const client = new Client({ connectionString: url });
      // Тесты рвут сессии нарочно: разрыв клиента теста не роняет процесс.
      client.on('error', () => undefined);
      await client.connect();
      clients.push(client);
      return client;
    },
  };
};
