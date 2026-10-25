<?php
declare(strict_types=1);

namespace QSYN\MarketData;

use QSYN\Admin\RustAdmin;

/**
 * Owner-only read access to locally imported NSE/BSE Upstox BOD master files.
 * No broker network request, database, market-data entitlement or new worker.
 */
final class UpstoxMasterCatalog
{
    private const SCHEMA = 'QSYN-UPSTOX-BOD-MASTER/1';
    private const SEGMENTS = [
        'ALL','EQ','FO','INDEX','CURR','COMM',
        'NSE_EQ','NSE_FO','NSE_INDEX','NSE_COM','NCD_FO',
        'BSE_EQ','BSE_FO','BSE_INDEX','BCD_FO'
    ];
    private const TYPES = ['ALL','EQ','BE','BZ','SM','ST','A','B','X','Z',
        'CE','PE','FUT','INDEX'];

    public static function validate(array $query): ?array
    {
        foreach ($query as $key=>$value) {
            if(!in_array($key,['exchange','segment','type','query','page','records'],true)
                || !is_string($value))return null;
        }
        $exchange=$query['exchange']??'';
        if(!in_array($exchange,['NSE','BSE'],true))return null;
        $segment=$query['segment']??'EQ';
        $type=$query['type']??'ALL';
        if(!in_array($segment,self::SEGMENTS,true)||!in_array($type,self::TYPES,true))
            return null;
        if(str_contains($segment,'_')&&!str_starts_with($segment,$exchange.'_')
            && !($exchange==='NSE'&&$segment==='NCD_FO')
            && !($exchange==='BSE'&&$segment==='BCD_FO'))return null;
        $search=trim($query['query']??'');
        if(strlen($search)>50||($search!==''&&
            preg_match('/\A[A-Za-z0-9][A-Za-z0-9 .&+_\/\-]{0,49}\z/D',$search)!==1))
            return null;
        foreach(['page'=>[1,100000],'records'=>[1,30]] as $field=>[$min,$max]) {
            $value=$query[$field]??($field==='page'?'1':'20');
            if(preg_match('/\A[0-9]{1,6}\z/D',$value)!==1
                ||(int)$value<$min||(int)$value>$max)return null;
            $numbers[$field]=(int)$value;
        }
        return ['exchange'=>$exchange,'segment'=>$segment,'type'=>$type,
            'query'=>$search,'page'=>$numbers['page'],'records'=>$numbers['records']];
    }

    private static function privatePath(string $runtime): ?string
    {
        if($runtime===''||$runtime[0]!=='/'||str_contains($runtime,'/..')
            ||str_contains($runtime,'//')
            ||preg_match('~/(?:public_html|webroot|www)(?:/|$)~i',$runtime)
            ||realpath($runtime)!==$runtime||is_link($runtime))return null;
        $path=$runtime.'/upstox-master';
        foreach([$runtime,$path] as $dir){
            $s=@lstat($dir);
            if($s===false||!is_dir($dir)||is_link($dir)
                ||realpath($dir)!==$dir||($s['mode']&0077)!==0
                ||(function_exists('posix_geteuid')&&$s['uid']!==posix_geteuid()))
                return null;
        }
        return $path;
    }

    private static function secureFile(string $path,int $max): bool
    {
        $s=@lstat($path);
        return $s!==false&&is_file($path)&&!is_link($path)
            &&($s['mode']&0077)===0&&$s['size']>0&&$s['size']<=$max
            &&(!function_exists('posix_geteuid')||$s['uid']===posix_geteuid());
    }

    private static function snapshot(string $runtime): ?array
    {
        $path=self::privatePath($runtime);
        if($path===null||!self::secureFile($path.'/current.json',4096))return null;
        try{$manifest=json_decode((string)file_get_contents($path.'/current.json'),true,12,JSON_THROW_ON_ERROR);}
        catch(\Throwable){return null;}
        $generation=$manifest['generation']??null;
        $date=$manifest['imported_day_ist']??null;
        if(($manifest['schema']??null)!==self::SCHEMA
            ||($manifest['data_state']??null)!=='discovery_only'
            ||($manifest['trading_enabled']??null)!==false
            ||($manifest['history_verified']??null)!==false
            ||($manifest['live_feed_verified']??null)!==false
            ||!is_string($generation)||preg_match('/\Abod-20[0-9]{2}-[0-9]{2}-[0-9]{2}-[a-f0-9]{12}\z/D',$generation)!==1
            ||!is_string($date)||preg_match('/\A20[0-9]{2}-[0-9]{2}-[0-9]{2}\z/D',$date)!==1
            ||!is_array($manifest['exchanges']??null))return null;
        $directory=$path.'/'.$generation;
        if(!is_dir($directory)||is_link($directory)||realpath($directory)!==$directory)return null;
        $s=@lstat($directory);
        if(!$s||($s['mode']&0077)!==0)return null;
        foreach(['NSE','BSE'] as $exchange){
            $info=$manifest['exchanges'][$exchange]??null;
            if(!is_array($info)||!is_int($info['total']??null)
                ||$info['total']<1||$info['total']>2_000_000
                ||!self::secureFile($directory.'/'.$exchange.'.ndjson',350_000_000))
                return null;
        }
        return ['directory'=>$directory,'manifest'=>$manifest];
    }

