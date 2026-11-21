/** Снимок drizzle-kit (postgresql, version 5–7) — то, что читает сверка. */
export interface DrizzleSnapshot {
  readonly tables: Record<
    string,
    {
      readonly name: string;
      readonly schema: string;
      readonly columns: Record<
        string,
        {
          readonly name: string;
          readonly type: string;
          readonly notNull?: boolean;
          readonly default?: unknown;
          readonly primaryKey?: boolean;
          /** Ранние версии снимка: UNIQUE колонки — на самой колонке, а не в `uniqueConstraints`. */
          readonly isUnique?: boolean;
          readonly uniqueName?: string;
        }
      >;
      readonly indexes?: Record<string, { readonly name: string; readonly isUnique?: boolean }>;
      readonly uniqueConstraints?: Record<string, { readonly name: string }>;
      readonly compositePrimaryKeys?: Record<
        string,
        { readonly name: string; readonly columns?: readonly string[] }
      >;
      readonly foreignKeys?: Record<string, { readonly name: string }>;
      readonly checkConstraints?: Record<string, { readonly name: string }>;
    }
  >;
}
