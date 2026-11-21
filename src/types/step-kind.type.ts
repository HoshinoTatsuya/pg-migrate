import type { STEP_KIND } from '../constants/step-kind.constant';

export type StepKind = (typeof STEP_KIND)[keyof typeof STEP_KIND];
