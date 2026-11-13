/**
 * Locate an executable, like which(1). Pure Node — no vscode import,
 * so it stays unit-testable.
 */

import * as fs from 'fs';
import * as path from 'path';

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Resolve `command` to an absolute path:
 *  - a value containing a path separator must be an existing executable
 *  - otherwise every PATH entry is searched
 * Returns undefined when nothing matches.
 */
export function findExecutable(command: string): string | undefined {
  if (command === '') return undefined;
  if (command.includes('/') || command.includes('\\')) {
    return isExecutableFile(command) ? command : undefined;
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    if (dir === '') continue;
    const candidate = path.join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
    // Windows: PATHEXT is not modeled, but cover the common .exe case.
    if (process.platform === 'win32' && isExecutableFile(`${candidate}.exe`)) {
      return `${candidate}.exe`;
    }
  }
  return undefined;
}
