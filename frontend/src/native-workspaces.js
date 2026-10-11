/**
 * OpenAlgo Charts native workspace stores for PUBLIC, SIMULATED chart widgets.
 *
 * Deliberately isolated from QSYN's older localStorage layout schema,
 * development-only authenticated private files, and account-scoped data.
 * No credentials, orders, positions or broker session state are stored.
 */
import { WorkspaceRepository, createIndexedDbWorkspaceStorage } from 'openalgo-charts/workspace';

const DATABASE = 'qsyn-simulated-openalgo-workspaces-v1';
const PREFIX = 'qsyn-public-simulated-v1-';
const ALLOWED = new Set(['home', 'terminal-primary', 'terminal-secondary']);
let storage = null;
const repositories = new Map();

/**
 * One stable WorkspaceRepository per public widget surface.
 * No fallback to transient memory storage: a Save button must mean durable
 * browser-local persistence, not a layout that disappears on refresh.
 * Browsers with disabled IndexedDB will not show the native Layouts menu.
 */
export function publicNativeWorkspaceStore(scope) {
  if (!ALLOWED.has(scope) || typeof window === 'undefined') return null;
  if (repositories.has(scope)) return repositories.get(scope);
  let db;
  try { db = window.indexedDB; } catch { return null; }
  if (!db) return null;
  try {
    if (!storage) storage = createIndexedDbWorkspaceStorage(db, DATABASE);
    const repository = new WorkspaceRepository(storage, PREFIX + scope);
    repositories.set(scope, repository);
    return repository;
  } catch {
    return null;
  }
}
