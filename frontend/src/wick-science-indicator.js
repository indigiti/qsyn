import {registerIndicator} from 'openalgo-charts';
import {calculateWickScience,WICK_SCIENCE_ID} from './wick-science-core.js';

export {WICK_SCIENCE_ID} from './wick-science-core.js';

const signals = [
  ['shortArmed','Upper MFE touched','circle','aboveBar','#ef4444','',true],
  ['longArmed','Lower MFE touched','circle','belowBar','#22c55e','',true],
  ['shortEntry','SELL flip','labelDown','aboveBar','#ef4444','SELL',false],
  ['longEntry','BUY flip','labelUp','belowBar','#16a34a','BUY',false],
  ['shortTP','Short TP','diamond','belowBar','#22d3ee','',false],
  ['longTP','Long TP','diamond','aboveBar','#22d3ee','',false],
  ['shortSL','Short SL','xcross','aboveBar','#f97316','',false],
  ['longSL','Long SL','xcross','belowBar','#f97316','',false],
];
const alerts = [
  ['shortArmed','Upper MFE touched','Selected TF upper MFE touched: watch for SELL flip at its open'],
  ['longArmed','Lower MFE touched','Selected TF lower MFE touched: watch for BUY flip at its open'],
  ['shortEntry','SELL flip','SELL flip at selected TF open; TP is lower MFE zone'],
  ['longEntry','BUY flip','BUY flip at selected TF open; TP is upper MFE zone'],
  ['shortTP','Short TP','Opposite MFE target touched'],
  ['longTP','Long TP','Opposite MFE target touched'],
  ['shortSL','Short SL','Protective stop touched'],
  ['longSL','Long SL','Protective stop touched'],
];

export function wickScienceDescriptor() {
  return {
    id:WICK_SCIENCE_ID,
    name:'Wick Science – Multi-TF MFE Flip',
    category:'QSYN Custom',
    placement:'onchart',
    markerAnchor:'price',
    inputs:[
      {key:'setupTf',type:'select',label:'Wick candle TF',default:'5',options:
        ['1','3','5','15'].map(value=>({value,label:value+'m'}))},
      {key:'samples',type:'number',label:'Completed TF candles',default:100,min:20,max:1000,step:1},
      {key:'reachRate',type:'number',label:'Historical reach rate (%)',default:80,min:50,max:99,step:1},
      {key:'zoneFraction',type:'number',label:'MFE fraction (%)',default:80,min:10,max:100,step:5},
      {key:'slBuffer',type:'number',label:'Stop buffer (ticks)',default:2,min:0,max:100,step:1},
      {key:'showArms',type:'boolean',label:'Show zone touches',default:true},
      // Used only when the chart host does not supply price scale minMove.
      // Exposing it as 0 (disabled) prevents silently assuming an instrument tick.
      {key:'tickOverride',type:'number',label:'Tick size override (0 = auto)',default:0,min:0,step:0.0001},
    ],
    plots:[
      {key:'setupOpen',type:'step',title:'Selected TF Open',style:{color:'#eab308',lineWidth:2}},
      {key:'upperZone',type:'step',title:'Upper MFE Zone',style:{color:'#ef4444',lineWidth:1.5}},
      {key:'lowerZone',type:'step',title:'Lower MFE Zone',style:{color:'#22c55e',lineWidth:1.5}},
      {key:'activeStop',type:'line',title:'Active Stop',style:{color:'#f97316',lineWidth:2}},
    ],
    calc:(bars,s,_store,ctx)=>{
      const lastConfirmed = ctx?.barState?.isConfirmed===true;
      const tickSize = Number(s.tickOverride)>0 ? Number(s.tickOverride):ctx?.tickSize;
      const res=calculateWickScience(bars,s,{interval:ctx?.interval,lastConfirmed,tickSize});
      return res.values;
    },
    markers:({bars,values,settings})=>{
      const out=[];
      for(let i=0;i<bars.length;i++){
        for(const [key,,shape,position,color,label,isArm] of signals){
          if(isArm && settings.showArms === false)continue;
          if(values[key]?.[i]!==1)continue;
          out.push({time:bars[i].time,position,shape,
            size:shape==='circle'?'tiny':'small',color,
            ...(label?{text:label,textColor:'#ffffff'}:{})});
        }
      }
      return out;
    },
    alerts:alerts.map(([key,title,message])=>({
      id:key,title:'Wick Science: '+title,message,frequency:'onBarClose',
      when:({values,index})=>values[key]?.[index]===1,
    })),
  };
}
export function registerWickScience() {
  registerIndicator(wickScienceDescriptor());
}
