import test from 'node:test';
import assert from 'node:assert/strict';
import {bindIndicatorLegendSettings} from '../src/indicator-legend-settings.js';

function fixture(){
  const listeners=new Map();
  const mounted=[];
  const configurable={id:'study-a',policy:()=>({configurable:true})};
  const locked={id:'study-b',policy:()=>({configurable:false})};
  const widget={
    context:{testOnly:true},isDestroyed:false,
    chart:{
      on:(event,handler)=>{
        assert.equal(event,'indicatorSettings');
        listeners.set(event,handler);
        return ()=>listeners.delete(event);
      },
      indicators:()=>[configurable,locked],
    },
  };
  const mount=(ctx,anchor,options)=>mounted.push({ctx,anchor,options});
  const emit=value=>listeners.get('indicatorSettings')?.(value);
  return {widget,mounted,mount,emit,listeners};
}

test('canvas legend gear opens the exact native settings dialog for that study',()=>{
  const f=fixture();
  const off=bindIndicatorLegendSettings(f.widget,f.mount);
  f.emit({instanceId:'study-a',indicatorId:'ema',paneIndex:0});
  assert.deepEqual(f.mounted,[{ctx:f.widget.context,anchor:undefined,options:{instanceId:'study-a'}}]);
  off();
  assert.equal(f.listeners.size,0);
  f.emit({instanceId:'study-a'});
  assert.equal(f.mounted.length,1);
});

test('stale, protected, invalid and destroyed studies never open',()=>{
  const f=fixture();
  bindIndicatorLegendSettings(f.widget,f.mount);
  for(const event of [null,{}, {instanceId:''},{instanceId:17},
    {instanceId:'other'}, {instanceId:'study-b'}])f.emit(event);
  assert.equal(f.mounted.length,0);
  f.widget.isDestroyed=true;
  f.emit({instanceId:'study-a'});
  assert.equal(f.mounted.length,0);
});

test('no widget or missing API is a safe no-op',()=>{
  assert.doesNotThrow(()=>bindIndicatorLegendSettings(null,()=>{})());
  assert.doesNotThrow(()=>bindIndicatorLegendSettings({chart:{}},()=>{})());
});
