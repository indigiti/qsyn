/**
 * OpenAlgo Charts native workspace stores for PUBLIC, SIMULATED chart widgets.
 *
 * Deliberately isolated from QSYN's older localStorage layout schema,
 * development-only authenticated private files, and account-scoped data.
 * No credentials, orders, positions or broker session state are stored.
 */
import { WorkspaceRepository, createIndexedDbWorkspaceStorage } from 'openalgo-charts/workspace';

const DATABASE = 'qsyn-simulated-openalgo-workspaces-v1';
const NAMESPACE = 'qsyn-public-simulated-v1-charts';
let storage = null;
let repository = null;

/**
 * One stable WorkspaceRepository shared by public simulated charts.
 * No fallback to transient memory storage: a Save button must mean durable
 * browser-local persistence, not a layout that disappears on refresh.
 * Browsers with disabled IndexedDB will not show the native Layouts menu.
 */
export function publicNativeWorkspaceStore() {
  if (typeof window === 'undefined') return null;
  if (repository) return repository;
  let db;
  try { db = window.indexedDB; } catch { return null; }
  if (!db) return null;
  try {
    if (!storage) storage = createIndexedDbWorkspaceStorage(db, DATABASE);
    repository = new WorkspaceRepository(storage, NAMESPACE);
    return repository;
  } catch {
    return null;
  }
}
