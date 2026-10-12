import React,{useEffect,useMemo,useState} from 'react';
import {Activity,ArrowRight,CheckCircle2,LockKeyhole,RefreshCw,ShieldCheck} from 'lucide-react';
import {MARKET_FAMILIES,MARKET_PROVIDERS,DEFAULT_MARKET,catalogFor,
  marketFamily,providerFor,isValidCryptoHealth,providerEvidence} from './market-model.js';
import './market-explorer.css';

const healthRequest = source=>'/qsyn/api/v1/crypto/health?'+new URLSearchParams({
  exchange:source.exchange,market:source.market,symbol:source.symbol,interval:'1m',limit:'5'
});
export function MarketExplorer({theme,openView,CryptoChart,PrivateCharts}){
  const [market,setMarket]=useState(DEFAULT_MARKET);
  const family=marketFamily(market);
  const [venue,setVenue]=useState('BINANCE');
  const [optionProvider,setOptionProvider]=useState('simulation');
  const [instrument,setInstrument]=useState('');
  const [cryptoCheck,setCryptoCheck]=useState(null);
  const [tokenStatus,setTokenStatus]=useState(null);
  const [audit,setAudit]=useState(null);
  const [checking,setChecking]=useState(false);
  const [checkSeq,setCheckSeq]=useState(0);
  const instruments=useMemo(()=>catalogFor(market).filter(row=>
    !family.venues.length||family.venues.includes(row.exchange)),[market]);
  const currentVenue=family.venues.includes(venue)?venue:family.venues[0];
  const venueInstruments=instruments.filter(x=>x.exchange===currentVenue);
  const currentInstrument=venueInstruments.find(x=>x.id===instrument)||venueInstruments[0]||null;
  const provider=market==='crypto'?currentVenue.toLowerCase():
    market==='options'?optionProvider:'upstox';
  const evidence=providerEvidence({
    market,provider,health:cryptoCheck,tokenStatus,
    operatorPreflight:audit
  });
  useEffect(()=>{
    const c=new AbortController();
    setCryptoCheck(null);setTokenStatus(null);setAudit(null);
    const source=market==='crypto'?currentInstrument:null;
    if(!source && market==='crypto')return()=>c.abort();
    setChecking(true);
    const task=market==='crypto'
      ? fetch(healthRequest(source),{credentials:'same-origin',cache:'no-store',signal:c.signal,
          headers:{Accept:'application/json'}})
          .then(async r=>{
            const data=r.ok?await r.json():null;
            if(!isValidCryptoHealth(data,source.exchange))throw Error('INVALID_CRYPTO_HEALTH');
            if(!c.signal.aborted)setCryptoCheck(data);
          })
      : market==='indices'||market==='stocks'||market==='options'
      ? Promise.all([
          fetch('/qsyn/api/v1/admin/upstox/analytics/status',{
            credentials:'same-origin',cache:'no-store',signal:c.signal,
            headers:{Accept:'application/json'}}).then(r=>r.ok?r.json():null).catch(()=>null),
          fetch('/qsyn/api/v1/admin/diagnostics/report',{
            credentials:'same-origin',cache:'no-store',signal:c.signal,
            headers:{Accept:'application/json'}}).then(r=>r.ok?r.json():null).catch(()=>null),
        ]).then(([token,report])=>{
          if(!c.signal.aborted){
            setTokenStatus(token?.schema==='QSYN-UPSTOX-ANALYTICS-STATUS/1'?token:null);
            setAudit(report?.schema==='QSYN-ADMIN-DIAGNOSTICS/1'?report.index_activation:null);
          }
        })
      : Promise.resolve();
    void task.catch(()=>{}).finally(()=>{if(!c.signal.aborted)setChecking(false);});
    return()=>c.abort();
  },[market,currentVenue,currentInstrument?.id,checkSeq]);
  const activeVenueName=currentVenue==='NSE_INDEX'?'NSE Index':
    currentVenue==='BSE_INDEX'?'BSE Index':currentVenue;
  return <div className="terminal-page qt-unified qt-market-explorer">
    <header className="terminal-title">
      <div><p className="terminal-eyebrow">MARKETS / DATA SOURCES</p>
        <h1>Market explorer</h1>
        <p>Choose a market, exchange and provider. Market status reflects verified
          source evidence, not a broker login or simulated chart.</p>
      </div>
      <button type="button" className="terminal-action terminal-secondary-action"
        onClick={()=>setCheckSeq(x=>x+1)} disabled={checking}>
        <RefreshCw size={15}/> {checking?'Checking…':'Check source'}</button>
    </header>
    <div className="qt-market-families" role="group" aria-label="Market categories">
      {MARKET_FAMILIES.map(m=><button key={m.id} type="button"
        className={'qt-market-family'+(market===m.id?' selected':'')}
        aria-pressed={market===m.id}
        onClick={()=>{setMarket(m.id);setVenue(m.venues[0]);setInstrument('');}}>
        {m.label}</button>)}
    </div>
    <section className="terminal-surface qt-market-source-panel">
      <div className="qt-market-source-selects">
        <label>Exchange / venue
          <select aria-label="Exchange venue" value={currentVenue||''}
            disabled={!family.venues.length}
            onChange={e=>{setVenue(e.target.value);setInstrument('');}}>
            {family.venues.map(v=><option key={v} value={v}>{v}</option>)}
          </select></label>
        <label>Market-data provider
          <select aria-label="Market data provider" value={provider}
            onChange={e=>{if(market==='options')setOptionProvider(e.target.value);}}
            disabled={family.providers.length===1 || market==='crypto'}>
            {(market==='crypto'?[provider]:family.providers).map(id=>
              <option key={id} value={id}>{providerFor(id).label}</option>)}
          </select></label>
        {(market==='crypto'||market==='indices')&&<label>Instrument
          <select aria-label="Market instrument" value={currentInstrument?.id||''}
            onChange={e=>setInstrument(e.target.value)}>
            {venueInstruments.map(row=><option key={row.id} value={row.id}>
              {row.label||row.name||row.symbol}</option>)}
          </select></label>}
      </div>
      <div className="qt-market-status-grid" role="status" aria-label="Selected provider status">
        <div><small>Provider connection</small><strong>{evidence.connection==='responding'
          ? 'Public endpoint responding':evidence.connection==='simulated'
          ? 'Simulation only':'Not verified'}</strong></div>
        <div><small>Historical candles</small><strong>{evidence.history==='simulated'
          ? 'Simulated':'Not checked for this source'}</strong></div>
        <div><small>Live streaming</small><strong>{evidence.streaming==='verified'
          ? 'Verified live':'Not verified'}</strong></div>
        <div><small>Display entitlement</small><strong>{evidence.display==='public_exchange'
          ? 'Public source':evidence.display==='simulation_only'
          ? 'Simulation only':'Not verified'}</strong></div>
      </div>
      <p className="terminal-footnote">
        {market==='crypto'&&cryptoCheck
          ? activeVenueName+' public health API responded. This alone does not confirm current candles or a continuously streaming socket.'
          : market==='crypto'?'Public exchange status not verified. No demo fallback is permitted.'
          : market==='indices'
          ? (evidence.authenticated==='stored_unverified'
            ? 'Upstox Analytics Token stored. Authentication status is not proof of account rights, current NSE/BSE mapping or streaming.'
            : 'Upstox private index data requires an authorized account and approved exchange display rights.')
          : market==='stocks'?'Stock market adapter not operationally verified; no invented NSE/BSE candles.'
          : 'Option research uses simulation. Live CE/PE requires a separately authorized broker subscription.'}
      </p>
      <div className="qt-actions">
        <button className="terminal-action terminal-secondary-action" type="button"
          onClick={()=>openView('brokers')}>Data Providers & Connections <ArrowRight size={15}/></button>
        <button className="terminal-action terminal-secondary-action" type="button"
          onClick={()=>openView('diagnostics')}>Source diagnostics <Activity size={15}/></button>
      </div>
    </section>
    {market==='crypto'&&<>
      <p className="qt-market-chart-hint">Public crypto chart · {providerFor(provider).label} ·
        {currentInstrument?.symbol||'No instrument'}.
        Native chart search, indicators, watchlists and saved layouts remain available.</p>
      {currentInstrument&&<CryptoChart key={currentInstrument.id} theme={theme}
        embedded initialExchange={currentInstrument.exchange+':'+currentInstrument.market}
        initialSymbol={currentInstrument.symbol}/>}
    </>}
    {market==='indices'&&<>
      <section className="terminal-surface">
        <div className="terminal-card-head"><h2>Licensed index chart</h2><LockKeyhole size={17}/></div>
        <p>NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX and INDIA VIX use
          current exchange instrument keys, not the alias shown in the selector.
          Enter the approved key only after instrument and display rights are verified.
          Historical data and private WSS must be independently activated.</p>
        <p role="status" className="terminal-footnote">Private index activation:
          {' '}{audit?.next_action_code||'NO_CURRENT_OPERATOR_PREFLIGHT'}.
          {' '}A saved Analytics Token is not evidence of a licensed live feed.</p>
      </section>
      <PrivateCharts embedded onlyIndex/>
    </>}
    {market==='stocks'&&<section className="terminal-surface">
      <div className="terminal-card-head"><h2>NSE / BSE equities</h2><LockKeyhole size={16}/></div>
      <p>A general cash-equity data provider has not been verified end to end.
        No stock charts or prices are substituted from another market.</p>
      <button className="terminal-action terminal-secondary-action" onClick={()=>openView('brokers')}>
        Check approved providers <ArrowRight size={16}/></button>
    </section>}
    {market==='options'&&<section className="terminal-surface">
      <div className="terminal-card-head"><h2>Options research and CE/PE feeds</h2><ShieldCheck size={16}/></div>
      <p>{optionProvider==='simulation'
        ? 'Strategy Studio uses deterministic options simulation. This never becomes a broker quote or order.'
        : 'Upstox CE/PE requires exact contract, expiry and independently authorized private market-data access. No live option source is verified.'}
        {' '}The strategy builder never silently substitutes one provider for another.</p>
      <div className="qt-actions">
        <button className="terminal-action" onClick={()=>openView('strategy')}>
          Open Strategy Studio <ArrowRight size={16}/></button>
        <button className="terminal-action terminal-secondary-action" onClick={()=>openView('private-live')}>
          Private CE/PE access <LockKeyhole size={16}/></button>
      </div>
    </section>}
  </div>;
}
