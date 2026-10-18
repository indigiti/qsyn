<?php
declare(strict_types=1);

namespace QSYN\MarketData;

use QSYN\Admin\RustAdmin;

/**
 * Authenticated, read-only, server-side Upstox instrument discovery.
 * Never accepts a provider URL or bearer token from the client.
 * An instrument search hit is NOT evidence of live/historical availability.
 */
final class UpstoxInstrumentSearch
{
    private const ENDPOINT='https://api.upstox.com/v2/instruments/search';
    /**
     * Authenticated search result -> short-lived, session-bound instrument.
     * Neither the broker token nor arbitrary client-supplied keys are accepted.
     */
    public static function validHistoryKey(string $key): bool
    {
        return preg_match(
            '/\\A(?:NSE_EQ|BSE_EQ|NSE_INDEX|BSE_INDEX|NSE_FO|BSE_FO|NCD_FO|BCD_FO|MCX_FO|NSE_COM)\\|[A-Za-z0-9 ._-]{1,100}\\z/D',
            $key
        )===1;
    }
    public static function signScope(string $key,string $token,string $csrf,int $now): ?string
    {
        if(!self::validHistoryKey($key)||$csrf===''||$token==='')return null;
        $payload=json_encode(['key'=>$key,'exp'=>$now+600],JSON_THROW_ON_ERROR);
        $data=rtrim(strtr(base64_encode($payload),'+/','-_'),'=');
        return $data.'.'.hash_hmac('sha256',$data.'.'.$csrf,$token);
    }
    public static function verifyScope(string $scope,string $token,string $csrf,int $now): ?string
    {
        if(strlen($scope)>512||$csrf===''||$token===''||!str_contains($scope,'.'))return null;
        [$data,$signature]=explode('.',$scope,2);
        if(strlen($data)>300||strlen($signature)!==64||
            preg_match('/\\A[A-Za-z0-9_-]+\\z/D',$data)!==1||
            preg_match('/\\A[a-f0-9]{64}\\z/D',$signature)!==1||
            !hash_equals(hash_hmac('sha256',$data.'.'.$csrf,$token),$signature))
            return null;
        $json=base64_decode(strtr($data,'-_','+/'),true);
        if(!is_string($json))return null;
        try{$scopeData=json_decode($json,true,5,JSON_THROW_ON_ERROR);}
        catch(\\Throwable){return null;}
        if(!is_array($scopeData)||array_keys($scopeData)!==['key','exp']||
            !is_string($scopeData['key'])||!is_int($scopeData['exp'])||
            $scopeData['exp']<=$now||$scopeData['exp']>$now+600||
            !self::validHistoryKey($scopeData['key']))return null;
        return $scopeData['key'];
    }

    private const ALLOWED=[
        'query','exchanges','segments','instrument_types','expiry','atm_offset',
        'page_number','records'
    ];
    private const EXCHANGES=['ALL','NSE','BSE','MCX'];
    private const SEGMENTS=['ALL','EQ','FO','CURR','COMM','INDEX','OPT','FUT'];
    private const TYPES=['CE','PE','FUT','EQ','INDEX'];
    private const EXPIRIES=[
        'current_week','this_week','near_week','weekly','next_week','far_week',
        'current_month','this_month','near_month','monthly','next_month','far_month'
    ];

    private static function commaFilter(mixed $value,array $allowed): ?string
    {
        if (!is_string($value)||strlen($value)>60) return null;
        $parts=explode(',',strtoupper($value));
        if (!$parts||count($parts)>4||count($parts)!==count(array_unique($parts))) return null;
        foreach($parts as $part) if(!in_array($part,$allowed,true))return null;
        return implode(',',$parts);
    }

