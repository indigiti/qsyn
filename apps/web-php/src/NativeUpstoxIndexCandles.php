<?php
declare(strict_types=1);

namespace QSYN\MarketData;

use QSYN\Admin\RustAdmin;
use QSYN\Broker\NativeUpstoxAnalyticsApi;

/**
 * Personal, administrator-only read-only NSE/BSE candles from Upstox V3.
 * This is NOT the public India-bars API and NOT a redistribution service.
 * Unlike Rust feed ingestion it needs no worker, WSS gateway or chart-ticket
 * issuer to retrieve genuine historical candles for the logged-in operator.
 */
final class NativeUpstoxIndexCandles
{
    private const SCHEMA = 'QSYN-UPSTOX-ADMIN-INDEX-CANDLES/1';
    private const MAP = [
        'NIFTY'=>['NSE_INDEX','NSE','Nifty 50',['Nifty 50','NIFTY 50']],
        'BANKNIFTY'=>['NSE_INDEX','NSE','Nifty Bank',['Nifty Bank','BANK NIFTY']],
        'FINNIFTY'=>['NSE_INDEX','NSE','Nifty Fin Service',['Nifty Fin Service','Nifty Financial Services']],
        'MIDCPNIFTY'=>['NSE_INDEX','NSE','Nifty Mid Select',['Nifty Mid Select','Nifty Midcap Select']],
        'INDIAVIX'=>['NSE_INDEX','NSE','India VIX',['India VIX']],
        'SENSEX'=>['BSE_INDEX','BSE','SENSEX',['SENSEX']],
    ];
    private const PERIODS = [
        '1m'=>['minutes',1],'5m'=>['minutes',5],'15m'=>['minutes',15],
        '1h'=>['hours',1],'1d'=>['days',1],
    ];

    private static function normalized(mixed $name): string
    {
        return is_string($name)
            ? (string)preg_replace('/[^A-Z0-9]+/', '', strtoupper(trim($name))) : '';
    }

    /** Never guess partial matches; index search MUST resolve exactly one
     * instrument on the requested exchange and segment.
     */
    public static function resolveIndex(string $alias, mixed $payload): ?string
    {
        $item = self::MAP[$alias] ?? null;
        if (!$item || !is_array($payload)
            || ($payload['status'] ?? null) !== 'success'
            || !is_array($payload['data'] ?? null)
            || !array_is_list($payload['data'])) return null;
        $valid = [];
        $names = array_map(self::normalized(...), $item[3]);
        foreach ($payload['data'] as $record) {
            if (!is_array($record)
                || ($record['segment'] ?? null) !== $item[0]
                || ($record['exchange'] ?? null) !== $item[1]
                || ($record['instrument_type'] ?? null) !== 'INDEX') continue;
            $key = $record['instrument_key'] ?? null;
            if (!is_string($key) || strlen($key) > 128
                || !preg_match('/\A(?:NSE_INDEX|BSE_INDEX)\|[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}\z/D', $key)
                || !str_starts_with($key, $item[0] . '|')) continue;
            if (!in_array(self::normalized($record['name'] ?? null), $names, true)
                && !in_array(self::normalized($record['trading_symbol'] ?? null), $names, true)
                && !in_array(self::normalized(substr($key, strlen($item[0]) + 1)), $names, true)) continue;
            $valid[$key] = true;
        }
        return count($valid) === 1 ? array_key_first($valid) : null;
    }

