<?php
declare(strict_types=1);

/**
 * DEVELOPER WORKSTATION ONLY — NEVER deploy or expose this script over HTTP.
 *
 * Generate a single persistent QSYN admin config from a strong password
 * received over standard input; the plaintext is never printed, saved in Git
 * or provided as a command-line argument.
 *
 * Example: secure-password-manager-command | php apps/web-php/tools/make-admin-config.php /private/workstation/output/admin-auth.json
 *
 * Copy the resulting mode-0600 file by authenticated SFTP/file manager into
 * <Cloudways application>/private_html/qsyn/runtime/admin-auth.json.
 * Do not put it under public_html or the deployable DigiOps artifact.
 */
if (PHP_SAPI !== 'cli') {
    exit(1);
}
function abortConfig(string $message): never
{
    fwrite(STDERR, "QSYN admin config: {$message}\n");
    exit(1);
}
$dest = (string)($argv[1] ?? '');
if (($argc ?? 0) !== 2 || basename($dest) !== 'admin-auth.json'
    || !str_starts_with($dest, '/')
    || str_contains($dest, '/../')
    || preg_match('~(?:^|/)public_html(?:/|$)~', $dest)) {
    abortConfig('provide an absolute private destination ending in admin-auth.json');
}
$dir = dirname($dest);
if (!is_dir($dir) || is_link($dir) || !is_writable($dir)) {
    abortConfig('private output directory is unavailable');
}
$dirMode = @fileperms($dir);
if ($dirMode === false || ($dirMode & 0002) !== 0) {
    abortConfig('output directory must not be world-writable');
}
if (file_exists($dest) || is_link($dest)) {
    abortConfig('refusing to replace an existing administrator config');
}
if (function_exists('stream_isatty') && @stream_isatty(STDIN)) {
    abortConfig('provide password via a trusted stdin pipe to avoid terminal echo');
}
$password = fgets(STDIN, 2048);
if (!is_string($password)) abortConfig('password was not provided via stdin');
$password = rtrim($password, "\r\n");
if (strlen($password) < 20 || strlen($password) > 1024) {
    abortConfig('use a strong password at least 20 and at most 1024 bytes long');
}
$hash = password_hash($password, PASSWORD_DEFAULT);
unset($password);
if (!is_string($hash)) abortConfig('password hashing failed');
$json = json_encode([
    'schema' => 'QSYN-ADMIN/1',
    'enabled' => true,
    'password_hash' => $hash,
], JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;

umask(0077);
$tmp = $dir . '/.admin-auth-' . bin2hex(random_bytes(12));
try {
    $fp = @fopen($tmp, 'x');
    if ($fp === false) abortConfig('cannot create private temporary file');
    $length = fwrite($fp, $json);
    if ($length !== strlen($json) || !fflush($fp)) {
        fclose($fp);
        abortConfig('could not write secure configuration');
    }
    fclose($fp);
    if (!chmod($tmp, 0600)) abortConfig('could not enforce private 0600 mode');
    if (!rename($tmp, $dest)) abortConfig('could not publish configuration');
} finally {
    if (is_file($tmp)) @unlink($tmp);
}
fwrite(STDOUT, "Generated private QSYN admin config (0600). Transfer securely to private_html/qsyn/runtime/admin-auth.json. Never commit it.\n");
