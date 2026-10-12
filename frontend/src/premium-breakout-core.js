/**
 * QSYN research-only option premium replay. All market inputs are user-supplied
 * one-minute CSV candles. No server transfers, broker accounts, orders or live feed.
 */
export const PREMIUM_PRESET = Object.freeze({
  mode: 'MANUAL', buyAbove: 402, buyStop: 386,
  shortBelow: 386, shortStop: 402, autoBuffer: 8,
  directions: 'BOTH', partialR: 3.5,
  volumeMultiplier: 1.5, volumeLookback: 5, useVolume: false, useOi: false,
  trendMode: 'OFF',
});

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit',
  hour:'2-digit', minute:'2-digit', hourCycle:'h23',
});
function ist(time) {
  const parts=Object.fromEntries(dateFmt.formatToParts(new Date(time)).map(p=>[p.type,p.value]));
  return {day:parts.year+'-'+parts.month+'-'+parts.day,
    minute:Number(parts.hour)*60+Number(parts.minute)};
}
const round2 = x=>Math.round((x+Number.EPSILON)*100)/100;
const positive = v=>typeof v==='number'&&Number.isFinite(v)&&v>0;

export function validatePremiumRules(raw={}) {
  const v={...PREMIUM_PRESET,...raw};
  for(const key of ['buyAbove','buyStop','shortBelow','shortStop','partialR',
    'volumeMultiplier','autoBuffer']) {
    if(!positive(v[key]))throw Error('Invalid positive parameter: '+key);
  }
  if(v.buyStop>=v.buyAbove||v.shortStop<=v.shortBelow)
    throw Error('Long stop must be below its trigger; short stop above its trigger.');
  if(v.partialR>20||v.autoBuffer>1000||v.volumeMultiplier>20||
    !Number.isInteger(v.volumeLookback)||v.volumeLookback<2||v.volumeLookback>100)
    throw Error('Strategy parameters outside research limits.');
  if(!['MANUAL','PREVIOUS_LOW','PREVIOUS_RANGE'].includes(v.mode)||
    !['LONG','SHORT','BOTH'].includes(v.directions)||
    !['OFF','EMA21','EMA21_90'].includes(v.trendMode)||
    typeof v.useVolume!=='boolean'||typeof v.useOi!=='boolean')
    throw Error('Unsupported research setting.');
  return v;
}

/** CSV schema: time,open,high,low,close,volume[,oi].
 * Timestamps MUST contain an explicit timezone offset or Z.
 * Contiguous bars required within each session; weekend/overnight gaps allowed.
 */
export function parsePremiumCsv(text) {
  if(typeof text!=='string'||!text.trim()||text.length>2_000_000)
    throw Error('Missing CSV or size exceeds 2 MB.');
  const lines=text.trim().split(/\r?\n/);
  if(lines.length<3||lines.length>10002)throw Error('CSV requires 2–10,000 candles.');
  const keys=lines.shift().replace(/^\uFEFF/,'').toLowerCase().split(',').map(x=>x.trim());
  const required=['time','open','high','low','close','volume'];
  if(!required.every(k=>keys.includes(k))||keys.some(k=>![...required,'oi'].includes(k))||
    new Set(keys).size!==keys.length)
    throw Error('Expected time,open,high,low,close,volume with optional oi.');
  const idx=Object.fromEntries(keys.map((k,i)=>[k,i]));
  let prev=null,prevDay=null;
  return lines.map((line,i)=>{
    const cells=line.split(',').map(x=>x.trim());
    if(cells.length!==keys.length)throw Error('Invalid column count at row '+(i+2));
    const stamp=cells[idx.time];
    if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/.test(stamp))
      throw Error('Time must be ISO 8601 with offset at row '+(i+2));
    const time=Date.parse(stamp);
    if(!Number.isFinite(time)|| (prev!==null&&time<=prev))
      throw Error('Invalid or unordered timestamp at row '+(i+2));
    const local=ist(time);
    if(local.minute<555||local.minute>=930||time%60000!==0)
      throw Error('Candles must start on 1-minute boundaries between 09:15 and 15:29 IST.');
    if(prev!==null&&local.day===prevDay&&time-prev!==60000)
      throw Error('Missing/noncontiguous intraday 1-minute candle at row '+(i+2));
    if(prevDay!==null&&local.day<prevDay)
      throw Error('Sessions must be chronological.');
    prev=time;prevDay=local.day;
    const bar={time};
    for(const k of required.slice(1)){
      if(cells[idx[k]]==='')throw Error('Missing '+k+' at row '+(i+2));
      bar[k]=Number(cells[idx[k]]);
    }
    bar.oi=keys.includes('oi')&&cells[idx.oi]!==''?Number(cells[idx.oi]):null;
    if(![bar.open,bar.high,bar.low,bar.close,bar.volume].every(Number.isFinite)||
      !positive(bar.open)||!positive(bar.low)||!positive(bar.high)||!positive(bar.close)||
      bar.volume<0||bar.low>Math.min(bar.open,bar.close)||
      bar.high<Math.max(bar.open,bar.close)||
      (bar.oi!==null&&(!Number.isFinite(bar.oi)||bar.oi<0)))
      throw Error('Invalid OHLCV/OI at row '+(i+2));
    return bar;
  });
}

