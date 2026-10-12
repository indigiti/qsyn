<?php
declare(strict_types=1);

namespace QSYN\MarketData;

use QSYN\Admin\RustAdmin;

/**
 * Single read-only market-data proof, before any chart / worker activation.
 *
 * Only the two fixed candidate NSE/BSE index keys are queried. A successful
 * broker GET is evidence of that historical endpoint, never of viewer display
 * rights, a current BOD attestation, streaming, or redistribution permission.
 */
final class IndexHistoricalProof
{
    private const SCHEMA = 'QSYN-INDEX-HISTORICAL-PROOF/1';
    private const KEYS = [
        'NIFTY' => 'NSE_INDEX|Nifty 50',
        'SENSEX' => 'BSE_INDEX|SENSEX',
    ];
    // Fixed personal market-data catalog; no key, token or URL from the browser.
    private const PERSONAL_KEYS = [
        'NIFTY' => 'NSE_INDEX|Nifty 50',
        'BANKNIFTY' => 'NSE_INDEX|Nifty Bank',
        'FINNIFTY' => 'NSE_INDEX|Nifty Fin Service',
        'MIDCPNIFTY' => 'NSE_INDEX|Nifty Mid Select',
        'INDIAVIX' => 'NSE_INDEX|India VIX',
        'SENSEX' => 'BSE_INDEX|SENSEX',
        'BANKEX' => 'BSE_INDEX|BANKEX',
    ];

    private static function secureFile(string $path, int $max): bool
    {
        $stat = @lstat($path);
        return $stat !== false && is_file($path) && !is_link($path)
            && ($stat['mode'] & 0077) === 0
            && $stat['size'] > 20 && $stat['size'] <= $max
            && (!function_exists('posix_geteuid') || $stat['uid'] === posix_geteuid());
    }

    public static function privateToken(): ?string
    {
        $runtime = (string)(getenv('QSYN_RUNTIME_DIR') ?: dirname(__DIR__, 2).'/runtime');
        if (!str_starts_with($runtime, '/') || str_contains($runtime, '/..')
            || str_contains($runtime, '//')
            || preg_match('~/(?:public_html|webroot|www)(?:/|$)~i', $runtime)
            || realpath($runtime) !== $runtime || is_link($runtime)) return null;
        $root = $runtime.'/upstox-private';
        $stat = @lstat($root);
        if (!$stat || !is_dir($root) || is_link($root)
            || realpath($root) !== $root || ($stat['mode'] & 0077) !== 0
            || (function_exists('posix_geteuid') && $stat['uid'] !== posix_geteuid()))
            return null;

        $expected = getenv('QSYN_UPSTOX_ANALYTICS_EXPECTED_USER_ID');
        if (!is_string($expected) || $expected === '') {
            $app = $root.'/upstox-app.json';
            if (!self::secureFile($app, 2048)) return null;
            $settings = json_decode((string)@file_get_contents($app), true);
            if (($settings['schema'] ?? '') !== 'QSYN-UPSTOX-WEB-APP/1') return null;
            $expected = $settings['expected_user_id'] ?? null;
        }
        if (!is_string($expected)
            || !preg_match('/\A[A-Za-z0-9_.@-]{2,128}\z/D', $expected)) return null;
        // Prefer the long-lived read-only Analytics credential. Do not attempt
        // to trade or reuse the token in browser JS / query strings.
        $path = $root.'/upstox-analytics-session.json';
        if (!self::secureFile($path, 16384)) return null;
        try {
            $data=json_decode((string)file_get_contents($path), true, 12, JSON_THROW_ON_ERROR);
        } catch (\Throwable) { return null; }
        if (!is_array($data) || array_is_list($data) || count($data) !== 8
            || ($data['schema'] ?? '') !== 'QSYN-UPSTOX-ANALYTICS-SESSION/1'
            || ($data['broker'] ?? '') !== 'upstox'
            || ($data['user_id'] ?? '') !== $expected
            || ($data['order_routing_enabled'] ?? null) !== false
            || ($data['display_entitlement_verified'] ?? null) !== false
            || ($data['retention_entitlement_verified'] ?? null) !== false
            || !is_string($data['created_at'] ?? null)
            || !is_string($data['access_token'] ?? null)) return null;
        $token=$data['access_token'];
        return strlen($token) >= 20 && strlen($token) <= 8192
            && preg_match('/\A[A-Za-z0-9._~+\/=\-]+\z/D', $token) === 1
            ? $token : null;
    }

