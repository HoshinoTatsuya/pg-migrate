/** Режимы табличных блокировок Postgres от слабого к сильному: составной оператор берёт сильнейший. */
export const LOCK_MODE_STRENGTH: readonly string[] = Object.freeze([
  'ACCESS SHARE',
  'ROW SHARE',
  'ROW EXCLUSIVE',
  'SHARE UPDATE EXCLUSIVE',
  'SHARE',
  'SHARE ROW EXCLUSIVE',
  'EXCLUSIVE',
  'ACCESS EXCLUSIVE',
]);
