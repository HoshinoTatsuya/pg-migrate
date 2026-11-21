import { deepFreeze } from '../deep-freeze';

/** Вид ограничения по `pg_constraint.contype` — в `expected`/`actual` расхождения. */
export const CONSTRAINT_KIND_TITLE = { u: 'UNIQUE', f: 'FOREIGN KEY', c: 'CHECK' } as const;

deepFreeze(CONSTRAINT_KIND_TITLE);
