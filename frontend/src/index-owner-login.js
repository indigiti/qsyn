/** Compact chart sign-in reuses QSYN's existing hardened administrator session.
 * Never return a password, CSRF value, cookie, or private instrument key.
 */
const STATE='/qsyn/api/v1/admin/rust/state';
const LOGIN='/qsyn/api/v1/admin/rust/login';
const PROOF='/qsyn/api/v1/admin/upstox/index-history-proof';
const READ={credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}};

export async function indexOwnerSession(fetcher=fetch,signal){
  const response=await fetcher(STATE,{...READ,signal});
  if(!response.ok)return response.status===401?'login':'unavailable';
  const data=await response.json().catch(()=>null);
  if(data?.authenticated===true)return 'authenticated';
  if(data?.authenticated===false&&data?.configured===true)return 'login';
  return 'unavailable';
}

export async function unlockIndexOwner(password,fetcher=fetch){
  if(typeof password!=='string'||!password.length||password.length>1024){
    return {status:'login',error:'Enter your administrator password.'};
  }
  let response;
  try{
    response=await fetcher(LOGIN,{
      method:'POST',credentials:'same-origin',cache:'no-store',
      headers:{Accept:'application/json','Content-Type':'application/json'},
      body:JSON.stringify({password}),
    });
  }catch{
    return {status:'login',error:'Sign-in connection unavailable. Try again.'};
  }
  if(response.status===401){
    return {status:'login',error:'Incorrect password or sign-in temporarily locked.'};
  }
  if(!response.ok){
    return {status:'unavailable',error:'Sign-in service unavailable. Use terminal sign-in.'};
  }
  const data=await response.json().catch(()=>null);
  if(data?.authenticated!==true){
    return {status:'unavailable',error:'Sign-in confirmation unavailable. Use terminal sign-in.'};
  }
  // A successful admin login is NOT proof of a valid Upstox Analytics Token.
  // Only refresh the selected index after the protected history proof succeeds.
  try{
    const proof=await fetcher(PROOF,READ);
    if(proof.ok){
      const result=await proof.json().catch(()=>null);
      if(result?.schema==='QSYN-INDEX-HISTORICAL-PROOF/1'&&
        result.token_present===true&&
        /^[a-f0-9]{64}$/i.test(result.csrf||'')){
        return {status:'ready'};
      }
    }
  }catch{/* Keep signed-in state; do not claim index data is authorized. */}
  return {status:'authenticated',
    error:'Signed in. Index data is not ready; check Diagnostics.'};
}
