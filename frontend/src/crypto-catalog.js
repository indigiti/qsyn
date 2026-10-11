/** Explicit public market-data catalog; symbol+exchange+market identifies an instrument. */
export const CRYPTO_MARKETS = Object.freeze([
  ...['BINANCE','BYBIT','BITGET'].flatMap(exchange =>
    ['BTCUSDT','ETHUSDT','SOLUSDT'].flatMap(symbol =>
      ['spot','perp'].map(market => ({exchange,symbol,market,id:exchange+':'+market+':'+symbol,label:exchange+' · '+market.toUpperCase()+' · '+symbol})))),
  ...['BTC','ETH','SOL'].flatMap(asset => [
    {exchange:'OKX',market:'spot',symbol:asset+'-USDT',id:'OKX:spot:'+asset+'-USDT',label:'OKX · SPOT · '+asset+'-USDT'},
    {exchange:'OKX',market:'perp',symbol:asset+'-USDT-SWAP',id:'OKX:perp:'+asset+'-USDT-SWAP',label:'OKX · PERP · '+asset+'-USDT-SWAP'},
    {exchange:'COINBASE',market:'spot',symbol:asset+'-USD',id:'COINBASE:spot:'+asset+'-USD',label:'Coinbase · SPOT · '+asset+'-USD'},
    {exchange:'KRAKEN',market:'spot',symbol:(asset==='BTC'?'XBT':asset)+'USD',id:'KRAKEN:spot:'+(asset==='BTC'?'XBT':asset)+'USD',label:'Kraken · SPOT · '+asset+'USD'},
    {exchange:'HYPERLIQUID',market:'perp',symbol:asset,id:'HYPERLIQUID:perp:'+asset,label:'Hyperliquid · PERP · '+asset},
  ]),
]);
export const findCrypto = (exchange,symbol) => CRYPTO_MARKETS.find(x=>x.id===exchange+':'+symbol) || null;
export const cryptoDefault = CRYPTO_MARKETS[0];