function validateBars(bars) {
  if(!Array.isArray(bars)||bars.length<2||bars.length>10000)
    throw Error('Replay requires 2–10,000 candles.');
  let lastDay=null,lastTime=null;
  for(const b of bars) {
    if(!b||!Number.isInteger(b.time)||![b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)||
      !positive(b.open)||!positive(b.high)||!positive(b.low)||!positive(b.close)||
      b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)||b.volume<0||
      (b.oi!=null&&(!Number.isFinite(b.oi)||b.oi<0)))
      throw Error('Invalid replay bars.');
    const local=ist(b.time);
    if(local.minute<555||local.minute>=930||b.time%60000!==0||
      (lastTime!=null&&(b.time<=lastTime||(local.day===lastDay&&b.time-lastTime!==60000))))
      throw Error('Replay requires ascending, contiguous intraday 1m bars.');
    lastTime=b.time;lastDay=local.day;
  }
}

function sessions(bars) {
  const byDay=new Map();
  for(const b of bars) {
    const date=ist(b.time).day;
    let s=byDay.get(date);
    if(!s) {s={date,first:b.time,last:b.time,low:b.low,high:b.high,count:0};byDay.set(date,s);}
    s.low=Math.min(s.low,b.low);s.high=Math.max(s.high,b.high);
    s.count++;s.last=b.time;
  }
  for(const s of byDay.values()) {
    s.complete=s.count===375&&ist(s.first).minute===555&&ist(s.last).minute===929;
  }
  return byDay;
}
function levelFor(v,prior) {
  if(v.mode==='MANUAL')return {buyAbove:v.buyAbove,buyStop:v.buyStop,
    shortBelow:v.shortBelow,shortStop:v.shortStop,source:'manual',referenceDate:null};
  if(!prior?.complete)return null;
  const center=v.mode==='PREVIOUS_LOW'?prior.low:null;
  const buy=round2((center??prior.high)+v.autoBuffer);
  const sell=round2((center??prior.low)-v.autoBuffer);
  if(!(buy>sell))return null;
  return {buyAbove:buy,buyStop:sell,shortBelow:sell,shortStop:buy,
    source:v.mode,referenceDate:prior.date,pivot:center};
}

/** EMA uses only current and older supplied bars, seeded after period values. */
function emaLookup(bars) {
  const out=new Map();
  let e21=null,e90=null, sum21=0,sum90=0;
  for(let i=0;i<bars.length;i++) {
    const c=bars[i].close;
    if(i<21)sum21+=c;
    if(i<90)sum90+=c;
    if(i===20)e21=sum21/21;
    if(i===89)e90=sum90/90;
    if(i>20)e21=(c-e21)*2/22+e21;
    if(i>89)e90=(c-e90)*2/91+e90;
    out.set(bars[i].time,{close:c,fast:e21,slow:e90});
  }
  return out;
}

function filters(bars,i,v,trend) {
  const signal=bars[i],day=ist(signal.time).day;
  if(v.useVolume) {
    if(i<v.volumeLookback)return false;
    let total=0;
    for(let j=i-v.volumeLookback;j<i;j++){
      if(ist(bars[j].time).day!==day)return false;
      total+=bars[j].volume;
    }
    if(total<=0||signal.volume<v.volumeMultiplier*total/v.volumeLookback)return false;
  }
  if(v.useOi) {
    if(i===0||ist(bars[i-1].time).day!==day||
      signal.oi==null||bars[i-1].oi==null||signal.oi<=bars[i-1].oi)return false;
  }
  if(v.trendMode==='OFF')return true;
  // Must exactly match the option signal candle; no stale, forward, or interpolated data.
  if(!trend)return false;
  const t=trend.get(signal.time);
  return Boolean(t&&t.fast!=null&&(v.trendMode!=='EMA21_90'||t.slow!=null));
}
function trendSupports(trend,signalTime,mode,side) {
  if(mode==='OFF')return true;
  const x=trend?.get(signalTime);
  if(!x||x.fast==null||(mode==='EMA21_90'&&x.slow==null))return false;
  // PE buy follows a bearish underlying; PE short follows bullish underlying.
  return side==='LONG'
    ? x.close<x.fast&&(mode==='EMA21'||x.fast<x.slow)
    : x.close>x.fast&&(mode==='EMA21'||x.fast>x.slow);
}

/**
 * Signals: completed option candle close crossing session trigger;
 * execution: NEXT bar open, stop first if OHLC stop and partial target ambiguous.
 * Synthetic filter evaluated as-of SIGNAL candle, never entry/future candle.
 * One position at a time, half exit at R, trailing stop from prior complete bar.
 */
