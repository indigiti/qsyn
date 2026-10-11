import assert from 'node:assert/strict';
import {isExpectedChartAbort,observeChartCancellations} from '../src/chart-cancellation.js';

assert.equal(isExpectedChartAbort({name:'AbortError',
  message:'signal is aborted without reason'}),true);
assert.equal(isExpectedChartAbort({name:'AbortError',
  message:'The user aborted a request.'}),true);
assert.equal(isExpectedChartAbort({name:'AbortError',
  message:'This operation was aborted'}),true);
assert.equal(isExpectedChartAbort({name:'AbortError',
  message:'Unexpected and suspicious error'}),false);
assert.equal(isExpectedChartAbort({name:'TypeError',
  message:'signal is aborted without reason'}),false);
assert.equal(isExpectedChartAbort({name:'SecurityError',message:'CSP blocked'}),false);
assert.equal(isExpectedChartAbort(null),false);

const listeners=new Map();
const target={
  addEventListener:(key,fn)=>listeners.set(key,fn),
  removeEventListener:(key,fn)=>{
    assert.equal(listeners.get(key),fn);listeners.delete(key);
  },
};
const cleanup=observeChartCancellations(target);
let swallowed=0;
listeners.get('unhandledrejection')({
  reason:{name:'AbortError',message:'The user aborted a request.'},
  preventDefault:()=>swallowed++,
});
listeners.get('unhandledrejection')({
  reason:{name:'TypeError',message:'Unhandled application exception'},
  preventDefault:()=>swallowed++,
});
assert.equal(swallowed,1,'real application exceptions must not be silenced');
cleanup();
assert.equal(listeners.size,0,'abort listener cleaned up with grid lifecycle');
console.log('PASS chart cancellation observer handles only known AbortError rejections');
