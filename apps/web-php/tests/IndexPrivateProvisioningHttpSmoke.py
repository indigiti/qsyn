#!/usr/bin/env python3
"""Admin browser may prepare only a private INACTIVE draft, never rights or a worker."""
import os
import subprocess
import tempfile
from pathlib import Path
from IdentityHttpSmoke import await_server,client,open_port,php_server,request

PASSWORD='ci-index-private-preparation-password-12345'
ROOT='/qsyn/api/v1/admin/index-prepare/'
ADMIN='/qsyn/api/v1/admin/rust/'

def main():
  with tempfile.TemporaryDirectory(prefix='qsyn-index-prepare-') as temp:
    runtime=Path(temp)/'runtime';sessions=Path(temp)/'sessions'
    runtime.mkdir(mode=0o700);sessions.mkdir(mode=0o700)
    hashed=subprocess.check_output(['php','-r',
      'echo password_hash($argv[1],PASSWORD_DEFAULT);',PASSWORD],text=True).strip()
    env={**os.environ,'QSYN_ALLOW_HTTP_TEST':'1','QSYN_CONTROL_ENABLED':'1',
      'QSYN_ADMIN_PASSWORD_HASH':hashed,'QSYN_RUNTIME_DIR':str(runtime),
      'QSYN_TRADING_ENABLED':'0','QSYN_ENABLE_LIVE_TRADING':'0',
      'QSYN_UPSTOX_ANALYTICS_EXPECTED_USER_ID':'SAFE-TEST-USER'}
    env.pop('QSYN_UPSTOX_INDEX_WORKER_PLAN_FILE',None)
    env.pop('QSYN_INDEX_WEB_ARCHIVE_ROOT',None)
    port=open_port();origin=f'http://127.0.0.1:{port}'
    server=php_server(env,sessions,port)
    try:
      await_server(origin)
      outsider,_=client()
      assert request(outsider,origin,ROOT+'status')[0]==401
      assert request(outsider,origin,ROOT+'prepare','POST',
        {'confirmed':True,'tenant':'tenant','owner':'owner','account':'account'})[0]==401
      admin,_=client()
      code,login,_=request(admin,origin,ADMIN+'login','POST',{'password':PASSWORD})
      assert code==200 and login['authenticated']
      code,status,headers=request(admin,origin,ROOT+'status')
      assert code==200,(code,status)
      assert status['schema']=='QSYN-INDEX-PRIVATE-PROVISIONING/1'
      assert status['plan_prepared'] is False
      assert status['rights_approved_by_browser'] is False
      assert status['live_feed_activated'] is False
      assert status['trading_enabled'] is False
      assert len(status['csrf'])==64
      assert 'no-store' in headers['Cache-Control']
      assert len(headers['X-QSYN-Request-ID'])==16
      payload={'confirmed':True,'tenant':'tenant','owner':'owner','account':'account'}
      assert request(admin,origin,ROOT+'prepare')[0]==405
      assert request(admin,origin,ROOT+'status','POST',{},status['csrf'])[0]==405
      assert request(admin,origin,ROOT+'prepare','POST',payload)[0]==403
      assert request(admin,origin,ROOT+'prepare','POST',payload,status['csrf'],
        browser_origin='http://forged.invalid')[0]==403
      for unsafe in [
        {**payload,'tenant':'../../root'},
        {**payload,'private_rights_file':'/tmp/rights'},
        {**payload,'operator_approved_display':True},
        {**payload,'instrument_key':'BSE_INDEX|SENSEX'},
      ]:
        assert request(admin,origin,ROOT+'prepare','POST',unsafe,status['csrf'])[0]==422
      # There is no existing private Upstox token, so no authenticated
      # index discovery can happen and NO plan or rights file may appear.
      code,result,_=request(admin,origin,ROOT+'prepare','POST',payload,status['csrf'])
      assert code==409,(code,result)
      assert result['error']=='upstox_private_session_required'
      root=runtime/'upstox-private'
      assert not list(root.glob('*plan*'))
      assert not list(root.glob('*rights*'))
      assert not list(root.glob('*mapping*'))
      assert request(outsider,origin,ROOT+'prepare','POST',payload,status['csrf'])[0]==401
      print('PASS index private preparation: admin CSRF, strict scope, private token dependency, no asserted rights')
    finally:
      server.terminate();server.communicate(timeout=5)

if __name__=='__main__': main()