    /** Provider returns newest-first rows [timestamp,open,high,low,close,volume,oi].
     * Normalize to strictly increasing exchange-time candles; never synthesize.
     */
    public static function parseCandles(mixed $payload, int $seconds, int $limit, int $now): ?array
    {
        if (!is_array($payload) || ($payload['status'] ?? null) !== 'success'
            || !is_array($payload['data']['candles'] ?? null)
            || count($payload['data']['candles']) > 15000) return null;
        $all=[];
        foreach ($payload['data']['candles'] as $row) {
            if (!is_array($row) || count($row) < 5
                || !is_string($row[0] ?? null)) return null;
            try {$dt = new \DateTimeImmutable($row[0]);}
            catch (\Throwable) {return null;}
            $time = $dt->getTimestamp();
            if ($time <= 0 || $time > $now + 60
                || ($seconds <= 3600 && $time % 60 !== 0)) return null;
            foreach ([1,2,3,4] as $i) {
                if (!is_int($row[$i] ?? null) && !is_float($row[$i] ?? null)) return null;
                if (!is_finite((float)$row[$i]) || $row[$i] <= 0) return null;
            }
            [$open,$high,$low,$close]=array_map(
                static fn(int $i):float=>(float)$row[$i],[1,2,3,4]);
            if ($low > min($open,$close) || $high < max($open,$close)
                || $low > $high) return null;
            $volume=($row[5] ?? 0);
            if (!is_numeric($volume) || (float)$volume < 0) return null;
            $all[$time]=[
                'time'=>$time,'open'=>$open,'high'=>$high,
                'low'=>$low,'close'=>$close,'volume'=>(float)$volume,
            ];
        }
        ksort($all,SORT_NUMERIC);
        return array_slice(array_values($all),-$limit);
    }

    /** Fixed-host GET only, bounded provider replies, no redirects, no client URL. */
    public static function providerGet(string $url, string $token): array
    {
        if (!str_starts_with($url,'https://api.upstox.com/')
            || !function_exists('curl_init')) return [0,null];
        $ch=curl_init($url);
        if ($ch===false) return [0,null];
        try {
            curl_setopt_array($ch,[
                CURLOPT_HTTPGET=>true,CURLOPT_RETURNTRANSFER=>true,
                CURLOPT_FOLLOWLOCATION=>false,CURLOPT_MAXREDIRS=>0,
                CURLOPT_CONNECTTIMEOUT=>4,CURLOPT_TIMEOUT=>11,
                CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_SSL_VERIFYPEER=>true,
                CURLOPT_ENCODING=>'',
                CURLOPT_HTTPHEADER=>[
                    'Accept: application/json',
                    'Authorization: Bearer '.$token,
                ],
                CURLOPT_WRITEFUNCTION=>static function($curl,string $chunk) use (&$buffer):int {
                    $buffer??='';
                    if (strlen($buffer)+strlen($chunk)>3200000) return 0;
                    $buffer.=$chunk;return strlen($chunk);
                },
            ]);
            $buffer='';
            $ok=curl_exec($ch);
            $code=(int)curl_getinfo($ch,CURLINFO_HTTP_CODE);
            if ($ok===false || $code!==200 || strlen($buffer)>3200000)
                return [$code,null];
            try {$data=json_decode($buffer,true,12,JSON_THROW_ON_ERROR);}
            catch (\Throwable) {return [$code,null];}
            return [$code,$data];
        } finally {curl_close($ch);}
    }

