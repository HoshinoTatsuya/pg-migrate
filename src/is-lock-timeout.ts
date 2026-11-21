import { POSTGRES_ERROR_CODE } from './constants/postgres-error-code.constant';

/** 55P03 — сам или в `cause` (drizzle заворачивает ошибку базы в свою). */
export function isLockTimeout(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === POSTGRES_ERROR_CODE.LOCK_NOT_AVAILABLE) {
      return true;
    }
  }
  return false;
}
