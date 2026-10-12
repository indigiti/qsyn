import assert from 'node:assert/strict';
import {PUBLIC_CHART_SELECTION_KEY,DEFAULT_PUBLIC_CHART,publicChartSelection,
  loadPublicChartSelection,savePublicChartSelection,observePublicChartSelection
} from '../src/public-chart-selection.js';
const map=new Map();
const storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};
assert.deepEqual(loadPublicChartSelection(storage),DEFAULT_PUBLIC_CHART);
for(const [exchange,symbol] of [['NSE_INDEX:index','NIFTY'],['BSE_INDEX:index','SENSEX'],
  ['BINANCE:spot','BTCUSDT']]){
  assert(savePublicChartSelection(storage,exchange,symbol));
  assert.deepEqual(loadPublicChartSelection(storage),{exchange,symbol});
}
assert.equal(savePublicChartSelection(storage,'NSE_INDEX:index','INVALID'),false);
assert.equal(savePublicChartSelection(storage,'UPSTOX_PRIVATE','NIFTY'),false);
assert.equal(publicChartSelection('BSE_INDEX:index','NIFTY'),null);
map.set(PUBLIC_CHART_SELECTION_KEY,JSON.stringify({schema:'QSYN-PUBLIC-CHART-SELECTION/1',
  exchange:'UPSTOX_PRIVATE',symbol:'SENSEX',token:'secret'}));
assert.deepEqual(loadPublicChartSelection(storage),DEFAULT_PUBLIC_CHART);
const listeners=new Map();
function widget(exchange,symbol){
  const events=new Map();
  return {exchange:()=>exchange,symbol:()=>symbol,
    on:(event,cb)=>{events.set(event,cb);return ()=>events.delete(event);},
    change:(ex,sym)=>{exchange=ex;symbol=sym;events.get('symbol')?.({exchange,symbol});},
    listening:()=>events.size};
}
const one=widget('NSE_INDEX:index','NIFTY');
const two=widget('BSE_INDEX:index','SENSEX');
let active=one;
const handlers=new Map();
const grid={
  cells:()=>[{widget:one},{widget:two}],
  active:()=>({widget:active}),
  on:(name,cb)=>{handlers.set(name,cb);return()=>handlers.delete(name);},
  ready:Promise.resolve(),
};
const stop=observePublicChartSelection(grid,storage);
assert.equal(loadPublicChartSelection(storage).symbol,'NIFTY');
two.change('BINANCE:spot','BTCUSDT');
assert.equal(loadPublicChartSelection(storage).symbol,'NIFTY','inactive chart must not overwrite');
active=two;handlers.get('active')();
assert.equal(loadPublicChartSelection(storage).symbol,'BTCUSDT');
two.change('BSE_INDEX:index','SENSEX');
assert.equal(loadPublicChartSelection(storage).symbol,'SENSEX');
stop();
assert.equal(one.listening(),0);
assert.equal(two.listening(),0);
console.log('PASS: homepage chart selection survives reload and ignores inactive/invalid instruments');
