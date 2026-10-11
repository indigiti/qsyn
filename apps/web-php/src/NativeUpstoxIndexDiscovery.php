<?php
declare(strict_types=1);

namespace QSYN\Broker;

/**
 * Operator-only, read-only index key discovery from Upstox's authenticated
 * /v2/instruments/search endpoint. Never grants market data / trade rights,
 * writes an index worker plan, or puts the Upstox bearer into a response.
 */
final class NativeUpstoxIndexDiscovery
{
    private const SCHEMA = 'QSYN-UPSTOX-INDEX-DISCOVERY/1';
    private const SEARCH_URL = 'https://api.upstox.com/v2/instruments/search';
    private const TARGETS = [
        'NIFTY' => ['exchange'=>'NSE','segment'=>'NSE_INDEX','query'=>'Nifty 50',
            'aliases'=>['NIFTY','NIFTY50']],
        'BANKNIFTY' => ['exchange'=>'NSE','segment'=>'NSE_INDEX','query'=>'Nifty Bank',
            'aliases'=>['BANKNIFTY','NIFTYBANK']],
        'FINNIFTY' => ['exchange'=>'NSE','segment'=>'NSE_INDEX','query'=>'Nifty Fin Service',
            'aliases'=>['FINNIFTY','NIFTYFINSERVICE']],
        'MIDCPNIFTY' => ['exchange'=>'NSE','segment'=>'NSE_INDEX','query'=>'Nifty Mid Select',
            'aliases'=>['MIDCPNIFTY','NIFTYMIDSELECT']],
        'INDIAVIX' => ['exchange'=>'NSE','segment'=>'NSE_INDEX','query'=>'India VIX',
            'aliases'=>['INDIAVIX']],
        'SENSEX' => ['exchange'=>'BSE','segment'=>'BSE_INDEX','query'=>'SENSEX',
            'aliases'=>['SENSEX']],
    ];

    /** @param ?callable(string,string):array $transport */
    public static function discover(
        string $privateRoot, string $expectedUserId, ?callable $transport = null
    ): array {
        $report = [
            'schema'=>self::SCHEMA,
            'status'=>'unavailable',
            'code'=>'UPSTOX_INDEX_DISCOVERY_NOT_READY',
            'checked_at_utc'=>gmdate('c'),
            'source'=>'authenticated_upstox_instruments_search',
            'session_verified_now'=>false,
            'mapping_fully_resolved'=>false,
            'current_bod_attested'=>false,
            'exchange_display_entitlement_verified'=>false,
            'index_feed_activated'=>false,
            'public_redistribution_allowed'=>false,
            'trading_enabled'=>false,
            'instruments'=>[],
        ];
        try {
            $check = NativeUpstoxProfileVerifier::verify(
                $privateRoot, $expectedUserId, $transport
            );
            if ($check['session_verified'] !== true) {
                $report['code'] = 'UPSTOX_PROFILE_REVERIFICATION_REQUIRED';
                return $report;
            }
            $report['session_verified_now'] = true;
            $token = self::readBearer($privateRoot, $expectedUserId);
            if ($token === null) {
                $report['code'] = 'UPSTOX_PRIVATE_SESSION_UNAVAILABLE';
                return $report;
            }
            $all = true;
            foreach (self::TARGETS as $symbol=>$target) {
                $query = http_build_query([
                    'query'=>$target['query'],
                    'exchanges'=>$target['exchange'],
                    'segments'=>'INDEX',
                    'page_number'=>1,
                    'records'=>30,
                ], '', '&', PHP_QUERY_RFC3986);
                $url = self::SEARCH_URL . '?' . $query;
                $response = $transport ? $transport($url, $token) : self::get($url, $token);
                $one = self::inspect($response, $symbol, $target);
                $report['instruments'][] = $one;
                if ($one['status'] !== 'resolved') $all = false;
            }
            $report['mapping_fully_resolved'] = $all;
            $report['status'] = $all ? 'resolved_for_review' : 'incomplete';
            $report['code'] = $all ? 'UPSTOX_INDEX_KEYS_RESOLVED_NOT_APPROVED'
                : 'UPSTOX_INDEX_KEYS_INCOMPLETE';
            return $report;
        } catch (\Throwable) {
            // Do not expose transport errors, secrets, response data or paths.
            $report['status'] = 'unavailable';
            $report['code'] = 'UPSTOX_INDEX_SEARCH_UNAVAILABLE';
            // Never preserve an apparently complete partial mapping after an
            // unexpected exception. A bounded failed search is not approval.
            $report['mapping_fully_resolved'] = false;
            return $report;
        }
    }