    public static function validate(array $input): ?array
    {
        foreach($input as $key=>$value) {
            if (!is_string($key)||!in_array($key,self::ALLOWED,true)
                ||is_array($value)||is_object($value)) return null;
        }
        $query=$input['query']??null;
        if(!is_string($query))return null;
        $query=trim($query);
        // The provider accepts <=50 characters. Reject control/URL punctuation.
        if(strlen($query)<2||strlen($query)>50
            ||preg_match('/\A[A-Za-z0-9][A-Za-z0-9 .&+_\/-]*\z/D',$query)!==1)return null;
        $out=['query'=>$query];
        foreach(['exchanges'=>self::EXCHANGES,'segments'=>self::SEGMENTS,
            'instrument_types'=>self::TYPES] as $field=>$allow) {
            if(!array_key_exists($field,$input)||$input[$field]==='')continue;
            $filter=self::commaFilter($input[$field],$allow);
            if($filter===null)return null;
            $out[$field]=$filter;
        }
        if(isset($input['expiry'])&&$input['expiry']!==''){
            if(!is_string($input['expiry']))return null;
            $expiry=strtolower($input['expiry']);
            if(!in_array($expiry,self::EXPIRIES,true)
                &&(!preg_match('/\A20[0-9]{2}-[0-9]{2}-[0-9]{2}\z/D',$expiry)
                    ||!checkdate((int)substr($expiry,5,2),(int)substr($expiry,8,2),
                        (int)substr($expiry,0,4))))return null;
            $out['expiry']=$expiry;
        }
        foreach(['atm_offset'=>[-20,20],'page_number'=>[1,100],'records'=>[1,30]]
            as $field=>[$minimum,$maximum]) {
            if(!isset($input[$field])||$input[$field]==='')continue;
            if(!is_string($input[$field])
                ||preg_match('/\A-?[0-9]{1,3}\z/D',$input[$field])!==1
                ||(int)$input[$field]<$minimum||(int)$input[$field]>$maximum)return null;
            $out[$field]=(int)$input[$field];
        }
        $out['page_number']=$out['page_number']??1;
        $out['records']=$out['records']??20;
        return $out;
    }

    /** Fixed HTTPS host, bounded JSON, no redirects, no account metadata. */
    private static function request(string $url,string $token): array
    {
        if(!str_starts_with($url,self::ENDPOINT.'?'))
            throw new \RuntimeException('upstox_search_url_not_allowed');
        if(!function_exists('curl_init'))return ['http_status'=>0,'body'=>null];
        $ch=curl_init($url);
        if($ch===false)return ['http_status'=>0,'body'=>null];
        $raw='';
        try{
            curl_setopt_array($ch,[
                CURLOPT_HTTPGET=>true,
                CURLOPT_HTTPHEADER=>['Authorization: Bearer '.$token,'Accept: application/json'],
                CURLOPT_RETURNTRANSFER=>false,
                CURLOPT_CONNECTTIMEOUT=>4,CURLOPT_TIMEOUT=>10,
                CURLOPT_FOLLOWLOCATION=>false,
                CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_SSL_VERIFYPEER=>true,
                CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,
                CURLOPT_WRITEFUNCTION=>static function($handle,string $chunk)use(&$raw):int{
                    if(strlen($raw)+strlen($chunk)>262144)return 0;
                    $raw.=$chunk;
                    return strlen($chunk);
                },
            ]);
            $ok=curl_exec($ch);
            $status=(int)curl_getinfo($ch,CURLINFO_HTTP_CODE);
            if($ok===false)return ['http_status'=>0,'body'=>null];
            $payload=json_decode($raw,true,12);
            return ['http_status'=>$status,'body'=>is_array($payload)?$payload:null];
        }finally{curl_close($ch);}
    }

