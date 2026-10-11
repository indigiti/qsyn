import {WICK_SCIENCE_ID} from './wick-science-core.js';
import {MAX_AUTO_BACKFILL_BARS} from './crypto-feed.js';

const INTERVAL_SECONDS=Object.freeze({'1m':60,'5m':300,'15m':900,'1h':3600,'1d':86400});

/** Required lower-TF candles for the largest loaded Wick Science lookback.
 * A full completed setup series plus 16 bars of alignment/session margin.
 */
export function wickRequiredBars(indicators,interval){
  const step=INTERVAL_SECONDS[interval];
  if(!step)return 0;
  let needed=0;
  for(const indicator of indicators??[]){
    if(indicator?.indicatorId!==WICK_SCIENCE_ID)continue;
    const settings=typeof indicator.settings==='function'?indicator.settings():null;
    const tf=Number(settings?.setupTf??5)*60;
    const samples=Number(settings?.samples??100);
    if(![60,180,300,900].includes(tf)||tf<=step||tf%step!==0 ||
      !Number.isInteger(samples)||samples<20||samples>1000)continue;
    needed=Math.max(needed,Math.ceil(samples*tf/step)+16);
  }
  return Math.min(MAX_AUTO_BACKFILL_BARS,needed);
}
/**
 * Observe native OpenAlgo chart study changes without creating a second
 * indicator selector, custom candle series or order-execution channel.
 */
export function observeWickScienceBackfill(widget,feed){
  if(!widget?.chart?.on ||typeof widget.chart.indicators!=='function')
    return ()=>{};
  let active=true;
  const check=()=>{
    if(!active||widget.isDestroyed)return;
    const interval=widget.interval(),exchange=widget.exchange(),symbol=widget.symbol();
    const bars=wickRequiredBars(widget.chart.indicators(),interval);
    if(!bars || !feed.setHistoryTarget(exchange,symbol,interval,bars))return;
    // Leave event dispatch before reload; OpenAlgo cancels its own old loads.
    Promise.resolve().then(()=>{
      if(active&&!widget.isDestroyed&&widget.interval()===interval&&
          widget.exchange()===exchange&&widget.symbol()===symbol)
        void widget.reload().catch(()=>{});
    });
  };
  const offChange=widget.chart.on('objects:change',check);
  const offRemoved=widget.chart.on('indicatorRemoved',check);
  // Restoring an existing workspace may have created studies before listener setup.
  check();
  return ()=>{active=false;offChange?.();offRemoved?.();};
}
