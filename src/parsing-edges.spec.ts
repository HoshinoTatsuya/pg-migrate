import { createServer, type Server, type Socket } from 'node:net';

import { classifyStatementLock } from './classify-statement-lock';
import { connectWithRetry } from './connect-with-retry';
import { STEP_KIND } from './constants/step-kind.constant';
import { TIMER_LIMIT } from './constants/timer-limit.constant';
import { normalizeColumnType } from './normalize-column-type';
import { readDirectives } from './read-directives';

describe('разбор без базы: типы снимка, заголовок, блокировки', () => {
  // Слева — как пишет снимок drizzle-kit (или свой тип), справа — format_type Postgres.
  it.each([
    ['int[]', 'integer[]'],
    ['int4[][]', 'integer[][]'],
    ['int8[]', 'bigint[]'],
    ['int2[]', 'smallint[]'],
    ['bool[]', 'boolean[]'],
    ['float8[]', 'double precision[]'],
    ['float4[]', 'real[]'],
    ['timestamptz(3)', 'timestamp(3) with time zone'],
    ['timestamptz(3)[]', 'timestamp(3) with time zone[]'],
    ['timetz(6)', 'time(6) with time zone'],
    ['numeric(10, 2)', 'numeric(10,2)'],
    ['numeric(3, 1)[]', 'numeric(3,1)[]'],
    ['char', 'character(1)'],
    ['char[]', 'character(1)[]'],
    ['character', 'character(1)'],
  ])('тип снимка %s совпадает с format_type %s', (snapshot, catalog) => {
    expect(normalizeColumnType(snapshot)).toBe(normalizeColumnType(catalog));
  });

  it.each([
    ['int', 'bigint'],
    ['numeric(10, 2)', 'numeric(10,3)'],
    ['char(2)', 'character(1)'],
    ['timestamptz(3)', 'timestamp(6) with time zone'],
    ['int[]', 'integer'],
  ])('двойник: разные типы %s и %s различаются', (snapshot, catalog) => {
    expect(normalizeColumnType(snapshot)).not.toBe(normalizeColumnType(catalog));
  });

  it.each([
    ['-- pg-migrate:batched batch=100=abc', 'batch=100=abc'],
    ['-- pg-migrate:batched pause=', 'pause='],
    ['-- pg-migrate:batched batch=1e3', 'batch=1e3'],
    ['-- pg-migrate:batched batch=0x10', 'batch=0x10'],
    [`-- pg-migrate:batched pause=${TIMER_LIMIT.MAX_DELAY_MS + 1}`, `pause=${TIMER_LIMIT.MAX_DELAY_MS + 1}`],
  ])('заголовок %s — отказ с параметром', (header, param) => {
    expect(() => readDirectives('m', `${header}\nUPDATE t SET a = 1`)).toThrow(`параметр «${param}»`);
  });

  it('двойник: граничные значения порции и паузы принимаются', () => {
    expect(
      readDirectives('m', `-- pg-migrate:batched batch=1 pause=${TIMER_LIMIT.MAX_DELAY_MS}\nUPDATE t`),
    ).toMatchObject({ kind: STEP_KIND.batched, batchSize: 1, pauseMs: TIMER_LIMIT.MAX_DELAY_MS });
  });

  it.each([
    '-- pg-migrate:no-transaction\n-- pg-migrate:batched\nUPDATE t',
    '-- pg-migrate:batched\n-- pg-migrate:no-transaction\nUPDATE t',
  ])('no-transaction и batched вместе — отказ: %s', (text) => {
    expect(() => readDirectives('m', text)).toThrow('взаимоисключающие');
  });

  it('BOM в начале файла не прячет первую директиву (trim снимает U+FEFF)', () => {
    expect(
      readDirectives('m', '﻿-- pg-migrate:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (a)'),
    ).toMatchObject({ kind: STEP_KIND.noTransaction });
  });

  it.each([
    [
      'ALTER TABLE t ADD COLUMN x int, VALIDATE CONSTRAINT c',
      { mode: 'ACCESS EXCLUSIVE', blocksWrites: true, blocksReads: true },
    ],
    [
      'ALTER TABLE t ALTER COLUMN a SET NOT NULL, ADD CONSTRAINT x CHECK (b IN (1, 2)) NOT VALID',
      { mode: 'ACCESS EXCLUSIVE', blocksWrites: true, blocksReads: true },
    ],
    [
      "ALTER TABLE t VALIDATE CONSTRAINT c, ALTER COLUMN a SET DEFAULT 'x,y'",
      { mode: 'ACCESS EXCLUSIVE', blocksWrites: true, blocksReads: true },
    ],
  ])('составной ALTER TABLE — сильнейшая блокировка из действий: %s', (statement, lock) => {
    expect(classifyStatementLock(statement)).toMatchObject(lock);
  });

  it('составной ALTER TABLE — пояснения всех действий: «держится, пока проверяются все строки» не теряется за NOT VALID', () => {
    expect(
      classifyStatementLock(
        'ALTER TABLE t ALTER COLUMN a SET NOT NULL, ADD CONSTRAINT x CHECK (a > 0) NOT VALID',
      ).note,
    ).toContain('держится, пока проверяются все строки');
  });

  it('ключевые слова внутри строки — не действие: DEFAULT с текстом «VALIDATE CONSTRAINT» — ADD COLUMN, ACCESS EXCLUSIVE', () => {
    expect(
      classifyStatementLock("ALTER TABLE t ADD COLUMN c text DEFAULT 'VALIDATE CONSTRAINT x'"),
    ).toMatchObject({
      mode: 'ACCESS EXCLUSIVE',
      blocksWrites: true,
    });
  });

  it('двойник: одно действие и запятые внутри скобок и строк — как прежде', () => {
    expect(classifyStatementLock('ALTER TABLE t VALIDATE CONSTRAINT c')).toMatchObject({
      mode: 'SHARE UPDATE EXCLUSIVE',
      blocksWrites: false,
    });
    expect(
      classifyStatementLock("ALTER TABLE t ADD CONSTRAINT c CHECK (a IN ('x,y', 'z')) NOT VALID"),
    ).toEqual(classifyStatementLock('ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0) NOT VALID'));
  });
});