    private static function suggestedDay(): string
    {
        $day=(new \DateTimeImmutable('now',new \DateTimeZone('Asia/Kolkata')))
            ->setTime(0,0)->modify('-1 day');
        while ((int)$day->format('N') > 5) $day=$day->modify('-1 day');
        return $day->format('Y-m-d');
    }

    private static function validDay(mixed $day): bool
    {
        if (!is_string($day) || !preg_match('/\A20[0-9]{2}-[0-9]{2}-[0-9]{2}\z/D', $day))
            return false;
        $tz=new \DateTimeZone('Asia/Kolkata');
        $dt=\DateTimeImmutable::createFromFormat('!Y-m-d',$day,$tz);
        $today=(new \DateTimeImmutable('now',$tz))->setTime(0,0);
        return $dt !== false && $dt->format('Y-m-d') === $day
            && $dt < $today && $dt >= $today->modify('-30 days')
            && (int)$dt->format('N') <= 5;
    }

    /** Fixed Upstox host, HTTPS only, bounded response, no redirects. */
    private static function request(string $url, string $token): array
    {
        if (!str_starts_with($url,'https://api.upstox.com/v3/historical-candle/')
            && !str_starts_with($url,'https://api.upstox.com/v3/market-quote/ohlc?'))
            throw new \RuntimeException('history_url_not_allowed');
        if (!function_exists('curl_init')) throw new \RuntimeException('curl_unavailable');
        $ch=curl_init($url);
        if ($ch === false) throw new \RuntimeException('curl_unavailable');
        $response='';
        try {
            curl_setopt_array($ch,[
                CURLOPT_HTTPGET=>true,
                CURLOPT_HTTPHEADER=>['Authorization: Bearer '.$token,'Accept: application/json'],
                CURLOPT_RETURNTRANSFER=>false,
                CURLOPT_CONNECTTIMEOUT=>4, CURLOPT_TIMEOUT=>15,
                CURLOPT_FOLLOWLOCATION=>false,
                CURLOPT_SSL_VERIFYHOST=>2, CURLOPT_SSL_VERIFYPEER=>true,
                CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,
                CURLOPT_WRITEFUNCTION=>static function($handle,string $chunk) use (&$response):int {
                    if (strlen($response)+strlen($chunk)>524288) return 0;
                    $response.=$chunk;
                    return strlen($chunk);
                },
            ]);
            $ok=curl_exec($ch);
            $status=(int)curl_getinfo($ch,CURLINFO_HTTP_CODE);
            if ($ok === false) return ['http_status'=>0,'body'=>null];
            $decoded=json_decode($response,true,12);
            return ['http_status'=>$status,'body'=>is_array($decoded)?$decoded:null];
        } finally { curl_close($ch); }
    }

    /** Parse only actual Upstox-shaped candles. Never return OHLC or provider errors. */
    public static function summarize(string $symbol, string $day, array $result): array
    {
        if (!array_key_exists($symbol,self::KEYS) || !self::validDay($day))
            throw new \InvalidArgumentException('invalid_history_proof_scope');
        $http=$result['http_status']??0;
        $base=[
            'schema'=>self::SCHEMA,'symbol'=>$symbol,'day_ist'=>$day,
            'provider_http_status'=>is_int($http)?$http:0,
            'candle_count'=>0,'history_verified'=>false,
            'display_rights_verified'=>false,'live_feed_verified'=>false,
            'trading_enabled'=>false,
        ];
        if ($http!==200) {
            return $base+['code'=>match($http) {
                401,403=>'UPSTOX_HISTORY_AUTH_DENIED',
                404,422=>'UPSTOX_HISTORY_KEY_OR_DATE_REJECTED',
                429=>'UPSTOX_HISTORY_RATE_LIMITED',
                default=>'UPSTOX_HISTORY_PROVIDER_UNAVAILABLE',
            }];
        }
        $bars=UpstoxIndexV3::normalize($result['body']??[],'1m',time(),400);
        $tz=new \DateTimeZone('Asia/Kolkata');
        foreach ($bars as $bar) {
            $actual=(new \DateTimeImmutable('@'.$bar['time']))
                ->setTimezone($tz)->format('Y-m-d');
            if ($actual!==$day) throw new \RuntimeException('different_day');
        }
        $count=count($bars);
        return array_merge($base,[
            'code'=>$count?'UPSTOX_HISTORY_CANDLES_VERIFIED':'UPSTOX_HISTORY_NO_CANDLES',
            'provider_http_status'=>200,'candle_count'=>$count,
            'first_candle_utc'=>$count?gmdate('c',$bars[0]['time']):null,
            'last_candle_utc'=>$count?gmdate('c',$bars[$count-1]['time']):null,
            'history_verified'=>$count>0,
        ]);
    }

