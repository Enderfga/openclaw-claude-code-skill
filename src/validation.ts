/**
 * Shared validation utilities for input sanitization.
 *
 * Used by both the plugin tool handlers (index.ts) and the embedded HTTP
 * server (embedded-server.ts) to ensure consistent protection regardless
 * of entry point.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// ─── Blocked Path Prefixes ─────────────────────────────────────────────────

/** System-critical directories that must never be used as a working directory */
const BLOCKED_PREFIXES = ['/etc', '/proc', '/sys', '/var/run', '/var/log', '/boot', '/sbin'];

/** Sensitive directories under the user's home that must never be used as cwd */
const BLOCKED_HOME_SUBDIRS = ['.ssh', '.gnupg', '.aws', '.config/gcloud'];

// ─── sanitizeCwd ────────────────────────────────────────────────────────────

/**
 * Resolve and validate a working directory path.
 *
 * Prevents path traversal and blocks access to system-critical and
 * sensitive directories. Resolves symlinks where possible to defeat
 * symlink-based bypasses.
 */
export function sanitizeCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;

  // Logical path: resolves .. and . but does NOT follow symlinks.
  // This catches the obvious cases (/etc, /var/run, /sbin) on all platforms.
  const logical = path.resolve(cwd);

  // Real path: follows symlinks. This catches symlink-based bypasses
  // (e.g. /tmp/safe → /etc). Falls back to logical for non-existent paths.
  let real: string;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    real = logical;
  }

  // Collect all paths to check — logical, real, and their de-prefixed
  // variants for macOS where /etc → /private/etc, /var → /private/var.
  const pathsToCheck = new Set([logical, real]);
  for (const p of [logical, real]) {
    if (p.startsWith('/private/')) {
      pathsToCheck.add(p.slice('/private'.length));
    }
  }

  // Block filesystem root
  for (const check of pathsToCheck) {
    if (check === '/') {
      throw new Error(`Unsafe working directory: ${logical}`);
    }
  }

  // Block system-critical prefixes
  for (const check of pathsToCheck) {
    for (const prefix of BLOCKED_PREFIXES) {
      if (check === prefix || check.startsWith(prefix + '/')) {
        throw new Error(`Unsafe working directory: ${logical}`);
      }
    }
  }

  // Block sensitive home subdirectories
  const home = os.homedir();
  for (const check of pathsToCheck) {
    for (const subdir of BLOCKED_HOME_SUBDIRS) {
      const sensitive = path.join(home, subdir);
      if (check === sensitive || check.startsWith(sensitive + '/')) {
        throw new Error(`Unsafe working directory: ${logical}`);
      }
    }
  }

  return real;
}

// ─── validateRegex ──────────────────────────────────────────────────────────

/**
 * Validate that a string is a syntactically valid regular expression.
 *
 * Returns the compiled RegExp if valid, throws on invalid syntax.
 * Note: this validates syntax only — it does not detect catastrophic
 * backtracking (ReDoS) patterns.
 */
export function validateRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${(err as Error).message}`);
  }
}

// ─── validateName ───────────────────────────────────────────────────────────

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a resource name (agent, skill, rule) to prevent path injection.
 *
 * Only allows alphanumeric characters, hyphens, and underscores.
 * Rejects empty strings, dots, slashes, spaces, and any other characters
 * that could be used for path traversal.
 */
export function validateName(name: string): string {
  if (!name || !VALID_NAME.test(name)) {
    throw new Error(`Invalid name '${name}': must be non-empty and match /^[a-zA-Z0-9_-]+$/`);
  }
  return name;
}
