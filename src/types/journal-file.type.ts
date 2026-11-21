/** `meta/_journal.json` drizzle-kit: записи по порядку применения. */
export interface JournalFile {
  readonly entries: ReadonlyArray<{
    readonly idx?: number;
    readonly tag: string;
    readonly when: number;
    readonly [key: string]: unknown;
  }>;
  readonly [key: string]: unknown;
}
