/**
 * Carrying stored data across a rename.
 *
 * The product was called something else once, and its storage keys still were.
 * Renaming them is only allowed to be tidiness if nothing is lost doing it, so
 * the move lives here: pure, given a storage area rather than reaching for
 * `chrome.*`, and therefore testable without a browser. Losing every rule
 * somebody wrote is not a thing to find out about from a bug report.
 */

/** The slice of `chrome.storage.StorageArea` a migration needs. */
export interface StorageArea {
  get: (keys: string[]) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (keys: string[]) => Promise<void>;
}

export interface KeyRename {
  from: string;
  to: string;
}

export interface MigrationReport {
  /** Keys whose value was carried over to the new name. */
  moved: string[];
  /**
   * Keys that existed under both names. The newer one is kept and the old one
   * dropped -- a profile that has run both names must never have its current
   * rules replaced by an older copy of them.
   */
  skipped: string[];
}

/**
 * Moves each `from` key to its `to` key, then removes the old one.
 *
 * Idempotent: running it again finds nothing to do. Safe to run concurrently
 * with nothing else, which is why the caller gates every read on it rather
 * than racing it.
 */
export async function migrateStorageKeys(
  area: StorageArea,
  renames: readonly KeyRename[],
): Promise<MigrationReport> {
  const report: MigrationReport = { moved: [], skipped: [] };
  if (renames.length === 0) return report;

  const stored = await area.get(renames.map((rename) => rename.from));
  const present = renames.filter((rename) => stored[rename.from] !== undefined);
  if (present.length === 0) return report;

  const targets = await area.get(present.map((rename) => rename.to));
  const writes: Record<string, unknown> = {};
  for (const rename of present) {
    if (targets[rename.to] === undefined) {
      writes[rename.to] = stored[rename.from];
      report.moved.push(rename.from);
    } else {
      report.skipped.push(rename.from);
    }
  }

  if (Object.keys(writes).length > 0) await area.set(writes);
  // Removed either way: a key that was skipped has already been superseded, and
  // leaving it behind means doing this dance on every single startup.
  await area.remove(present.map((rename) => rename.from));
  return report;
}
