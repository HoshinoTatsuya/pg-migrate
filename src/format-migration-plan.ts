import type { MigrationPlan } from './types/migration-plan.type';

/** План строками для журнала деплоя: шаг, миграция, оператор (до 120 символов) и его блокировка. */
export function formatMigrationPlan(plan: MigrationPlan): string[] {
  if (plan.steps.length === 0) {
    return [
      plan.deferred.length > 0
        ? `применять нечего; отложены до фазы contract: ${plan.deferred.join(', ')}`
        : 'применять нечего',
    ];
  }
  const lines: string[] = [];
  plan.steps.forEach((step, index) => {
    lines.push(
      `шаг ${index + 1} (${step.kind}): ${step.migrations.map((migration) => migration.tag).join(', ')}`,
    );
    for (const migration of step.migrations) {
      for (const statement of migration.statements) {
        const text = statement.text.replace(/\s+/g, ' ');
        const flags = [
          statement.lock.blocksWrites ? 'останавливает запись' : '',
          statement.lock.blocksReads ? 'останавливает чтение' : '',
        ].filter((flag) => flag !== '');
        lines.push(
          `  ${migration.tag}: ${text.length > 120 ? `${text.slice(0, 117)}...` : text} — ` +
            `${statement.lock.mode ?? 'блокировка не классифицирована'}` +
            `${flags.length > 0 ? ` (${flags.join(', ')})` : ''}: ${statement.lock.note}`,
        );
      }
    }
  });
  if (plan.deferred.length > 0) {
    lines.push(`отложены до фазы contract: ${plan.deferred.join(', ')}`);
  }
  return lines;
}
