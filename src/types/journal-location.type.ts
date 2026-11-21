/** Где drizzle держит журнал применённых миграций. */
export interface JournalLocation {
  readonly schema: string;
  readonly table: string;
}