    /** Safe public instrument fields only; no provider headers or account data. */
    public static function normalize(array $body,array $params): ?array
    {
        if(($body['status']??null)!=='success'||!is_array($body['data']??null)
            ||!array_is_list($body['data'])||count($body['data'])>$params['records'])
            return null;
        $instruments=[];
        foreach($body['data'] as $row){
            if(!is_array($row))return null;
            $key=$row['instrument_key']??null;
            $segment=$row['segment']??null;
            $exchange=$row['exchange']??null;
            if(!is_string($key)||strlen($key)>140||
                preg_match('/\A(?:NSE_EQ|BSE_EQ|NSE_INDEX|BSE_INDEX|NSE_FO|BSE_FO|NCD_FO|BCD_FO|MCX_FO|NSE_COM)\|[A-Za-z0-9 ._\/-]{1,100}\z/D',$key)!==1
                ||!is_string($segment)||!preg_match('/\A[A-Z_]{2,20}\z/D',$segment)
                ||!in_array($exchange,['NSE','BSE','MCX'],true))continue;
            $label=$row['trading_symbol']??$row['tradingsymbol']??'';
            $name=$row['name']??'';
            if(!is_string($label)||!is_string($name))continue;
            $type=$row['instrument_type']??'';
            $expiry=$row['expiry']??null;
            $strike=$row['strike_price']??$row['strike']??null;
            $instruments[]=[
                'instrument_key'=>$key,'exchange'=>$exchange,'segment'=>$segment,
                'trading_symbol'=>substr($label,0,140),'name'=>substr($name,0,140),
                'instrument_type'=>is_string($type)?substr($type,0,25):'',
                'expiry'=>is_string($expiry)&&preg_match('/\A20[0-9]{2}-[0-9]{2}-[0-9]{2}\z/D',$expiry)?$expiry:null,
                'strike_price'=>is_numeric($strike)&&is_finite((float)$strike)?(float)$strike:null,
                'lot_size'=>is_int($row['lot_size']??null)&&$row['lot_size']>0?$row['lot_size']:null,
                'underlying_symbol'=>is_string($row['underlying_symbol']??null)?
                    substr($row['underlying_symbol'],0,100):null,
            ];
        }
        $meta=$body['meta_data']['page']??[];
        $totalPages=is_array($meta)&&is_int($meta['total_pages']??null)
            ?max(1,min(100000,$meta['total_pages'])):1;
        return [
            'schema'=>'QSYN-UPSTOX-INSTRUMENT-SEARCH/1',
            'source'=>'upstox_instrument_search_v2',
            'query'=>$params['query'],'page_number'=>$params['page_number'],
            'records'=>$params['records'],'total_pages'=>$totalPages,
            'instruments'=>$instruments,
            'data_state'=>'discovery_only','history_verified'=>false,
            'live_feed_verified'=>false,'trading_enabled'=>false
        ];
    }

    public static function dispatch(array $server,array $query,?callable $transport=null): array
    {
        if(($server['REQUEST_METHOD']??'GET')!=='GET')return [405,['error'=>'method_not_allowed']];
        if(!RustAdmin::originAllowed($server))return [403,['error'=>'upstox_search_origin_denied']];
        RustAdmin::boot();
        if(!RustAdmin::authenticated())return [401,['error'=>'admin_login_required']];
        $params=self::validate($query);
        if($params===null)return [422,['error'=>'invalid_upstox_instrument_search']];
        $token=IndexHistoricalProof::privateToken();
        if($token===null)return [409,['error'=>'upstox_analytics_token_not_ready']];
        $url=self::ENDPOINT.'?'.http_build_query($params,'','&',PHP_QUERY_RFC3986);
        try{$response=$transport?$transport($url,$token):self::request($url,$token);}
        catch(\Throwable){return [502,['error'=>'upstox_instrument_search_unavailable']];}
        // Authentication/rate limits are not empty search results.
        if(!is_array($response)||($response['http_status']??0)!==200)
            return [502,['error'=>'upstox_instrument_search_unavailable',
                'provider_http_status'=>is_int($response['http_status']??null)?
                    $response['http_status']:0]];
        $normalized=is_array($response['body']??null)
            ?self::normalize($response['body'],$params):null;
        if($normalized===null)return [502,['error'=>'upstox_instrument_search_invalid_response']];
        $csrf=RustAdmin::csrf();
        foreach($normalized['instruments'] as &$instrument){
            $instrument['selection_scope']=self::signScope(
                $instrument['instrument_key'],$token,$csrf,time());
        }
        unset($instrument);
        return [200,$normalized];
    }
}
