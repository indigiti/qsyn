/**
 * QSYN's index *discovery* catalog. Symbols are stable UI aliases, NOT
 * broker instrument keys. Resolve live keys against Upstox's current BOD
 * INDEX instrument master after operator/account authorization.
 *
 * No NSE/BSE candles are public and no unlicensed prices are synthesized.
 */
export const INDIA_INDEX_MARKETS = Object.freeze([
  { exchange:'NSE_INDEX', market:'index', symbol:'NIFTY', name:'NIFTY 50', label:'NIFTY 50 · NSE · Authorization required' },
  { exchange:'NSE_INDEX', market:'index', symbol:'BANKNIFTY', name:'BANK NIFTY', label:'BANK NIFTY · NSE · Authorization required' },
  { exchange:'NSE_INDEX', market:'index', symbol:'FINNIFTY', name:'FINNIFTY', label:'FINNIFTY · NSE · Authorization required' },
  { exchange:'NSE_INDEX', market:'index', symbol:'MIDCPNIFTY', name:'MIDCPNIFTY', label:'MIDCPNIFTY · NSE · Authorization required' },
  { exchange:'BSE_INDEX', market:'index', symbol:'SENSEX', name:'SENSEX', label:'SENSEX · BSE · Authorization required' },
  { exchange:'NSE_INDEX', market:'index', symbol:'INDIAVIX', name:'INDIA VIX', label:'INDIA VIX · NSE · Authorization required' },
].map(item=>Object.freeze({
  ...item,
  id:item.exchange+':'+item.market+':'+item.symbol,
})));
export function findIndiaIndex(exchange,symbol) {
  return INDIA_INDEX_MARKETS.find(x=>x.exchange+':'+x.market===exchange&&x.symbol===symbol)||null;
}
export function searchIndiaIndexes(query) {
  const q=String(query??'').trim().toUpperCase().slice(0,48);
  return INDIA_INDEX_MARKETS.filter(x=>!q || x.name.includes(q) || x.symbol.includes(q) ||
    x.exchange.includes(q) || x.label.toUpperCase().includes(q))
    .map(x=>({symbol:x.symbol,exchange:x.exchange+':'+x.market,
      name:x.label,assetClass:'India index · licensed feed required'}));
}