    /**
     * Account-owner-only historical view. This endpoint is never used by the
     * public homepage, provides no WSS, and cannot grant redistribution rights.
     */
    public static function dispatchPrivateChart(array $server, ?callable $transport = null): array
    {
        if (($server['REQUEST_METHOD']??'GET')!=='POST')
            return [405,['error'=>'method_not_allowed']];
        if (!RustAdmin::originAllowed($server))
            return [403,['error'=>'secure_same_origin_required']];
        RustAdmin::boot();
        if (!RustAdmin::authenticated())
            return [401,['error'=>'admin_login_required']];
        if (getenv('QSYN_TRADING_ENABLED')==='1'
            || getenv('QSYN_ENABLE_LIVE_TRADING')==='1'
            || getenv('QSYN_INDEX_PRIVATE_HISTORY_CHART_ENABLED')==='0')
            return [503,['error'=>'private_chart_disabled']];
        if (!RustAdmin::verifyCsrf((string)($server['HTTP_X_CSRF_TOKEN']??'')))
            return [403,['error'=>'csrf_invalid']];
        if (!preg_match('~\Aapplication/json(?:\s*;|$)~i',
            (string)($server['CONTENT_TYPE']??'')))
            return [415,['error'=>'json_required']];
        $raw=file_get_contents('php://input',false,null,0,513);
        if (!is_string($raw)||strlen($raw)>512)
            return [413,['error'=>'request_too_large']];
        try { $body=json_decode($raw,true,4,JSON_THROW_ON_ERROR); }
        catch (\Throwable) { return [400,['error'=>'invalid_json']]; }
        if (!is_array($body)||array_is_list($body)||count($body)!==4
            || ($body['confirmed']??null)!==true
            || ($body['private_view_acknowledged']??null)!==true
            || !is_string($body['symbol']??null)
            || !array_key_exists($body['symbol'],self::PERSONAL_KEYS)
            || !(self::validDay($body['day']??null) ||
                 (($body['day']??null)===self::todayIst() && self::isWeekdayIst())))
            return [422,['error'=>'invalid_private_chart_scope']];
        $token=self::privateToken();
        if ($token===null) return [409,['error'=>'upstox_analytics_token_not_ready']];
        $key=self::PERSONAL_KEYS[$body['symbol']];
        $day=$body['day'];
        $url=$day===self::todayIst()
            ? 'https://api.upstox.com/v3/historical-candle/intraday/'.rawurlencode($key).'/minutes/1'
            : 'https://api.upstox.com/v3/historical-candle/'.rawurlencode($key).'/minutes/1/'.$day.'/'.$day;
        try {
            $provider=$transport?$transport($url,$token):self::request($url,$token);
            if (!is_array($provider)) throw new \RuntimeException('invalid_provider');
            if (($provider['http_status']??0)!==200) {
                return [502,['error'=>'private_upstox_history_unavailable',
                    'provider_http_status'=>(int)($provider['http_status']??0)]];
            }
            $bars=UpstoxIndexV3::normalize($provider['body']??[],'1m',time(),400);
            $tz=new \DateTimeZone('Asia/Kolkata');
            foreach ($bars as $bar) {
                if ((new \DateTimeImmutable('@'.$bar['time']))
                    ->setTimezone($tz)->format('Y-m-d')!==$day)
                    throw new \RuntimeException('invalid_candle_day');
            }
            if (!$bars) return [404,['error'=>'no_private_history_for_date']];
            return [200,[
                'schema'=>'QSYN-PRIVATE-UPSTOX-HISTORY-CHART/1',
                'source'=>'upstox_private_analytics_history',
                'exchange'=>in_array($body['symbol'], ['SENSEX','BANKEX'], true)?'BSE_INDEX':'NSE_INDEX',
                'symbol'=>$body['symbol'],'interval'=>'1m','day_ist'=>$day,
                'bars'=>$bars,'account_scoped'=>true,
                'personal_private_view_only'=>true,
                'public_redistribution_allowed'=>false,
                'display_rights_approved_by_app'=>false,
                'live_stream_verified'=>false,'trading_enabled'=>false,
            ]];
        } catch (\Throwable) {
            return [502,['error'=>'private_upstox_history_invalid']];
        }
    }


    private static function todayIst(): string
    {
        return (new \DateTimeImmutable('now',new \DateTimeZone('Asia/Kolkata')))
            ->format('Y-m-d');
    }

