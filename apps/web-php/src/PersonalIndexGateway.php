<?php
declare(strict_types=1);

namespace QSYN\MarketData;

use QSYN\Admin\RustAdmin;

/** Existing admin gate -> existing qsyn-stream ELF. No OAuth or worker plan. */
final class PersonalIndexGateway
{
    private const SYMBOLS=['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY','INDIAVIX','SENSEX','BANKEX'];
    private static function deny(string $code,int $status=503):array
    {
        return [$status,['error'=>$code,'trading_enabled'=>false]];
    }
    private static function readRequest(array $server,bool $ownerViewer=false):array
    {
        if (($server['REQUEST_METHOD']??'GET')!=='POST')
            return [405,null];
        if (!RustAdmin::originAllowed($server))return [403,null];
        if ($ownerViewer) {
            // This is NOT an anonymous public feed: exact owner IP + pinned
            // hostname + explicit opt-in are checked on every request.
            if (!PersonalIndexViewer::allowed($server))return [403,null];
            if (($server['HTTP_X_QSYN_VIEW_ONLY']??'')!=='1')return [403,null];
        } else {
            RustAdmin::boot();
            if (!RustAdmin::authenticated())return [401,null];
        }
        if (getenv('QSYN_TRADING_ENABLED')==='1'
            || getenv('QSYN_ENABLE_LIVE_TRADING')==='1'
            || getenv('QSYN_PERSONAL_INDEX_ENABLED')==='0')
            return [503,null];
        if (!$ownerViewer && !RustAdmin::verifyCsrf((string)($server['HTTP_X_CSRF_TOKEN']??'')))
            return [403,null];
        if (!preg_match('~\Aapplication/json(?:\s*;|$)~i',
            (string)($server['CONTENT_TYPE']??'')))return [415,null];
        $raw=file_get_contents('php://input',false,null,0,513);
        if (!is_string($raw)||strlen($raw)>512)return [413,null];
        try{$body=json_decode($raw,true,5,JSON_THROW_ON_ERROR);}
        catch(\Throwable){return [400,null];}
        if (!is_array($body)||array_is_list($body)||!is_string($body['symbol']??null)
            || !in_array($body['symbol'],self::SYMBOLS,true))return [422,null];
        return [200,$body];
    }
    private static function runtime():?string
    {
        $root=(string)(getenv('QSYN_RUNTIME_DIR')?:dirname(__DIR__,2).'/runtime');
        if (!str_starts_with($root,'/')||str_contains($root,'/..')
            || str_contains($root,'//')||is_link($root)
            || realpath($root)!==$root
            || preg_match('~/(?:public_html|webroot|www)(?:/|$)~i',$root))
            return null;
        return $root;
    }
    public static function ticket(array $server,bool $ownerViewer=false):array
    {
        [$status,$body]=self::readRequest($server,$ownerViewer);
        if ($status!==200)return self::deny('personal_index_request_denied',$status);
        if (count($body)!==1)return self::deny('invalid_personal_index_scope',422);
        $token=IndexHistoricalProof::privateToken();
        if ($token===null)return self::deny('upstox_analytics_token_not_ready',409);
        $payload=json_encode([
            'symbol'=>$body['symbol'],'exp'=>time()+35,
            'nonce'=>bin2hex(random_bytes(16))
        ],JSON_THROW_ON_ERROR);
        $part=rtrim(strtr(base64_encode($payload),'+/','-_'),'=');
        $signature=hash_hmac('sha256',$part,$token);
        return [200,[
            'schema'=>'QSYN-PERSONAL-INDEX-RUST-TICKET/1',
            'symbol'=>$body['symbol'],'expires_in_seconds'=>35,
            'ticket'=>$part.'.'.$signature,
            'websocket_path'=>'/qsyn/ws/personal-index',
            'source'=>'rust_upstox_v3','trading_enabled'=>false
        ]];
    }
    /** Fixed Rust subprocess, never a client-selected command/path/secret. */
    private static function invoke(array $command):?array
    {
        if (!function_exists('proc_open')||!function_exists('proc_get_status')
            ||!function_exists('proc_terminate')||!function_exists('proc_close'))
            return null;
        $pipes=[];
        $proc=@proc_open($command,[
            0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']
        ],$pipes,null,null,['bypass_shell'=>true]);
        if (!is_resource($proc))return null;
        fclose($pipes[0]);
        stream_set_blocking($pipes[1],false);
        stream_set_blocking($pipes[2],false);
        $out='';$deadline=microtime(true)+19;
        $success=false;
        try{
            while(microtime(true)<$deadline){
                $out.=(string)stream_get_contents($pipes[1],8192);
                // Never return stderr: it may contain provider details.
                stream_get_contents($pipes[2],4096);
                if(strlen($out)>110000){proc_terminate($proc);break;}
                $state=proc_get_status($proc);
                if(!$state['running']){
                    // A normal full-session payload easily exceeds one 8 KiB
                    // read. The child may exit after writing its final bytes;
                    // always drain the remaining pipe before JSON decoding.
                    // Otherwise genuine Rust history is silently truncated.
                    $remaining=110001-strlen($out);
                    if($remaining>0) {
                        $tail=stream_get_contents($pipes[1],$remaining);
                        if(is_string($tail))$out.=$tail;
                    }
                    stream_get_contents($pipes[2],4096);
                    $success=$state['exitcode']===0 && strlen($out)<=110000;
                    break;
                }
                usleep(30000);
            }
            if(!$success)@proc_terminate($proc);
        }finally{
            foreach([1,2] as $n)fclose($pipes[$n]);
            @proc_close($proc);
        }
        if(!$success||strlen($out)<20||strlen($out)>110000)return null;
        try{$data=json_decode($out,true,12,JSON_THROW_ON_ERROR);}
        catch(\Throwable){return null;}
        return is_array($data)?$data:null;
    }
    public static function history(array $server,bool $ownerViewer=false):array
    {
        [$status,$body]=self::readRequest($server,$ownerViewer);
        if($status!==200)return self::deny('personal_index_request_denied',$status);
        if(count($body)!==2||!is_string($body['day']??null))
            return self::deny('invalid_personal_history_scope',422);
        $day=$body['day'];
        if(!preg_match('/\A20[0-9]{2}-[0-9]{2}-[0-9]{2}\z/D',$day))
            return self::deny('invalid_personal_history_day',422);
        $token=IndexHistoricalProof::privateToken();
        if($token===null)return self::deny('upstox_analytics_token_not_ready',409);
        // The bearer remains on disk; PHP passes only symbol, day and the
        // fixed owner-private runtime path to the Rust CLI.
        unset($token);
        $runtime=self::runtime();
        $binary=dirname(__DIR__).'/bin/qsyn-stream';
        if($runtime===null||!is_file($binary)||!is_executable($binary)
            ||is_link($binary))return self::deny('rust_personal_index_unavailable');
        $result=self::invoke([
            $binary,'mode','qsyn-upstox-index-worker','personal-history',
            $body['symbol'],$day,$runtime
        ]);
        if(($result['schema']??null)!=='QSYN-UPSTOX-RUST-INDEX-HISTORY/1'
            ||($result['symbol']??null)!==$body['symbol']
            ||($result['day_ist']??null)!==$day
            ||($result['interval']??null)!=='1m'
            ||($result['source']??null)!=='upstox_v3_rust_history'
            ||($result['public_redistribution_allowed']??null)!==false
            ||($result['trading_enabled']??null)!==false
            ||!is_array($result['bars']??null)
            ||count($result['bars'])>400)
            return self::deny('rust_personal_history_invalid_or_unavailable',502);
        return [200,$result];
    }
}
