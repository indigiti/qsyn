import { WatchlistRepository, createIndexedDbWatchlistStorage } from 'openalgo-charts/workspace';
let store=null;
export function nativeCryptoWatchlists() {
  if(store)return store;
  try {
    if(typeof indexedDB==='undefined')return null;
    store=new WatchlistRepository(createIndexedDbWatchlistStorage(indexedDB),'qsyn-public-crypto-watchlists-v1');
    store.load().then(catalog=>{
      if(!catalog.lists.length) return store.createList('Crypto markets',[
        {symbol:'BTCUSDT',exchange:'BINANCE:spot'},
        {symbol:'ETHUSDT',exchange:'BINANCE:spot'},
        {symbol:'BTC',exchange:'HYPERLIQUID:perp'},
      ]).then(list=>store.setActiveList(list.id));
    }).catch(()=>{ /* unusable browser persistence remains visible as unavailable */ });
    return store;
  } catch {return null;}
}
// No real trade/quote subscription yet: do not mislabel an OHLC close as last traded price.
export const noSyntheticQuotes = {getQuotes: async()=>[]};
