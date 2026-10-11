/**
 * QSYN terminal location registry.
 * The source manifest is also read by PHP for HTTP route resolution, so
 * browser SPA navigation, direct entry and 302 aliases cannot diverge.
 * Access annotations are UI labels only, never authorization decisions.
 */
import registry from '../../apps/web-php/public/terminal-routes.json' with { type: 'json' };

if (registry.schema !== 'QSYN-TERMINAL-ROUTES/1' ||
    registry.base !== '/qsyn/terminal' ||
    !registry.routes.some(item=>item.view === registry.defaultView)) {
  throw Error('QSYN terminal route registry unavailable');
}

const names=new Set(registry.routes.map(item=>item.view));
const bySlug=new Map(registry.routes.map(item=>[item.slug,item.view]));
const urls=new Map(registry.routes.map(item=>[item.view,registry.base+'/'+item.slug]));

export const terminalRoutes=Object.freeze(registry.routes.map(x=>Object.freeze({...x,
  href:urls.get(x.view)})));
export const terminalAliases=Object.freeze(registry.aliases.map(x=>Object.freeze({...x,
  href:urls.get(x.view)})));
export const defaultTerminalView=registry.defaultView;

export function terminalHref(view) {
  return urls.get(view)??null;
}

export function terminalViewForLocation(pathname, search='') {
  const path=pathname.endsWith('/') && pathname!==registry.base+'/'
    ? pathname.slice(0,-1) : pathname;
  if(path===registry.base || path===registry.base+'/'){
    // Old ?view= bookmarks are still understood if HTML is served by a cache.
    const v=new URLSearchParams(search).get('view');
    return names.has(v)?v:registry.defaultView;
  }
  if(!path.startsWith(registry.base+'/'))return null;
  const slug=path.slice(registry.base.length+1);
  return bySlug.get(slug)??null;
}
export function legacyTerminalTarget(pathname) {
  const path=pathname.length>1&&pathname.endsWith('/')?pathname.slice(0,-1):pathname;
  const item=registry.aliases.find(a=>a.path===path);
  return item?terminalHref(item.view):null;
}
