import type { InvalidIndex } from './types/invalid-index.type';
import type { StepKind } from './types/step-kind.type';

/**
 * Отказ шага применения: какие миграции, каким способом (в транзакции, вне её,
 * порциями) и какие INVALID-индексы шаг оставил. Исходный отказ — в `cause`.
 * По виду шага отличается правда о сделанном: транзакция откачена целиком,
 * шаг вне транзакции — нет.
 */
export class MigrationStepError extends Error {
  public override readonly name = 'MigrationStepError';

  public constructor(
    public readonly tags: readonly string[],
    public readonly kind: StepKind,
    cause: unknown,
    public readonly leftInvalidIndexes: readonly InvalidIndex[] = [],
  ) {
    super(
      `миграция ${tags.join(', ')} (${kind}): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
