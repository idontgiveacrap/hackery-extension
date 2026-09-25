/** In-memory catalog snapshot for this JS realm. */
let snapshot = null;
let snapshotPromise = null;

export function invalidateCatalogSnapshot() {
  snapshot = null;
  snapshotPromise = null;
}

export function getCachedCatalogSnapshot() {
  return snapshot;
}

export function getCatalogSnapshotPromise() {
  return snapshotPromise;
}

export function setCatalogSnapshotPromise(promise) {
  snapshotPromise = promise;
}

export function setCachedCatalogSnapshot(next) {
  snapshot = next;
}
