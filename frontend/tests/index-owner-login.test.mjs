import assert from 'node:assert/strict';
import {indexOwnerSession,unlockIndexOwner} from '../src/index-owner-login.js';
const reply=(status,data)=>({status,ok:status>=200&&status<300,
  json:async()=>data});
assert.equal(await indexOwnerSession(async()=>reply(200,{authenticated:false,configured:true})),'login');
assert.equal(await indexOwnerSession(async()=>reply(200,{authenticated:true})),'authenticated');
assert.equal(await indexOwnerSession(async()=>reply(503,{})),'unavailable');
assert.equal((await unlockIndexOwner('')).status,'login');
const calls=[];
const good=await unlockIndexOwner('test-password',async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith('/login'))return reply(200,{authenticated:true});
  return reply(200,{schema:'QSYN-INDEX-HISTORICAL-PROOF/1',token_present:true,csrf:'a'.repeat(64)});
});
assert.equal(good.status,'ready');
assert.equal(calls.length,2);
assert.equal(calls[0].options.credentials,'same-origin');
assert.equal(calls[0].options.method,'POST');
assert.equal(calls[0].options.headers['Content-Type'],'application/json');
assert.equal((await unlockIndexOwner('wrong',async()=>reply(401,{}))).status,'login');
const unavailable=await unlockIndexOwner('valid',async(url)=>url.endsWith('/login')
  ?reply(200,{authenticated:true}):reply(403,{}));
assert.equal(unavailable.status,'authenticated');
assert.equal((await unlockIndexOwner('valid',async()=>{throw Error('offline')})).status,'login');
console.log('compact index owner login contracts passed');
