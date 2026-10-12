/**
 * QSYN's index *discovery* catalog. Symbols are stable UI aliases, NOT
 * broker instrument keys. The account-private Upstox Analytics Token path
 * resolves fixed aliases through QSYN Rust; this catalog never grants access.
 *
 * No NSE/BSE candles are public and no unlicensed prices are synthesized.
 */
export const INDIA_INDEX_MARKETS = Object.freeze([
  { exchange:'NSE_INDEX', market:'index', symbol:'NIFTY', name:'NIFTY 50', label:'NIFTY 50 · NSE' },
  { exchange:'NSE_INDEX', market:'index', symbol:'BANKNIFTY', name:'BANK NIFTY', label:'BANK NIFTY · NSE' },
  { exchange:'NSE_INDEX', market:'index', symbol:'FINNIFTY', name:'FINNIFTY', label:'FINNIFTY · NSE' },
  { exchange:'NSE_INDEX', market:'index', symbol:'MIDCPNIFTY', name:'MIDCPNIFTY', label:'MIDCPNIFTY · NSE' },
  { exchange:'BSE_INDEX', market:'index', symbol:'SENSEX', name:'SENSEX', label:'SENSEX · BSE' },
  { exchange:'BSE_INDEX', market:'index', symbol:'BANKEX', name:'S&P BSE BANKEX', label:'S&P BSE BANKEX · BSE' },
  { exchange:'NSE_INDEX', market:'index', symbol:'INDIAVIX', name:'INDIA VIX', label:'INDIA VIX · NSE' },
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
      name:x.label,assetClass:'Indian index · private account data'}));
}
