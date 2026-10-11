import { WatchlistRepository, createIndexedDbWatchlistStorage } from 'openalgo-charts/workspace';
let store=null;
export function nativeCryptoWatchlists() {
  if(store)return store;
  try {
    if(typeof indexedDB==='undefined')return null;
    store=new WatchlistRepository(createIndexedDbWatchlistStorage(indexedDB),'qsyn-public-crypto-watchlists-v1');
    store.load().then(async catalog=>{
      // Preserve existing user lists, crypto default and active selection.
      if(!catalog.lists.length) {
        const first=await store.createList('Crypto markets',[
          {symbol:'BTCUSDT',exchange:'BINANCE:spot'},
          {symbol:'ETHUSDT',exchange:'BINANCE:spot'},
          {symbol:'BTC',exchange:'HYPERLIQUID:perp'},
        ]);
        await store.setActiveList(first.id);
      }
      // Index symbols are metadata only until account-scoped Upstox data
      // and licensed display rights are explicitly configured.
      if(!catalog.lists.some(x=>x.name==='India indexes (licensed)')) {
        await store.createList('India indexes (licensed)',[
          {symbol:'NIFTY',exchange:'NSE_INDEX:index'},
          {symbol:'BANKNIFTY',exchange:'NSE_INDEX:index'},
          {symbol:'FINNIFTY',exchange:'NSE_INDEX:index'},
          {symbol:'MIDCPNIFTY',exchange:'NSE_INDEX:index'},
          {symbol:'SENSEX',exchange:'BSE_INDEX:index'},
          {symbol:'INDIAVIX',exchange:'NSE_INDEX:index'},
        ]);
      }
    }).catch(()=>{ /* unusable browser persistence remains visible as unavailable */ });
    return store;
  } catch {return null;}
}
// No real trade/quote subscription yet: do not mislabel an OHLC close as last traded price.
export const noSyntheticQuotes = {getQuotes: async()=>[]};
