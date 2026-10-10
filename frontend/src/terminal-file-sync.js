/**
 * Development-only remote workspace adapter. No browser-held credentials,
 * customer identity, broker account selection or provider API usage.
 */
import { normalizeWorkspace, STORAGE_SCHEMA } from './terminal-workspace.js';

const ENDPOINT = '/qsyn/api/v1/terminal/workspace';

function exactWorkspace(value) {
  if (!value || value.schema !== STORAGE_SCHEMA || !Array.isArray(value.watchlist) ||
      !Array.isArray(value.layouts)) {
    throw new Error('Invalid private workspace response.');
  }
  return normalizeWorkspace(value);
}
export async function checkPrivateWorkspace(fetcher = fetch, signal) {
  let response;
  try {
    response = await fetcher(ENDPOINT, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json' }, signal,
    });
  } catch {
    return { status: 'offline' };
  }
  if (response.status === 401) return { status: 'login_required' };
  if (response.status === 403 || response.status === 503 || response.status === 404) {
    return { status: 'disabled' };
  }
  if (!response.ok) return { status: 'offline' };
  try {
    const json = await response.json();
    if (json.mode !== 'simulated' || json.storage !== 'private_file_development_only' ||
        !Number.isSafeInteger(json.revision) || json.revision < 0 ||
        !/^[a-f0-9]{64}$/.test(json.csrf) ||
        typeof json.can_write !== 'boolean') throw new Error('Untrusted workspace response.');
    return {
      status: 'ready', revision: json.revision, csrf: json.csrf,
      canWrite: json.can_write, workspace: exactWorkspace(json.workspace),
    };
  } catch {
    return { status: 'offline' };
  }
}
export async function savePrivateWorkspace(fetcher, privateState, workspace) {
  if (!privateState || privateState.status !== 'ready' ||
      !privateState.canWrite || !Number.isInteger(privateState.revision)) {
    throw new Error('Private workspace write is not authorized.');
  }
  const canonical = exactWorkspace(workspace);
  // Never transmit a tenant, user ID, brokerage account or authority claim.
  const response = await fetcher(ENDPOINT, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: {
      'Content-Type': 'application/json', 'Accept': 'application/json',
      'X-CSRF-Token': privateState.csrf,
    },
    body: JSON.stringify({ expected_revision: privateState.revision, workspace: canonical }),
  });
  if (response.status === 409) throw new Error('Private workspace changed in another tab. Reload private state before saving.');
  if (response.status === 401 || response.status === 403) {
    throw new Error('Private session expired or write access is not permitted.');
  }
  if (!response.ok) throw new Error('Private file save failed. Browser layout was not changed.');
  const json = await response.json();
  if (json.mode !== 'simulated' || json.storage !== 'private_file_development_only' ||
      json.revision !== privateState.revision + 1) {
    throw new Error('Invalid private workspace save acknowledgment.');
  }
  const verified = exactWorkspace(json.workspace);
  return { ...privateState, revision: json.revision, workspace: verified };
}
