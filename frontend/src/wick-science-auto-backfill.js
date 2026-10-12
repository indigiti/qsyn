import {WICK_SCIENCE_ID} from './wick-science-core.js';
import {INITIAL_BACKFILL_BARS,MAX_AUTO_BACKFILL_BARS} from './crypto-feed.js';

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
 * Observe native OpenAlgo study and history events. The native widget.reload()
 * is intentionally NOT used here: for an unchanged symbol/interval it calls
 * DataLoadingController.refresh(), which is a 300-bar tail repair with noCache,
 * not a historical reload. Load the expanded provider-backed date window using
 * the public DataLoadingController.load(request) API instead.
 */
export function observeWickScienceBackfill(widget,feed){
  const controller=widget?.dataController;
  if(!widget?.chart?.on ||typeof widget.chart.indicators!=='function'||
    !controller ||typeof controller.load!=='function'||
    typeof controller.getState!=='function'||typeof controller.subscribe!=='function')
    return ()=>{};

  let active=true,sourceKey='',attempted=0;
  let indexPaging=false,indexPages=0;
  const check=()=>{
    if(!active||widget.isDestroyed)return;
    const interval=widget.interval(),exchange=widget.exchange(),symbol=widget.symbol();
    const step=INTERVAL_SECONDS[interval];
    const key=exchange+':'+symbol+':'+interval;
    if(key!==sourceKey){sourceKey=key;attempted=0;indexPages=0;}
    const required=wickRequiredBars(widget.chart.indicators(),interval);
    if(!step||!required)return;
    const privateIndex=(exchange==='NSE_INDEX:index'||exchange==='BSE_INDEX:index');
    // Public crypto loads 1600+ candles by default. Indian indices start
    // with one 375-minute session; request *older pages* via native
    // loadMore(), not load(), which would just fetch the same single day.
    if(!privateIndex&&required<=INITIAL_BACKFILL_BARS)return;
    const state=controller.getState();
    const previous=state?.request;
    // Never cancel an ongoing native initial load, nor load an obsolete symbol
    // while OpenAlgo is changing or restoring a workspace.
    if(state?.status!=='ready'||previous?.symbol!==symbol||
      previous.exchange!==exchange||previous.interval!==interval)return;
    const bars=typeof controller.bars==='function'?controller.bars():state.bars;
    if((bars?.length||0)>=required)return;
    if(privateIndex){
      if(indexPaging || state.hasMore===false || indexPages>=12 ||
        typeof controller.loadMore!=='function')return;
      indexPaging=true;
      indexPages++;
      const count=bars?.length||0;
      void controller.loadMore().then(rows=>{
        indexPaging=false;
        if(active&&!widget.isDestroyed&&(rows?.length||0)>count)check();
      }).catch(()=>{indexPaging=false;});
      return;
    }
    if(required<=attempted)return;
    attempted=required;
    feed.setHistoryTarget(exchange,symbol,interval,required);
    const now=Math.floor(Date.now()/1000);
    const from=now-(required+2)*step;
    const request={
      ...previous,
      symbol,exchange,interval,
      from:Math.min(Number.isFinite(previous.from)?previous.from:from,from),
      to:Math.max(Number.isFinite(previous.to)?previous.to:now,now),
      countBack:required,
      noCache:false,
    };
    // Load emits a synchronous 'loading' event; mark the attempt first to
    // prevent a recursive duplicate request from controller subscriptions.
    void controller.load(request).catch(()=>{});
  };
  const offChange=widget.chart.on('objects:change',check);
  const offRemoved=widget.chart.on('indicatorRemoved',check);
  const offData=controller.subscribe(check);
  // Restored studies may exist before event listeners attach. If the chart
  // is still loading, its completion event causes another check.
  check();
  return ()=>{active=false;offChange?.();offRemoved?.();offData?.();};
}