    /** Called after admin authentication. Accept only canonical index aliases. */
    public static function read(string $symbol, string $interval, int $limit, callable $get, string $token): array
    {
        if (!isset(self::MAP[$symbol]) || !isset(self::PERIODS[$interval])
            || $limit<1 || $limit>500) return [422,['code'=>'INDEX_REQUEST_INVALID']];
        $item=self::MAP[$symbol];
        $lookup='https://api.upstox.com/v2/instruments/search?'.http_build_query([
            'query'=>$item[2], 'exchanges'=>$item[1],
            'segments'=>'INDEX','page_number'=>1,'records'=>30,
        ],'', '&', PHP_QUERY_RFC3986);
        [$code,$matches]=$get($lookup,$token);
        if ($code===401 || $code===403)
            return [502,['code'=>'UPSTOX_TOKEN_REJECTED_FOR_INDEX']];
        if ($code!==200)return [502,['code'=>'UPSTOX_SEARCH_UNAVAILABLE']];
        $key=self::resolveIndex($symbol,$matches);
        if ($key===null)return [424,['code'=>'UPSTOX_INDEX_KEY_UNRESOLVED']];
        [$unit,$step]=self::PERIODS[$interval];
        $p=rawurlencode($key);
        $urls=[
            "https://api.upstox.com/v3/historical-candle/intraday/$p/$unit/$step",
        ];
        [$latestCode,$latest]=$get($urls[0],$token);
        if ($latestCode===401 || $latestCode===403)
            return [502,['code'=>'UPSTOX_HISTORY_ACCESS_DENIED']];
        if ($latestCode!==200)return [502,['code'=>'UPSTOX_INTRADAY_UNAVAILABLE']];
        $now=time();$seconds=$interval==='1d'?86400:($interval==='1h'?3600:$step*60);
        $recent=self::parseCandles($latest,$seconds,500,$now);
        if ($recent===null)return [502,['code'=>'UPSTOX_INVALID_INTRADAY_CANDLES']];
        // Older Upstox candles are requested only when today's market data
        // isn't enough. A 14-day interval includes weekends and holidays.
        if(count($recent)<$limit){
            $ist=new \DateTimeZone('Asia/Kolkata');
            $today=new \DateTimeImmutable('now',$ist);
            $to=$today->format('Y-m-d');
            $from=$today->modify('-14 days')->format('Y-m-d');
            $url="https://api.upstox.com/v3/historical-candle/$p/$unit/$step/$to/$from";
            [$status,$archive]=$get($url,$token);
            if ($status===200){
                $history=self::parseCandles($archive,$seconds,500,$now);
                if ($history!==null){
                    $byTime=[];
                    foreach (array_merge($history,$recent) as $c)$byTime[$c['time']]=$c;
                    ksort($byTime,SORT_NUMERIC);
                    $recent=array_slice(array_values($byTime),-$limit);
                }
            }
        }
        $recent=array_slice($recent,-$limit);
        return [200,[
            'schema'=>self::SCHEMA,
            'source'=>'upstox_authenticated_personal_history',
            'exchange'=>$item[0],'symbol'=>$symbol,
            'instrument'=>$key,'interval'=>$interval,
            'bars'=>$recent,'count'=>count($recent),
            'last_exchange_timestamp'=>$recent ? end($recent)['time'] : null,
            'provider_authenticated'=>true,
            'live_socket_verified'=>false,
            'public_redistribution_allowed'=>false,
            'trading_enabled'=>false,
        ]];
    }

    public static function dispatch(array $server,array $query,?callable $provider=null): array
    {
        if (($server['REQUEST_METHOD']??'GET')!=='GET')
            return [405,['code'=>'METHOD_NOT_ALLOWED']];
        if (getenv('QSYN_TRADING_ENABLED')==='1'
            || getenv('QSYN_ENABLE_LIVE_TRADING')==='1'
            || getenv('QSYN_CONTROL_ENABLED')==='0'
            || getenv('QSYN_UPSTOX_INDEX_PERSONAL_HISTORY_ENABLED')==='0')
            return [503,['code'=>'PERSONAL_INDEX_HISTORY_DISABLED']];
        if (!RustAdmin::originAllowed($server))return [403,['code'=>'SAME_ORIGIN_REQUIRED']];
        RustAdmin::boot();
        if(!RustAdmin::authenticated())return [401,['code'=>'ADMIN_LOGIN_REQUIRED']];
        if(count($query)>3)return [422,['code'=>'INDEX_REQUEST_INVALID']];
        $symbol=$query['symbol']??'';
        $interval=$query['interval']??'1m';
        $limit=$query['limit']??'300';
        if(!is_string($symbol)||!is_string($interval)||!is_string($limit)
            ||!ctype_digit($limit))return [422,['code'=>'INDEX_REQUEST_INVALID']];
        try {
            return NativeUpstoxAnalyticsApi::withReadOnlyToken(
                static fn(string $token):array=>self::read($symbol,$interval,(int)$limit,
                    $provider??[self::class,'providerGet'],$token));
        }catch(\Throwable){
            return [409,['code'=>'UPSTOX_ANALYTICS_SESSION_NOT_READY']];
        }
    }
}
