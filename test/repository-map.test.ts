import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

function expandBraces(value: string): string[] {
  const match = /\{([^{}]+)\}/.exec(value);
  if (!match || match.index === undefined) return [value];
  return match[1]!.split(',').flatMap((part) =>
    expandBraces(value.slice(0, match.index) + part + value.slice(match.index! + match[0].length))
  );
}

it('keeps explicit TypeScript paths in the repository map grounded in the tree', async () => {
  const root = process.cwd();
  const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  const tokens = [...agents.matchAll(/`(src\/[^`]+?\.ts)`/g)].map((match) => match[1]!);
  const paths = [...new Set(tokens.flatMap(expandBraces).filter((file) => !file.includes('*') && !/[ ,]/.test(file)))];

  expect(paths.length).toBeGreaterThan(50);
  for (const file of paths) await expect(access(path.join(root, file)), file).resolves.toBeUndefined();
});