    private static function isWeekdayIst(): bool
    {
        return (int)(new \DateTimeImmutable('now',new \DateTimeZone('Asia/Kolkata')))
            ->format('N') <= 5;
    }

    /**
     * Normalize provider-supplied 1m candles, preserving the provider candle
     * start timestamp. No browser-clock synthetic bars or OAuth/worker plans.
     */
    public static function normalizePersonalOhlc(string $symbol, array $response, int $nowMs): array
    {
        if (!array_key_exists($symbol,self::PERSONAL_KEYS))
            throw new \InvalidArgumentException('unknown_index');
        $data=$response['data']??null;
        if (($response['status']??null)!=='success' || !is_array($data))
            throw new \RuntimeException('invalid_quote_payload');
        $key=self::PERSONAL_KEYS[$symbol];
        $matches=array_values(array_filter($data,static fn($v)=>
            is_array($v)&&($v['instrument_token']??null)===$key));
        if (count($matches)!==1) throw new \RuntimeException('index_instrument_mismatch');
        $quote=$matches[0];
        $result=[];
        foreach (['prev_ohlc','live_ohlc'] as $field) {
            $c=$quote[$field]??null;
            if (!is_array($c)) continue;
            $ms=$c['ts']??null;
            if (!is_int($ms) || $ms<1_600_000_000_000 || $ms%60000!==0 ||
                $ms>$nowMs+5000 || $nowMs-$ms>180000) continue;
            foreach (['open','high','low','close','volume'] as $v) {
                if (!is_int($c[$v]??null) && !is_float($c[$v]??null))
                    throw new \RuntimeException('invalid_index_ohlc');
            }
            if ($c['low']<=0 || $c['open']<=0 || $c['close']<=0 ||
                $c['high']<max($c['open'],$c['close']) ||
                $c['low']>min($c['open'],$c['close']) || $c['volume']<0)
                throw new \RuntimeException('invalid_index_ohlc');
            $date=(new \DateTimeImmutable('@'.intdiv($ms,1000)))
                ->setTimezone(new \DateTimeZone('Asia/Kolkata'))->format('Y-m-d');
            if ($date!==self::todayIst()) continue;
            $result[intdiv($ms,1000)]=[
                'time'=>intdiv($ms,1000),'open'=>$c['open'],'high'=>$c['high'],
                'low'=>$c['low'],'close'=>$c['close'],'volume'=>$c['volume']
            ];
        }
        ksort($result,SORT_NUMERIC);
        return array_values($result);
    }

    /**
     * Personal 1-minute Upstox market quote (GET upstream, POST admin-CSRF
     * on QSYN). Uses only the existing Analytics Token and never starts Rust.
     */
    public static function dispatchPersonalQuote(array $server, ?callable $transport=null): array
    {
        if (($server['REQUEST_METHOD']??'GET')!=='POST')
            return [405,['error'=>'method_not_allowed']];
        if (!RustAdmin::originAllowed($server))
            return [403,['error'=>'secure_same_origin_required']];
        RustAdmin::boot();
        if (!RustAdmin::authenticated())
            return [401,['error'=>'admin_login_required']];
        if (getenv('QSYN_INDEX_PERSONAL_QUOTE_ENABLED')==='0')
            return [503,['error'=>'index_quote_disabled']];
        if (!RustAdmin::verifyCsrf((string)($server['HTTP_X_CSRF_TOKEN']??'')))
            return [403,['error'=>'csrf_invalid']];
        if (!preg_match('~\Aapplication/json(?:\s*;|$)~i',
            (string)($server['CONTENT_TYPE']??'')))
            return [415,['error'=>'json_required']];
        $raw=file_get_contents('php://input',false,null,0,257);
        if (!is_string($raw)||strlen($raw)>256)
            return [413,['error'=>'request_too_large']];
        try {$input=json_decode($raw,true,4,JSON_THROW_ON_ERROR);}
        catch (\Throwable) {return [400,['error'=>'invalid_json']];}
        if (!is_array($input)||array_is_list($input)||count($input)!==1
            || !is_string($input['symbol']??null)
            || !array_key_exists($input['symbol'],self::PERSONAL_KEYS))
            return [422,['error'=>'invalid_personal_index_symbol']];
        $token=self::privateToken();
        if ($token===null) return [409,['error'=>'upstox_analytics_token_not_ready']];
        $symbol=$input['symbol'];
        $url='https://api.upstox.com/v3/market-quote/ohlc?'
            .http_build_query(['instrument_key'=>self::PERSONAL_KEYS[$symbol],
                               'interval'=>'I1'],'','&',PHP_QUERY_RFC3986);
        $nowMs=(int)round(microtime(true)*1000);
        try{
            $received=$transport?$transport($url,$token):self::request($url,$token);
            if (!is_array($received)||($received['http_status']??null)!==200)
                return [502,['error'=>'upstox_personal_quote_unavailable',
                    'provider_http_status'=>(int)($received['http_status']??0)]];
            $bars=self::normalizePersonalOhlc($symbol,$received['body']??[],$nowMs);
            return [200,[
                'schema'=>'QSYN-UPSTOX-PERSONAL-OHLC/1',
                'symbol'=>$symbol,'interval'=>'1m',
                'source'=>'upstox_analytics_token_market_quote_v3',
                'code'=>$bars?'FRESH_EXCHANGE_OHLC':'NO_FRESH_EXCHANGE_OHLC',
                'bars'=>$bars,'personal_view_only'=>true,
                'trading_enabled'=>false,'public_redistribution_allowed'=>false
            ]];
        }catch (\Throwable) {
            return [502,['error'=>'upstox_personal_quote_invalid']];
        }
    }

