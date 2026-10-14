import {findIndiaIndex} from './india-index-catalog.js';

/**
 * Recover a displaced initial/current index view only when no real candle
 * intersects the logical viewport. Never force-fit a normal zoomed chart.
 * Price jumps between NSE sessions are authentic and must not be flattened.
 */
export function isIndexViewportEmpty(range,barCount){
  return Number.isSafeInteger(barCount)&&barCount>0&&
    Number.isFinite(range?.from)&&Number.isFinite(range?.to)&&
    (range.to< -0.5 || range.from>barCount-0.5);
}

/**
 * Native OpenAlgo owns the chart and history. Observe accepted load/refresh
 * events only; a user who has panned/zoomed deliberately keeps that view.
 * No polling, extra network history, or direct canvas mutation.
 */
export function observeIndexChartViewport(widget){
  const controller=widget?.dataController,chart=widget?.chart;
  if(!controller||typeof controller.subscribe!=='function'||
    !chart||typeof chart.getVisibleLogicalRange!=='function'||
    typeof chart.resetScale!=='function')return ()=>{};

  let closed=false,scope='',touched=false,queued=false;
  const root=widget.root;
  const markUserMove=()=>{touched=true;};
  for(const name of ['wheel','pointerdown','keydown'])
    root?.addEventListener?.(name,markUserMove,{passive:name==='wheel'});

  const inspect=state=>{
    if(closed||widget.isDestroyed||!state?.request)return;
    const req=state.request,key=req.exchange+':'+req.symbol+':'+req.interval;
    if(key!==scope){scope=key;touched=false;}
    if(touched||!findIndiaIndex(req.exchange,req.symbol)||
      req.exchange!==widget.exchange()||req.symbol!==widget.symbol()||
      req.interval!==widget.interval()||state.status!=='ready'||
      !['load','refresh'].includes(state.reason)||!state.bars?.length||queued)return;
    queued=true;
    // The widget applies its own series state before this queued check.
    queueMicrotask(()=>{
      queued=false;
      if(closed||touched||widget.isDestroyed)return;
      const current=controller.getState();
      if(current.request?.exchange!==req.exchange||
        current.request?.symbol!==req.symbol||
        current.request?.interval!==req.interval)return;
      const count=chart.primaryBars?.().length||current.bars?.length||0;
      if(isIndexViewportEmpty(chart.getVisibleLogicalRange(),count))
        chart.resetScale();
    });
  };
  const off=controller.subscribe(inspect);
  inspect(controller.getState());
  return ()=>{
    closed=true;off?.();
    for(const name of ['wheel','pointerdown','keydown'])
      root?.removeEventListener?.(name,markUserMove);
  };
}
