import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Карта exports — граница API: файл dist вне неё недоступен потребителю.
 * Каждый вход ведёт в существующий модуль исходников, typesVersions зеркалит
 * подпути для moduleResolution node10 (он exports не читает), а вход корня
 * совпадает с main/types для тех, кто читает только их.
 */
const ROOT = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  main: string;
  types: string;
  exports: Record<string, string | { types: string; default: string }>;
  typesVersions?: Record<string, Record<string, string[]>>;
};
const SUBPATHS: readonly string[] = [];

describe('карта exports пакета', () => {
  it('входы — ровно корень, объявленные подпути и package.json', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(
      ['.', './package.json', ...SUBPATHS.map((name) => `./${name}`)].sort(),
    );
  });

  it('каждый вход ведёт в существующий модуль исходников; корень совпадает с main/types', () => {
    const targets = Object.entries(manifest.exports).filter(([key]) => key !== './package.json');
    for (const [, target] of targets) {
      if (typeof target === 'string') {
        throw new Error(`вход без условий types/default: ${target}`);
      }
      expect(target.types.replace(/\.d\.ts$/, '')).toBe(target.default.replace(/\.js$/, ''));
      expect(
        existsSync(join(ROOT, target.default.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'))),
      ).toBe(true);
    }
    expect(manifest.exports['.']).toEqual({ types: manifest.types, default: manifest.main });
    expect(targets.length).toBe(1 + SUBPATHS.length);
  });

  it('typesVersions зеркалит подпути', () => {
    const mirrored = manifest.typesVersions?.['*'] ?? {};
    expect(Object.keys(mirrored).sort()).toEqual([...SUBPATHS].sort());
    for (const name of SUBPATHS) {
      const target = manifest.exports[`./${name}`];
      expect(mirrored[name]).toEqual([typeof target === 'string' ? target : target?.types]);
    }
  });
});
