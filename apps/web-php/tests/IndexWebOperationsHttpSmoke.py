#!/usr/bin/env python3
"""No browser may run index commands without admin, CSRF, and host provisioning."""
import os
import subprocess
import tempfile
from pathlib import Path
from IdentityHttpSmoke import await_server,client,open_port,php_server,request

PASSWORD='ci-index-web-admin-password-123456'
URL='/qsyn/api/v1/admin/index-ops/'
ADMIN='/qsyn/api/v1/admin/rust/'
def main():
  with tempfile.TemporaryDirectory(prefix='qsyn-index-web-') as temp:
    runtime=Path(temp)/'runtime';sessions=Path(temp)/'sessions'
    runtime.mkdir(mode=0o700);sessions.mkdir(mode=0o700)
    hashed=subprocess.check_output(['php','-r',
      'echo password_hash($argv[1],PASSWORD_DEFAULT);',PASSWORD],text=True).strip()
    env={**os.environ,'QSYN_ALLOW_HTTP_TEST':'1',
      'QSYN_CONTROL_ENABLED':'1','QSYN_ADMIN_PASSWORD_HASH':hashed,
      'QSYN_RUNTIME_DIR':str(runtime),
      'QSYN_INDEX_WEB_OPERATIONS_ENABLED':'0',
      'QSYN_TRADING_ENABLED':'0','QSYN_ENABLE_LIVE_TRADING':'0'}
    port=open_port();origin=f'http://127.0.0.1:{port}'
    server=php_server(env,sessions,port)
    try:
      await_server(origin)
      anonymous,_=client()
      assert request(anonymous,origin,URL+'status')[0]==401
      assert request(anonymous,origin,URL+'check','POST',
        {'confirmed':True,'date':'2026-10-09'})[0]==401
      admin,_=client()
      code,login,_=request(admin,origin,ADMIN+'login','POST',{'password':PASSWORD})
      assert code==200 and login['authenticated'],(code,login)
      code,status,headers=request(admin,origin,URL+'status')
      assert code==200,(code,status)
      assert status['schema']=='QSYN-INDEX-WEB-OPERATIONS/1'
      assert status['web_operations_enabled'] is False
      assert status['preflight_enabled'] is False
      assert status['private_plan_ready'] is False
      assert isinstance(status['executor_ready'],bool)
      assert status['backfill_enabled'] is False
      assert status['service_controls_enabled'] is False
      assert status['live_index_prices_verified'] is False
      assert status['trading_enabled'] is False
      assert len(status['csrf'])==64
      assert 'no-store' in headers['Cache-Control']
      assert len(headers['X-QSYN-Request-ID'])==16
      assert request(admin,origin,URL+'check')[0]==405
      assert request(admin,origin,URL+'status','POST',{},status['csrf'])[0]==405
      assert request(admin,origin,URL+'check','POST',
        {'confirmed':True,'date':'2026-10-09'})[0]==403
      assert request(admin,origin,URL+'check','POST',
        {'confirmed':True,'date':'2026-10-09'},status['csrf'],
        browser_origin='http://malicious.example')[0]==403
      assert request(admin,origin,URL+'check','POST',
        {'confirmed':True,'date':'2026-10-09'},status['csrf'])[0]==503
      assert request(admin,origin,URL+'backfill','POST',
        {'confirmed':True,'date':'2026-10-09'},status['csrf'])[0]==503
      assert request(admin,origin,URL+'start','POST',
        {'confirmed':True,'date':'2026-10-09','service':'worker'},status['csrf'])[0]==503
      # Browser supplied executable paths and shell arguments never escape.
      assert request(admin,origin,URL+'check','POST',
        {'confirmed':True,'date':'2026-10-09','binary':'/bin/sh'},status['csrf'])[0]==503
      assert request(anonymous,origin,URL+'start','POST',
        {'confirmed':True,'date':'2026-10-09','service':'worker'},status['csrf'])[0]==401
      assert not list(runtime.glob('*index*'))
      print('PASS index web HTTP: same-origin administrator CSRF, disabled-by-default, no browser shell or worker start')
    finally:
      server.terminate();server.communicate(timeout=5)
if __name__=='__main__':main()
