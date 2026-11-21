/** Расхождение живой базы со снимком drizzle-kit. */
export interface SchemaDrift {
  readonly kind:
    | 'missing-table'
    | 'extra-table'
    | 'missing-column'
    | 'extra-column'
    | 'column-type'
    | 'column-nullability'
    | 'column-default'
    | 'missing-index'
    | 'extra-index'
    | 'index-uniqueness'
    | 'index-invalid'
    | 'missing-constraint'
    | 'extra-constraint';
  /**
   * `схема.таблица`, `схема.таблица.колонка`, `схема.индекс`, ограничение —
   * `схема.таблица.имя` или `схема.таблица PRIMARY KEY (колонки)`.
   */
  readonly object: string;
  /** Что в снимке и что в базе — для типа, NOT NULL, DEFAULT, уникальности; вид ограничения. */
  readonly expected?: string;
  readonly actual?: string;
}
