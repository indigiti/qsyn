import test from 'node:test';
import assert from 'node:assert/strict';
import {bindAutoSavedIndicators,INDICATOR_STORAGE_KEY} from '../src/local-indicator-autosave.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function mock(){
  const values=new Map();
  const storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>{values.set(key,value);}};
  const chartEvents=new Map(),widgetEvents=new Map(),gridEvents=new Map();
  const on=(map,event,fn)=>{const set=map.get(event)||new Set();set.add(fn);map.set(event,set);return ()=>set.delete(fn);};
  const emit=(map,event,data={})=>{for(const fn of map.get(event)||[])fn(data);};
  let studies=[];
  let exchange='NSE_INDEX:index',symbol='NIFTY';
  const chart={
    getState:()=>({version:1,indicators:structuredClone(studies)}),
    restoreState:state=>{
      emit(chartEvents,'state:restore:start');
      studies=structuredClone(state.indicators);
      emit(chartEvents,'objects:change');
      emit(chartEvents,'state:restore:end');
      return {applied:true};
    },
    on:(event,fn)=>on(chartEvents,event,fn),
  };
  const widget={chart,isDestroyed:false,exchange:()=>exchange,symbol:()=>symbol,
    on:(event,fn)=>on(widgetEvents,event,fn)};
  const grid={ready:Promise.resolve(),cells:()=>[{widget}],on:(event,fn)=>on(gridEvents,event,fn)};
  return {grid,storage,get studies(){return studies;},setStudies:next=>{
    studies=structuredClone(next);emit(chartEvents,'objects:change');
  },select:(nextSymbol)=>{symbol=nextSymbol;emit(widgetEvents,'symbol');},
    saved:()=>JSON.parse(values.get(INDICATOR_STORAGE_KEY)||'null'),
    restore:()=>emit(chartEvents,'state:restore:start'),
    finishRestore:()=>emit(chartEvents,'state:restore:end'),
    events:chartEvents};
}
const alligator={indicatorId:'williams-alligator',instanceId:'alligator-1',paneIndex:0,
  visible:true,settings:{jaw:13,teeth:8,lips:5,jawColor:'#4488ff'}};

test('reopens indicators and their exact inputs from browser storage',async()=>{
  const f=mock();const stop=bindAutoSavedIndicators(f.grid,f.storage);
  await tick();f.setStudies([alligator]);
  assert.deepEqual(f.saved().profiles[JSON.stringify(['NSE_INDEX:index','NIFTY'])].indicators,[alligator]);
  stop();
  const n=mock();
  n.storage.setItem(INDICATOR_STORAGE_KEY,JSON.stringify(f.saved()));
  const off=bindAutoSavedIndicators(n.grid,n.storage);await tick();
  assert.deepEqual(n.studies,[alligator]);off();
});

test('removal persists empty profile and separate symbols preserve separate studies',async()=>{
  const f=mock(),off=bindAutoSavedIndicators(f.grid,f.storage);await tick();
  f.setStudies([alligator]);f.select('BANKNIFTY');
  f.setStudies([{...alligator,instanceId:'new',settings:{jaw:20}}]);
  f.select('NIFTY');
  assert.deepEqual(f.studies,[alligator]);
  f.setStudies([]);f.select('BANKNIFTY');f.select('NIFTY');
  assert.deepEqual(f.studies,[]);
  off();
});

test('an explicit already-restored workspace takes precedence over autosaved studies',async()=>{
 const f=mock();f.setStudies([{...alligator,instanceId:'native'}]);
 f.storage.setItem(INDICATOR_STORAGE_KEY,JSON.stringify({schema:'QSYN-HOME-INDICATORS/1',profiles:{
 [JSON.stringify(['NSE_INDEX:index','NIFTY'])]:{indicators:[alligator]}}}));
 const off=bindAutoSavedIndicators(f.grid,f.storage);await tick();
 assert.equal(f.studies[0].instanceId,'native');off();
});

test('unavailable storage and invalid records never stop chart initialization',async()=>{
 const f=mock();f.storage.getItem=()=>'{garbled';
 const off=bindAutoSavedIndicators(f.grid,f.storage);await tick();
 f.setStudies([alligator]);off();
 const n=mock();n.storage.setItem=()=>{throw Error('blocked');};
 const off2=bindAutoSavedIndicators(n.grid,n.storage);await tick();
 assert.doesNotThrow(()=>n.setStudies([alligator]));off2();
});

test('asynchronous grid readiness prevents premature restoration and saves',async()=>{
 const f=mock();let resolve;
 f.grid.ready=new Promise(r=>{resolve=r;});
 const off=bindAutoSavedIndicators(f.grid,f.storage);
 f.setStudies([alligator]);
 assert.equal(f.saved(),null);
 resolve();await tick();f.setStudies([]);
 assert.deepEqual(f.saved().profiles[JSON.stringify(['NSE_INDEX:index','NIFTY'])].indicators,[]);
 off();
});
