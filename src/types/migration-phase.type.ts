import type { MIGRATION_PHASE } from '../constants/migration-phase.constant';

export type MigrationPhase = (typeof MIGRATION_PHASE)[keyof typeof MIGRATION_PHASE];
