import {findIndiaIndex} from './india-index-catalog.js';
const STORAGE_KEY='qsyn-public-index-intent-v1';

/** A public instrument alias is safe to carry across the administrator login.
 * No Upstox key, token, account identifier, ticket or chart data is saved.
 */
export function indexIntentFor(exchange,symbol) {
  const match=findIndiaIndex(exchange+':index',symbol);
  return match ? Object.freeze({exchange:match.exchange,symbol:match.symbol,
    id:match.id,name:match.name}) : null;
}
export function saveIndexIntent(index,storage=globalThis.sessionStorage) {
  const canonical=indexIntentFor(index?.exchange,index?.symbol);
  if(!canonical)return false;
  try {storage.setItem(STORAGE_KEY,canonical.id);return true;}catch{return false;}
}
export function consumeIndexIntent(storage=globalThis.sessionStorage){
  try{
    const id=storage.getItem(STORAGE_KEY);
    storage.removeItem(STORAGE_KEY);
    if(typeof id!=='string'||id.length>80)return null;
    const chunks=id.split(':');
    if(chunks.length!==3||chunks[1]!=='index')return null;
    return indexIntentFor(chunks[0],chunks[2]);
  }catch{return null;}
}
export function privateIndexTarget(index){
  return indexIntentFor(index?.exchange,index?.symbol)
    ? '/qsyn/terminal/markets' : null;
}