describe('connectWithRetry: отмена и интервал', () => {
  let server: Server;
  let port = 0;
  const sockets: Socket[] = [];
  beforeAll(async () => {
    // Принимает и молчит: попытка соединения висит до своего потолка.
    server = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  });

  it('отмена посреди попытки прерывает её сразу, а не по потолку соединения', async () => {
    const controller = new AbortController();
    const reason = new Error('деплой отменён');
    setTimeout(() => controller.abort(reason), 200);
    const outcome = await Promise.race([
      connectWithRetry({ host: '127.0.0.1', port }, 20_000, 100, () => undefined, {
        signal: controller.signal,
      }).catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('висит'), 3_000)),
    ]);
    expect(outcome).toBe(reason);
  });

  it('интервал больше потолка таймера — одна попытка и отказ, а не опрос без паузы', async () => {
    const closing = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => closing.listen(0, '127.0.0.1', resolve));
    const closedPort = (closing.address() as { port: number }).port;
    const lines: string[] = [];
    try {
      const failure = await connectWithRetry(
        { host: '127.0.0.1', port: closedPort },
        1_500,
        TIMER_LIMIT.MAX_DELAY_MS + 5,
        (line) => lines.push(line),
      ).catch((error: unknown) => error as Error);
      expect((failure as Error).message).toMatch(/^База недоступна за 1500 мс \(1 попыток\)/);
      expect(lines).toEqual([]);
    } finally {
      await new Promise((resolve) => closing.close(resolve));
    }
  });
});
