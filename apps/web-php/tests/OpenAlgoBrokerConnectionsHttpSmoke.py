#!/usr/bin/env python3
"""OpenAlgo browser connection endpoint smoke; tests no live broker service."""
import os
from pathlib import Path
import tempfile
from IdentityHttpSmoke import (FAKE_PASSWORD, await_server, client, fixture,
                               open_port, php_server, request)

API = '/qsyn/api/v1/brokers/openalgo/'

def main():
    with tempfile.TemporaryDirectory(prefix='qsyn-broker-browser-') as folder:
        root = Path(folder) / 'identities'
        sessions = Path(folder) / 'sessions'
        root.mkdir(mode=0o700)
        sessions.mkdir(mode=0o700)
        env = {**os.environ, 'QSYN_ENV':'test','QSYN_ALLOW_HTTP_TEST':'1',
               'QSYN_IDENTITY_ENABLED':'1','QSYN_IDENTITY_STORAGE_DIR':str(root),
               'QSYN_OPENALGO_BROWSER_CONNECT_ENABLED':'1'}
        fixture(env, root, 'create','tenant-one','alice',FAKE_PASSWORD,'member')
        port = open_port()
        origin = f'http://127.0.0.1:{port}'
        p = php_server(env,sessions,port)
        try:
            await_server(origin)
            visitor,_ = client()
            code, catalog, headers = request(visitor,origin,API+'catalog')
            assert code == 200 and 'upstox' in catalog['brokers']
            assert catalog['trading_enabled'] is False and 'no-store' in headers['Cache-Control']
            assert request(visitor,origin,API+'accounts')[0] == 401
            assert request(visitor,origin,API+'status?account_id=upstox-a')[0] == 401
            state = request(visitor,origin,'/qsyn/api/v1/auth/state')[1]
            code,signed,_ = request(visitor,origin,'/qsyn/api/v1/auth/login','POST',
                                      {'tenant':'tenant-one','username':'alice','password':FAKE_PASSWORD},
                                      state['csrf'])
            assert code == 200, signed
            # Neither missing private registry nor forged request creates any connection.
            code,payload,_=request(visitor,origin,API+'accounts')
            assert code == 503 and payload['error']=='private_broker_registry_unavailable'
            assert request(visitor,origin,API+'connect','POST',
                           {'account_id':'upstox-a'},signed['csrf'])[0]==503
            assert request(visitor,origin,API+'catalog','POST',{})[0]==405
            print('PASS OpenAlgo browser catalog, default isolation, no registry fail-closed')
        finally:
            p.terminate()
            p.communicate(timeout=5)
if __name__=='__main__':
    main()
