import type { StepKind } from './step-kind.type';

/** Что сделал шаг и сколько длился. */
export interface StepReport {
  readonly tags: readonly string[];
  readonly kind: StepKind;
  readonly durationMs: number;
  /** Для `batched` — строк затронуто и порций выполнено. */
  readonly rows?: number;
  readonly batches?: number;
}