export function replayPremiumStrategy(bars,input=PREMIUM_PRESET,syntheticBars=null) {
  const v=validatePremiumRules(input);
  validateBars(bars);
  if(v.trendMode!=='OFF'){
    if(!syntheticBars)throw Error('Import time-aligned NIFTY/Synthetic 1m candles for trend filter.');
    validateBars(syntheticBars);
  }
  const trend=syntheticBars?emaLookup(syntheticBars):null;
  const byDay=sessions(bars),days=[...byDay.keys()];
  const dayLevel=new Map(),levels=[];
  days.forEach((day,i)=>{
    const prior=i>0?byDay.get(days[i-1]):null;
    const entry=levelFor(v,prior);
    dayLevel.set(day,entry);
    levels.push({date:day,...(entry||{source:'unavailable',referenceDate:prior?.date??null}),
      referenceComplete:prior?.complete??false});
  });
  const trades=[],events=[],incomplete=[];
  let position=null;
  const signalAccepted=(prev,earlier,side,lev)=>side==='LONG'
    ? earlier.close<=lev.buyAbove&&prev.close>lev.buyAbove
    : earlier.close>=lev.shortBelow&&prev.close<lev.shortBelow;
  function close(index,price,reason){
    const p=position,points=(p.partial?p.firstPoints:0)+
      (p.partial?0.5:1)*(price-p.entry)*(p.side==='LONG'?1:-1);
    trades.push({side:p.side,entryTime:p.time,signalTime:p.signalTime,entry:p.entry,
      stop:p.initialStop,firstExit:p.partial?.price??null,
      firstExitTime:p.partial?.time??null,exitTime:bars[index].time,
      exit:price,exitReason:reason,points,initialRisk:p.risk,r:points/p.risk});
    events.push({type:'EXIT',time:bars[index].time,side:p.side,price,reason});
    position=null;
  }
  for(let i=1;i<bars.length;i++) {
    const bar=bars[i],prev=bars[i-1],day=ist(bar.time).day,priorDay=ist(prev.time).day;
    if(day!==priorDay&&position){
      incomplete.push({side:position.side,entry:position.entry,time:position.time,
        lastKnownPrice:prev.close,reason:'PREVIOUS_SESSION_INCOMPLETE'});
      position=null;
    }
    const lev=dayLevel.get(day),minute=ist(bar.time).minute;
    if(!position&&day===priorDay&&minute<929&&i>=2&&
      ist(bars[i-2].time).day===day&&lev&&filters(bars,i-1,v,trend)) {
      const candidates=v.directions==='LONG'?['LONG']:
        v.directions==='SHORT'?['SHORT']:['LONG','SHORT'];
      const side=candidates.find(s=>signalAccepted(prev,bars[i-2],s,lev)&&
        trendSupports(trend,prev.time,v.trendMode,s));
      if(side) {
        const stop=side==='LONG'?lev.buyStop:lev.shortStop;
        const risk=side==='LONG'?bar.open-stop:stop-bar.open;
        if(risk>0) {
          position={side,entry:bar.open,time:bar.time,signalTime:prev.time,
            initialStop:stop,stop,risk,partial:null,firstPoints:0};
          events.push({type:'ENTRY',time:bar.time,side,price:bar.open,
            referenceDate:lev.referenceDate});
        }else events.push({type:'REJECTED_GAP',time:bar.time,side,price:bar.open});
      }
    }
    if(!position)continue;
    const p=position,long=p.side==='LONG';
    // Trail BEFORE evaluating current candle, using the last COMPLETED candle.
    if(p.partial&&i>p.partial.index) {
      p.stop=long?Math.max(p.stop,prev.low):Math.min(p.stop,prev.high);
    }
    if(long?bar.low<=p.stop:bar.high>=p.stop){
      close(i,long?Math.min(p.stop,bar.open):Math.max(p.stop,bar.open),'STOP');
      continue;
    }
    if(!p.partial){
      const target=p.entry+(long?1:-1)*v.partialR*p.risk;
      if(long?bar.high>=target:bar.low<=target){
        const fill=long?Math.max(target,bar.open):Math.min(target,bar.open);
        p.partial={price:fill,time:bar.time,index:i};
        p.firstPoints=0.5*(fill-p.entry)*(long?1:-1);
        events.push({type:'HALF_EXIT',time:bar.time,side:p.side,price:fill});
      }
    }
    if(minute===929&&position)close(i,bar.close,'SESSION_END');
  }
  if(position&&ist(bars.at(-1).time).minute===929)
    close(bars.length-1,bars.at(-1).close,'SESSION_END');
  const wins=trades.filter(t=>t.points>0),losses=trades.filter(t=>t.points<0);
  return {schema:'QSYN-PREMIUM-RESEARCH/2',source:'user_supplied_csv',
    trading_enabled:false,levels,trades,events,incomplete,
    openPosition:position?{side:position.side,entry:position.entry,time:position.time,
      stop:position.stop,partial:position.partial,
      unrealizedAtLastClose:(position.partial?position.firstPoints:0)+
        (position.partial?0.5:1)*(bars.at(-1).close-position.entry)*(position.side==='LONG'?1:-1)}:null,
    summary:{completed:trades.length,wins:wins.length,losses:losses.length,
      winRate:trades.length?wins.length/trades.length:null,
      realizedPoints:trades.reduce((s,t)=>s+t.points,0),
      avgR:trades.length?trades.reduce((s,t)=>s+t.r,0)/trades.length:null},
  };
}
