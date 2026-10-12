#!/usr/bin/env python3
"""No public history proof, raw token input, arbitrary instrument URLs or worker side effects."""
import os
import subprocess
import tempfile
from pathlib import Path
from IdentityHttpSmoke import await_server,client,open_port,php_server,request

PASSWORD='ci-core-upstox-history-password-123456'
API='/qsyn/api/v1/admin/upstox/index-history-proof'
ADMIN='/qsyn/api/v1/admin/rust/'

def main():
  with tempfile.TemporaryDirectory(prefix='qsyn-core-proof-') as temp:
    runtime=Path(temp)/'runtime'; sessions=Path(temp)/'sessions'
    runtime.mkdir(mode=0o700);sessions.mkdir(mode=0o700)
    hashed=subprocess.check_output(['php','-r',
      'echo password_hash($argv[1],PASSWORD_DEFAULT);',PASSWORD],text=True).strip()
    env={**os.environ,'QSYN_ALLOW_HTTP_TEST':'1',
      'QSYN_CONTROL_ENABLED':'1','QSYN_ADMIN_PASSWORD_HASH':hashed,
      'QSYN_RUNTIME_DIR':str(runtime),'QSYN_TRADING_ENABLED':'0',
      'QSYN_ENABLE_LIVE_TRADING':'0'}
    env.pop('QSYN_UPSTOX_ANALYTICS_EXPECTED_USER_ID',None)
    port=open_port(); origin=f'http://127.0.0.1:{port}'
    server=php_server(env,sessions,port)
    try:
      await_server(origin)
      guest,_=client()
      assert request(guest,origin,API)[0]==401
      assert request(guest,origin,API,'POST',
        {'symbol':'NIFTY','day':'2026-10-09','confirmed':True})[0]==401
      admin,_=client()
      code,login,_=request(admin,origin,ADMIN+'login','POST',{'password':PASSWORD})
      assert code==200 and login['authenticated'],(code,login)
      code,status,headers=request(admin,origin,API)
      assert code==200,(code,status)
      assert status['schema']=='QSYN-INDEX-HISTORICAL-PROOF/1'
      assert status['symbols']==['NIFTY','SENSEX']
      assert status['history_verified'] is False
      assert status['display_rights_verified'] is False
      assert status['live_feed_verified'] is False
      assert status['trading_enabled'] is False
      assert status['token_present'] is False
      assert len(status['csrf'])==64
      assert 'no-store' in headers['Cache-Control']
      assert len(headers['X-QSYN-Request-ID'])==16
      good={'symbol':'NIFTY','day':'2026-10-09','confirmed':True}
      assert request(admin,origin,API,'POST',good)[0]==403
      assert request(admin,origin,API,'POST',good,status['csrf'],
        browser_origin='http://evil.example')[0]==403
      for invalid in [
        {'symbol':'NSE_FO','day':'2026-10-09','confirmed':True},
        {'symbol':'NIFTY','day':'2026-10-09','confirmed':True,'token':'SECRET'},
        {'symbol':'SENSEX','day':'2026-10-09','confirmed':True,
          'url':'https://127.0.0.1:9999/private'},
        {'symbol':'NIFTY','day':'2026-10-10','confirmed':True},
        {'symbol':'NIFTY','day':'2030-01-01','confirmed':True},
        {'symbol':'NIFTY','day':'2026-10-09','confirmed':False},
      ]:
        assert request(admin,origin,API,'POST',invalid,status['csrf'])[0]==422,invalid
      code,result,_=request(admin,origin,API,'POST',good,status['csrf'])
      assert code==409 and result['error']=='upstox_analytics_token_not_ready',(code,result)
      assert not list(runtime.rglob('*index*'))
      print('PASS core history proof: restricted admin, fixed symbols and date, no secrets or worker activation')
    finally:
      server.terminate();server.communicate(timeout=5)
if __name__=='__main__':main()
