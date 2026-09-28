// Keeps a running analysis alive across what browsers do to pages that are off screen: phones pause
// them (app switched, screen locked) and sometimes reload them later. After every round the state is
// saved in IndexedDB, so the analysis continues exactly there instead of starting over.

const DB_NAME = "ortfinder";
const STORE = "runs";
const KEY = "current";
export const RESUME_MAX_AGE_MS = 6 * 3600 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Save the running analysis. Never throws: saving must not break the analysis itself. */
export async function saveRun(record) {
  try {
    await withStore("readwrite", (s) => s.put({ ...record, savedAt: Date.now() }, KEY));
    return true;
  } catch {
    return false; // private mode, storage full or blocked
  }
}

/** The interrupted analysis, if there is a recent one. */
export async function loadRun() {
  try {
    const rec = await withStore("readonly", (s) => s.get(KEY));
    return rec && Date.now() - rec.savedAt < RESUME_MAX_AGE_MS ? rec : null;
  } catch {
    return null;
  }
}

export async function clearRun() {
  try {
    await withStore("readwrite", (s) => s.delete(KEY));
  } catch {
    // nothing stored
  }
}

/**
 * Resolves once the page is visible again. Returns true if it had to wait, i.e. the page was in the
 * background, where a dropped request is the browser's doing and worth retrying without counting.
 */
export async function waitWhileHidden(doc = globalThis.document) {
  if (!doc || doc.visibilityState !== "hidden") return false;
  await new Promise((resolve) => {
    const onChange = () => {
      if (doc.visibilityState === "hidden") return;
      doc.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    doc.addEventListener("visibilitychange", onChange);
  });
  return true;
}