    private static function inspect(mixed $response, string $symbol, array $target): array
    {
        $base = [
            'symbol'=>$symbol,
            'exchange'=>$target['segment'],
            'status'=>'unavailable',
            'instrument_key'=>null,
        ];
        if (!is_array($response)) {
            return $base;
        }
        if (in_array($response['http_status'] ?? null, [401,403], true)) {
            $base['status']='session_expired';
            return $base;
        }
        if (($response['http_status'] ?? null) !== 200
            || !is_array($response['body'] ?? null)
            || ($response['body']['status'] ?? null) !== 'success'
            || !is_array($response['body']['data'] ?? null)
            || count($response['body']['data']) > 30) {
            return $base;
        }
        $page = $response['body']['meta_data']['page'] ?? null;
        if (!is_array($page) || ($page['page_number'] ?? null) !== 1
            || !is_int($page['total_pages'] ?? null)
            || $page['total_pages'] < 1) {
            return $base;
        }
        $keys = [];
        $seenPage = [];
        foreach ($response['body']['data'] as $candidate) {
            if (!is_array($candidate)) continue;
            $key = $candidate['instrument_key'] ?? null;
            if (!is_string($key) || !preg_match(
                    '/^(NSE_INDEX|BSE_INDEX)\|[A-Za-z0-9 ._-]{1,100}$/D', $key
                )) continue;
            if (($candidate['exchange'] ?? null) !== $target['exchange']
                || ($candidate['segment'] ?? null) !== $target['segment']
                || ($candidate['instrument_type'] ?? null) !== 'INDEX'
                || !str_starts_with($key,$target['segment'].'|')) continue;
            $name = $candidate['trading_symbol'] ?? null;
            $long = $candidate['name'] ?? null;
            $aliases = $target['aliases'];
            $normal = static fn(string $value):string =>
                preg_replace('/[^A-Z0-9]/', '', strtoupper($value));
            $match = (is_string($name) && in_array($normal($name),$aliases,true))
                || (is_string($long) && in_array($normal($long),$aliases,true));
            if (!$match) continue;
            if (isset($seenPage[$key])) continue;
            $seenPage[$key] = true;
            $keys[] = $key;
        }
        if (count($keys) > 1) {
            $base['status']='ambiguous';
        } elseif (count($keys) === 1 && $page['total_pages'] === 1) {
            // A matching first-page result with more pages is not complete:
            // another page could contain a conflicting exact alias.
            $base['status']='resolved';
            $base['instrument_key']=$keys[0];
        } else {
            $base['status']=$page['total_pages']>1?'pagination_incomplete':'not_found';
        }
        return $base;
    }

    private static function readBearer(string $root,string $expectedUserId): ?string
    {
        $path=$root.'/upstox-session.json';
        $st=@lstat($path);
        if (!$st || !is_file($path) || is_link($path)
            || ($st['mode'] & 0077) !== 0
            || $st['size'] < 80 || $st['size'] > 16384
            || (function_exists('posix_geteuid')
                && $st['uid'] !== posix_geteuid())) return null;
        $raw=@file_get_contents($path);
        if (!is_string($raw)) return null;
        $json=json_decode($raw,true,12,JSON_THROW_ON_ERROR);
        if (!is_array($json)
            || ($json['schema'] ?? null) !== 'QSYN-UPSTOX-AUTH-SESSION/1'
            || ($json['broker'] ?? null) !== 'upstox'
            || ($json['user_id'] ?? null) !== $expectedUserId
            || ($json['order_routing_enabled'] ?? null) !== false
            || ($json['display_entitlement_verified'] ?? null) !== false
            || ($json['retention_entitlement_verified'] ?? null) !== false
            || !is_string($json['access_token'] ?? null)) return null;
        $bearer=$json['access_token'];
        if (strlen($bearer)<20 || strlen($bearer)>8192
            || preg_match('/^[A-Za-z0-9._~+\/=\-]+$/D',$bearer)!==1) return null;
        return $bearer;
    }

    private static function get(string $url, string $token): array
    {
        if (!function_exists('curl_init')) throw new \RuntimeException('curl_unavailable');
        // Do not allow generic URL inputs: only six server-generated fixed-host searches.
        if (!str_starts_with($url,self::SEARCH_URL.'?')) {
            throw new \RuntimeException('url_not_allowed');
        }
        $curl=curl_init($url);
        if ($curl===false) throw new \RuntimeException('curl_unavailable');
        try {
            curl_setopt_array($curl,[
                CURLOPT_HTTPGET=>true,
                CURLOPT_HTTPHEADER=>[
                    'Authorization: Bearer '.$token,
                    'Accept: application/json',
                ],
                CURLOPT_RETURNTRANSFER=>true,
                CURLOPT_CONNECTTIMEOUT=>3,
                CURLOPT_TIMEOUT=>5,
                CURLOPT_FOLLOWLOCATION=>false,
                CURLOPT_SSL_VERIFYHOST=>2,
                CURLOPT_SSL_VERIFYPEER=>true,
                CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,
            ]);
            $body=curl_exec($curl);
            $status=(int)curl_getinfo($curl,CURLINFO_HTTP_CODE);
            if (!is_string($body) || strlen($body)>65536) {
                throw new \RuntimeException('provider_response_invalid');
            }
            $parsed=json_decode($body,true,16,JSON_THROW_ON_ERROR);
            return ['http_status'=>$status,'body'=>$parsed];
        } finally {
            curl_close($curl);
        }
    }
}
