import {CRYPTO_MARKETS,cryptoDefault} from './crypto-catalog.js';
import {INDIA_INDEX_MARKETS} from './india-index-catalog.js';

// Homepage chart preference stores only public symbol aliases. No account,
// Upstox key, market candle, OAuth token, grant or private chart state.
export const PUBLIC_CHART_SELECTION_KEY='qsyn-public-chart-selection-v1';
export const DEFAULT_PUBLIC_CHART=Object.freeze({
  exchange:cryptoDefault.exchange+':'+cryptoDefault.market,
  symbol:cryptoDefault.symbol,
});
const ALLOWED=new Set([
  ...CRYPTO_MARKETS.map(x=>x.exchange+':'+x.market+':'+x.symbol),
  ...INDIA_INDEX_MARKETS.map(x=>x.id),
]);
export function publicChartSelection(exchange,symbol){
  return typeof exchange==='string' && typeof symbol==='string' &&
    ALLOWED.has(exchange+':'+symbol) ? {exchange,symbol} : null;
}
export function loadPublicChartSelection(storage){
  try{
    const value=JSON.parse(storage?.getItem(PUBLIC_CHART_SELECTION_KEY)||'null');
    if(value?.schema==='QSYN-PUBLIC-CHART-SELECTION/1'){
      const safe=publicChartSelection(value.exchange,value.symbol);
      if(safe)return safe;
    }
  }catch{ /* Blocked browser storage cannot break chart startup. */ }
  return {...DEFAULT_PUBLIC_CHART};
}
export function savePublicChartSelection(storage,exchange,symbol){
  const safe=publicChartSelection(exchange,symbol);
  if(!safe)return false;
  try{
    storage?.setItem(PUBLIC_CHART_SELECTION_KEY,JSON.stringify({
      schema:'QSYN-PUBLIC-CHART-SELECTION/1',...safe,
    }));
    return !!storage;
  }catch{return false;}
}

/** Subscribe to OpenAlgo's actual widget symbol event, never to a feed response:
 * cancelled/stale requests and non-active grid cells must not replace selection.
 * The grid might replace widgets while applying a workspace.
 */
export function observePublicChartSelection(grid,storage){
  let active=true;
  const stops=new Map();
  const record=widget=>{
    if(!active || grid.active()?.widget!==widget)return;
    savePublicChartSelection(storage,widget.exchange(),widget.symbol());
  };
  const sync=()=>{
    if(!active)return;
    const widgets=new Set(grid.cells().map(cell=>cell.widget).filter(Boolean));
    for(const [widget,stop] of stops){
      if(!widgets.has(widget)){stop?.();stops.delete(widget);}
    }
    for(const widget of widgets){
      if(!stops.has(widget))
        stops.set(widget,widget.on('symbol',()=>record(widget)));
    }
    const widget=grid.active()?.widget;
    if(widget)record(widget);
  };
  const offActive=grid.on('active',sync);
  const offLayout=grid.on('layout',sync);
  sync();
  void grid.ready.then(sync).catch(()=>{});
  return ()=>{
    active=false;
    offActive?.();offLayout?.();
    for(const stop of stops.values())stop?.();
    stops.clear();
  };
}
