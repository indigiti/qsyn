/**
 * Provider-only gap reconciliation. Missing OHLC is never estimated, carried
 * forward, or represented as a zero-volume synthetic candle.
 *
 * Crypto trades 24/7. Index repair is restricted to two real minute candles
 * in the SAME 09:15–15:30 Asia/Kolkata trading session; weekends, holidays
 * and overnight boundaries must not be interpreted as missing candles.
 */
export const GAP_REPAIR_COOLDOWN_MS=300_000;
export const GAP_REPAIR_MAX_REQUESTS=2;
const IST_OFFSET=19_800;
const INDEX_OPEN=9*3600+15*60;
const INDEX_CLOSE=15*3600+30*60;

function inSameIndexSession(left,right){
  const a=left+IST_OFFSET,b=right+IST_OFFSET;
  if(Math.floor(a/86400)!==Math.floor(b/86400))return false;
  const day=new Date(a*1000).getUTCDay();
  if(day===0||day===6)return false;
  const minuteA=((a%86400)+86400)%86400;
  const minuteB=((b%86400)+86400)%86400;
  return minuteA>=INDEX_OPEN&&minuteA<INDEX_CLOSE&&
    minuteB>=INDEX_OPEN&&minuteB<INDEX_CLOSE;
}

/** Only strictly internal missing slots are eligible for retry; an absent
 * chart leading/trailing edge does not prove those candles existed.
 */
export function findProviderGaps(bars,step,{index=false,limit=GAP_REPAIR_MAX_REQUESTS}={}){
  if(!Array.isArray(bars)||!Number.isSafeInteger(step)||step<60)return [];
  const gaps=[];
  for(let i=bars.length-1;i>=1&&gaps.length<limit;i--){
    const left=bars[i-1]?.time,right=bars[i]?.time;
    if(!Number.isSafeInteger(left)||!Number.isSafeInteger(right)||
      right<=left+step||(right-left)%step!==0)continue;
    if(index&&(step!==60||!inSameIndexSession(left,right)))continue;
    gaps.push({left,right,missing:(right-left)/step-1});
  }
  // Already ordered from the most recent gap backward.
  return gaps;
}

/** Insert only genuinely returned, timestamp-matched missing slots. Keep
 * existing live values authoritative when the provider replay is older.
 */
export function mergeProviderGapBars(existing,fetched,step,{index=false}={}){
  if(!Array.isArray(existing)||!Array.isArray(fetched)||!existing.length)
    return existing;
  const gaps=findProviderGaps(existing,step,{index,limit:existing.length});
  if(!gaps.length)return existing;
  const byTime=new Map(existing.map(bar=>[bar.time,bar]));
  let inserted=0;
  for(const bar of fetched){
    if(!Number.isSafeInteger(bar?.time)||byTime.has(bar.time))continue;
    if(!gaps.some(g=>bar.time>g.left&&bar.time<g.right&&
      (bar.time-g.left)%step===0))continue;
    byTime.set(bar.time,bar);
    inserted++;
  }
  return inserted?[...byTime.values()].sort((a,b)=>a.time-b.time):existing;
}

/** One recovery attempt per gap during cooldown; bounded memory. An attempt
 * marks the gap even if the source cannot supply it, preventing request
 * storms during a sparse/no-trade market.
 */
export function shouldAttemptGap(attempts,key,now=Date.now()){
  const last=attempts.get(key);
  if(last!==undefined&&now-last<GAP_REPAIR_COOLDOWN_MS)return false;
  attempts.delete(key);
  attempts.set(key,now);
  while(attempts.size>128)attempts.delete(attempts.keys().next().value);
  return true;
}
