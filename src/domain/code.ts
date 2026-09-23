import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Code fingerprinting for stale detection (product doc §8.1).
 *
 * We hash file contents rather than trusting a commit sha, because uncommitted
 * worktree changes are common while Cloonex is being used mid-task. A commit
 * alone would describe a state the user may not actually be editing.
 */
export function fingerprintFile(absolutePath: string): string | null {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return null;
    const hash = createHash('sha256');
    hash.update(fs.readFileSync(absolutePath));
    return `sha256:${hash.digest('hex').slice(0, 32)}`;
  } catch {
    return null;
  }
}

export function fingerprintText(text: string): string {
  const hash = createHash('sha256');
  hash.update(text);
  return `sha256:${hash.digest('hex').slice(0, 32)}`;
}

/** Resolves a project-relative path, refusing to escape the project root. */
export function resolveInsideProject(rootPath: string, relativePath: string): string | null {
  const root = path.resolve(rootPath);
  const target = path.resolve(root, relativePath);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

/** Best-effort git metadata. Cloonex works fine in non-git directories. */
export function gitHead(rootPath: string): string | null {
  try {
    const head = fs.readFileSync(path.join(rootPath, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refFile = path.join(rootPath, '.git', head.slice(5).trim());
      if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf8').trim();
      const packed = path.join(rootPath, '.git', 'packed-refs');
      if (fs.existsSync(packed)) {
        const ref = head.slice(5).trim();
        for (const line of fs.readFileSync(packed, 'utf8').split('\n')) {
          const [sha, name] = line.trim().split(/\s+/);
          if (name === ref && sha) return sha;
        }
      }
      return null;
    }
    return head;
  } catch {
    return null;
  }
}
