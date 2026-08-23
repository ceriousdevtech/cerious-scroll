/**
 * @fileoverview Guards the ESM specifiers that ship to consumers.
 *
 * Node's ESM resolver does not add file extensions. A single extensionless
 * relative specifier anywhere in the published output makes the package
 * unloadable in plain Node — and because every wrapper package imports this
 * one, it takes them down too, regardless of how they bundle themselves.
 *
 * Checked at source rather than on the build output so it fails before an
 * artifact exists, and points at the file to edit.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** `from './x'` or `import './x'` targeting a relative path. */
const RELATIVE_SPECIFIER = /(?:from|import)\s+['"](\.\.?\/[^'"]*)['"]/g;

describe('published ESM specifiers', () => {
  it('every relative import in src carries a .js extension', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
        const specifier = match[1];
        if (specifier.endsWith('.js')) continue;
        // Directory specifiers are equally broken: Node ESM has no index
        // resolution either.
        offenders.push(`${file.replace(process.cwd() + '/', '')}: '${specifier}'`);
      }
    }

    expect(
      offenders,
      'Node ESM resolves neither extensionless nor directory specifiers. ' +
      'Append `.js` — TypeScript maps it back to the .ts source:\n  ' +
      offenders.join('\n  ')
    ).toEqual([]);
  });
});