    /** @return array{0:int,1:array<string,mixed>} */
    public static function dispatch(array $server, ?callable $transport = null): array
    {
        $method=(string)($server['REQUEST_METHOD'] ?? 'GET');
        if (!in_array($method,['GET','POST'],true))
            return [405,['error'=>'method_not_allowed']];
        if (!RustAdmin::originAllowed($server))
            return [403,['error'=>'secure_same_origin_required']];
        RustAdmin::boot();
        if (!RustAdmin::authenticated())
            return [401,['error'=>'admin_login_required']];
        if (getenv('QSYN_TRADING_ENABLED') === '1'
            || getenv('QSYN_ENABLE_LIVE_TRADING') === '1'
            || getenv('QSYN_INDEX_HISTORY_PROOF_ENABLED') === '0')
            return [503,['error'=>'index_history_proof_disabled']];

        if ($method==='GET') return [200,[
            'schema'=>self::SCHEMA,'csrf'=>RustAdmin::csrf(),
            'token_present'=>self::privateToken()!==null,
            'suggested_day_ist'=>self::suggestedDay(),
            'symbols'=>array_keys(self::KEYS),
            'history_verified'=>false,'display_rights_verified'=>false,
            'live_feed_verified'=>false,'trading_enabled'=>false,
        ]];
        if (!RustAdmin::verifyCsrf((string)($server['HTTP_X_CSRF_TOKEN'] ?? '')))
            return [403,['error'=>'csrf_invalid']];
        if (!preg_match('~\Aapplication/json(?:\s*;|$)~i',
            (string)($server['CONTENT_TYPE']??''))) return [415,['error'=>'json_required']];
        $raw=file_get_contents('php://input',false,null,0,512);
        if (!is_string($raw) || strlen($raw)>511)
            return [413,['error'=>'request_too_large']];
        try { $body=json_decode($raw,true,4,JSON_THROW_ON_ERROR); }
        catch (\Throwable) { return [400,['error'=>'invalid_json']]; }
        if (!is_array($body) || array_is_list($body) || count($body)!==3
            || ($body['confirmed']??null)!==true
            || !is_string($body['symbol']??null)
            || !array_key_exists($body['symbol'],self::KEYS)
            || !self::validDay($body['day']??null))
            return [422,['error'=>'invalid_history_proof_request']];
        $token=self::privateToken();
        if ($token === null) return [409,['error'=>'upstox_analytics_token_not_ready']];
        $symbol=$body['symbol'];
        $day=$body['day'];
        $key=self::KEYS[$symbol]; // candidates, not authoritative BOD attestation
        $url='https://api.upstox.com/v3/historical-candle/'
            .rawurlencode($key).'/minutes/1/'.$day.'/'.$day;
        try {
            $result=$transport ? $transport($url,$token) : self::request($url,$token);
            if (!is_array($result)) throw new \RuntimeException('invalid_provider_result');
            return [200,self::summarize($symbol,$day,$result)];
        } catch (\Throwable) {
            return [200,[
                'schema'=>self::SCHEMA,'code'=>'UPSTOX_HISTORY_RESPONSE_INVALID',
                'symbol'=>$symbol,'day_ist'=>$day,'provider_http_status'=>0,
                'candle_count'=>0,'history_verified'=>false,
                'display_rights_verified'=>false,'live_feed_verified'=>false,
                'trading_enabled'=>false,
            ]];
        }
    }
}