    public static function status(string $runtime): array
    {
        $snapshot=self::snapshot($runtime);
        $manifest=$snapshot['manifest']??null;
        $today=(new \DateTimeImmutable('now',new \DateTimeZone('Asia/Kolkata')))->format('Y-m-d');
        return ['schema'=>self::SCHEMA,'catalog_ready'=>$manifest!==null,
            'imported_day_ist'=>$manifest['imported_day_ist']??null,
            'imported_today_ist'=>$manifest!==null
                &&$manifest['imported_day_ist']===$today,
            'exchange_counts'=>$manifest===null?[]:[
                'NSE'=>$manifest['exchanges']['NSE']['total'],
                'BSE'=>$manifest['exchanges']['BSE']['total']],
            'data_state'=>'discovery_only',
            'history_verified'=>false,'live_feed_verified'=>false,
            'trading_enabled'=>false];
    }

    public static function search(string $runtime,array $params,?string $token=null,
        string $csrf='',?int $now=null): array
    {
        $snapshot=self::snapshot($runtime);
        if($snapshot===null)return [409,['error'=>'bod_master_not_imported']];
        $file=$snapshot['directory'].'/'.$params['exchange'].'.ndjson';
        $handle=@fopen($file,'rb');
        if($handle===false)return [503,['error'=>'bod_master_unavailable']];
        $matches=0;$scanned=0;$instruments=[];
        $start=($params['page']-1)*$params['records'];
        try{
            while(($line=fgets($handle,2048))!==false){
                if(strlen($line)>1800)return [503,['error'=>'bod_master_corrupt']];
                if(++$scanned>2_000_000)return [503,['error'=>'bod_master_limit']];
                $row=json_decode($line,true,8);
                if(!is_array($row)||($row['exchange']??'')!==$params['exchange']
                    ||!is_string($row['instrument_key']??null)
                    ||!is_string($row['trading_symbol']??null)
                    ||!is_string($row['segment']??null)
                    ||!is_string($row['instrument_type']??null))
                    return [503,['error'=>'bod_master_corrupt']];
                if(!self::matches($row,$params))continue;
                if($matches>=$start&&count($instruments)<$params['records']){
                    // Signed selection is the existing short-lived chart route,
                    // never a license, token, subscription or trade privilege.
                    $row['selection_scope']=$token!==null
                        &&UpstoxInstrumentSearch::validHistoryKey($row['instrument_key'])
                        ?UpstoxInstrumentSearch::signScope($row['instrument_key'],$token,$csrf,$now??time())
                        :null;
                    $instruments[]=$row;
                }
                $matches++;
            }
        }finally{fclose($handle);}
        if($scanned!==$snapshot['manifest']['exchanges'][$params['exchange']]['total'])
            return [503,['error'=>'bod_master_incomplete']];
        return [200,[
            'schema'=>self::SCHEMA,'source'=>'upstox_official_bod_json',
            'data_state'=>'discovery_only','history_verified'=>false,
            'live_feed_verified'=>false,'trading_enabled'=>false,
            'exchange'=>$params['exchange'],'segment'=>$params['segment'],
            'imported_day_ist'=>$snapshot['manifest']['imported_day_ist'],
            'page_number'=>$params['page'],'records'=>$params['records'],
            'total_records'=>$matches,
            'total_pages'=>max(1,(int)ceil($matches/$params['records'])),
            'instruments'=>$instruments
        ]];
    }

    private static function matches(array $row,array $params): bool
    {
        $segment=$row['segment'];$family=$params['segment'];
        if($family!=='ALL'){
            $isFamily=match($family){
                'EQ'=>str_ends_with($segment,'_EQ'),
                'FO'=>str_ends_with($segment,'_FO'),
                'CURR'=>in_array($segment,['NCD_FO','BCD_FO'],true),
                'COMM'=>$segment==='NSE_COM',
                'INDEX'=>str_ends_with($segment,'_INDEX'),
                default=>$segment===$family,
            };
            if(!$isFamily)return false;
        }
        if($params['type']!=='ALL'&&$row['instrument_type']!==$params['type'])
            return false;
        if($params['query']==='')return true;
        $haystack=strtoupper($row['trading_symbol'].' '.($row['name']??'').' '.
            $row['instrument_key'].' '.($row['underlying_symbol']??''));
        return str_contains($haystack,strtoupper($params['query']));
    }

    public static function dispatch(array $server,array $query): array
    {
        if(($server['REQUEST_METHOD']??'GET')!=='GET')return [405,['error'=>'method_not_allowed']];
        if(!RustAdmin::originAllowed($server))return [403,['error'=>'master_origin_denied']];
        RustAdmin::boot();
        if(!RustAdmin::authenticated())return [401,['error'=>'admin_login_required']];
        $runtime=(string)(getenv('QSYN_RUNTIME_DIR')?:dirname(__DIR__,2).'/runtime');
        if(($query['mode']??null)==='status'&&count($query)===1)
            return [200,self::status($runtime)];
        $params=self::validate($query);
        if($params===null)return [422,['error'=>'invalid_master_filters']];
        // Catalog browsing does not require an OAuth/token; chart scope does.
        $token=IndexHistoricalProof::privateToken();
        return self::search($runtime,$params,$token,RustAdmin::csrf());
    }
}
