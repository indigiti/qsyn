/**
 * OpenAlgo Charts 2.6.0 draws an indicator's settings gear on the chart canvas.
 * Pressing it emits "indicatorSettings"; the native Widget wires the Objects
 * panel but does not wire this canvas-legend event to its settings dialog.
 * Bridge only an existing configurable study to the *native* dialog.
 *
 * Does not modify studies, broker permissions or market-data subscriptions.
 */
export function bindIndicatorLegendSettings(widget, mountIndicatorSettings) {
  const chart=widget?.chart;
  if(typeof chart?.on!=='function'||typeof chart?.indicators!=='function'||
     typeof mountIndicatorSettings!=='function')return ()=>{};
  const stop=chart.on('indicatorSettings', event=>{
    if(widget.isDestroyed)return;
    const id=event?.instanceId;
    if(typeof id!=='string'||id.length===0)return;
    const instance=chart.indicators().find(study=>study.id===id);
    if(!instance||instance.policy?.().configurable===false)return;
    mountIndicatorSettings(widget.context,undefined,{instanceId:id});
  });
  return typeof stop==='function'?stop:()=>{};
}
