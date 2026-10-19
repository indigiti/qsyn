<?php
declare(strict_types=1);
namespace QSYN\MarketData;
use QSYN\Admin\RustAdmin;

/**
 * Signed discovery proof + admin CSRF -> existing Rust qsyn-stream history.
 * Browsers cannot turn an arbitrary key into a private broker fetch.
 */
final class UpstoxInstrumentHistoryApi
{
    public static function validDay(mixed $raw): bool
    {
        if(!is_string($raw)||!preg_match('/\A20[0-9]{2}-[0-9]{2}-[0-9]{2}\z/D',$raw))
            return false;
        $date=\DateTimeImmutable::createFromFormat('!Y-m-d',$raw,new \DateTimeZone('Asia/Kolkata'));
        if($date===false||$date->format('Y-m-d')!==$raw)return false;
        return $raw>='2022-01-01'
            && $date<=(new \DateTimeImmutable('now',new \DateTimeZone('Asia/Kolkata')))->setTime(0,0);
    }
    /** One-use Rust WebSocket ticket; no bearer leaves the PHP private store. */
    public static function liveTicket(array $server): array
    {
        if(($server['REQUEST_METHOD']??'GET')!=='POST')
            return [405,['error'=>'method_not_allowed']];
        if(!RustAdmin::originAllowed($server))
            return [403,['error'=>'upstox_live_origin_denied']];
        RustAdmin::boot();
        if(!RustAdmin::authenticated())return [401,['error'=>'admin_login_required']];
        if(getenv('QSYN_TRADING_ENABLED')==='1'
            ||getenv('QSYN_ENABLE_LIVE_TRADING')==='1')
            return [503,['error'=>'live_chart_safety_gate_denied']];
        if(!RustAdmin::verifyCsrf((string)($server['HTTP_X_CSRF_TOKEN']??'')))
            return [403,['error'=>'upstox_live_csrf_denied']];
        if(!preg_match('~\\Aapplication/json(?:\\s*;|$)~i',
            (string)($server['CONTENT_TYPE']??'')))
            return [415,['error'=>'invalid_content_type']];
        $raw=file_get_contents('php://input',false,null,0,768);
        if(!is_string($raw)||strlen($raw)>767)
            return [413,['error'=>'live_selection_too_large']];
        try{$data=json_decode($raw,true,5,JSON_THROW_ON_ERROR);}
        catch(\Throwable){return [400,['error'=>'invalid_live_selection']];}
        if(!is_array($data)||array_keys($data)!==['scope']
            ||!is_string($data['scope']))
            return [422,['error'=>'invalid_live_scope']];
        $token=IndexHistoricalProof::privateToken();
        if($token===null)return [409,['error'=>'upstox_analytics_token_not_ready']];
        $key=UpstoxInstrumentSearch::verifyScope(
            $data['scope'],$token,RustAdmin::csrf(),time());
        if($key===null)return [403,['error'=>'expired_or_invalid_instrument_selection']];
        // The legacy seven index subscriptions must stay on their old route.
        if(in_array($key,[
            'NSE_INDEX|Nifty 50','NSE_INDEX|Nifty Bank',
            'NSE_INDEX|Nifty Fin Service','NSE_INDEX|Nifty Mid Select',
            'NSE_INDEX|India VIX','BSE_INDEX|SENSEX','BSE_INDEX|BANKEX',
        ],true))return [422,['error'=>'use_existing_index_live_chart']];
        $part=rtrim(strtr(base64_encode(json_encode([
            'instrument_key'=>$key,'exp'=>time()+35,
            'nonce'=>bin2hex(random_bytes(16))
        ],JSON_THROW_ON_ERROR)),'+/','-_'),'=');
        return [200,[
            'schema'=>'QSYN-UPSTOX-INSTRUMENT-RUST-TICKET/1',
            'instrument_key'=>$key,'ticket'=>$part.'.'.hash_hmac('sha256',$part,$token),
            'websocket_path'=>'/qsyn/ws/personal-index',
            'expires_in_seconds'=>35,'trading_enabled'=>false,
        ]];
    }

    public static function dispatch(array $server,?callable $runner=null): array
    {
        if(($server['REQUEST_METHOD']??'GET')!=='POST')
            return [405,['error'=>'method_not_allowed']];
        if(!RustAdmin::originAllowed($server))
            return [403,['error'=>'upstox_history_origin_denied']];
        RustAdmin::boot();
        if(!RustAdmin::authenticated())return [401,['error'=>'admin_login_required']];
        if(!RustAdmin::verifyCsrf((string)($server['HTTP_X_CSRF_TOKEN']??'')))
            return [403,['error'=>'upstox_history_csrf_denied']];
        if(!preg_match('~\Aapplication/json(?:\s*;|$)~i',
            (string)($server['CONTENT_TYPE']??'')))
            return [415,['error'=>'invalid_content_type']];
        $raw=file_get_contents('php://input',false,null,0,1025);
        if(!is_string($raw)||strlen($raw)>1024)
            return [413,['error'=>'history_request_too_large']];
        try{$request=json_decode($raw,true,5,JSON_THROW_ON_ERROR);}
        catch(\Throwable){return [400,['error'=>'invalid_history_request']];}
        if(!is_array($request)||array_keys($request)!==['scope','day']||
           !is_string($request['scope'])||!self::validDay($request['day']??null))
            return [422,['error'=>'invalid_upstox_history_scope']];
        $token=IndexHistoricalProof::privateToken();
        if($token===null)return [409,['error'=>'upstox_analytics_token_not_ready']];
        $key=UpstoxInstrumentSearch::verifyScope(
            $request['scope'],$token,RustAdmin::csrf(),time());
        if($key===null)return [403,['error'=>'expired_or_invalid_instrument_selection']];
        $bars=$runner?$runner($key,$request['day']):
            PersonalIndexGateway::instrumentHistory($key,$request['day']);
        if(!is_array($bars)||($bars['schema']??null)!=='QSYN-UPSTOX-INSTRUMENT-HISTORY/1'
            ||($bars['source']??null)!=='upstox_v3_private_instrument_history'
            ||($bars['instrument_key']??null)!==$key
            ||($bars['day_ist']??null)!==$request['day']
            ||($bars['interval']??null)!=='1m'
            ||($bars['trading_enabled']??null)!==false
            ||($bars['public_redistribution_allowed']??null)!==false
            ||($bars['live_feed_verified']??null)!==false
            ||!is_array($bars['bars']??null)||count($bars['bars'])>1800)
            return [502,['error'=>'rust_instrument_history_invalid_or_unavailable']];
        return [200,$bars];
    }
}
