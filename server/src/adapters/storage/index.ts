import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env.js';

export interface StorageAdapter {
  /** Save a file already on disk (e.g., from multer disk storage) into permanent storage. Returns the relative path. */
  saveFromPath(srcPath: string, destRelative: string): Promise<string>;
  /** Resolve a relative path to an absolute one for reads. */
  resolve(relative: string): string;
  /** Delete a stored file. */
  remove(relative: string): Promise<void>;
}

// Assert that a resolved absolute path lies inside the storage root. Rejects
// any relative path with `..` or absolute path escapes. Called on every
// saveFromPath / resolve / remove so a malicious `MediaFile.path` row can
// never point outside MEDIA_DIR.
function assertUnderRoot(root: string, absPath: string): void {
  const normalizedRoot = path.resolve(root) + path.sep;
  const normalized = path.resolve(absPath);
  if (normalized !== path.resolve(root) && !normalized.startsWith(normalizedRoot)) {
    throw Object.assign(new Error('invalid_path'), { status: 422 });
  }
}

class LocalStorage implements StorageAdapter {
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }
  async saveFromPath(srcPath: string, destRelative: string): Promise<string> {
    const dest = path.join(this.root, destRelative);
    assertUnderRoot(this.root, dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(srcPath, dest);
    return destRelative;
  }
  resolve(relative: string): string {
    const abs = path.join(this.root, relative);
    assertUnderRoot(this.root, abs);
    return abs;
  }
  async remove(relative: string): Promise<void> {
    const abs = path.join(this.root, relative);
    assertUnderRoot(this.root, abs);
    try { fs.unlinkSync(abs); } catch {}
  }
}

// S3 stub — to implement when needed without touching callers.
// class S3Storage implements StorageAdapter { ... }

export const storage: StorageAdapter = new LocalStorage(env.MEDIA_DIR);
