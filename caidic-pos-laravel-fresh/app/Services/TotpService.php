<?php

namespace App\Services;

// A small, self-contained implementation of TOTP (the algorithm behind
// Google Authenticator, Authy, and similar apps), following RFC 6238.
// Written by hand instead of pulling in a package so there is nothing
// extra to install, and so the whole thing can be read top to bottom.
//
// Verification only needs the secret and the current time, no network
// call, which is why this can run fully offline on a terminal that has
// already synced a staff member's secret at least once.
class TotpService
{
    private const PERIOD = 30; // seconds per code, matches every authenticator app's default
    private const DIGITS = 6;
    private const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    public static function generateSecret(int $bytes = 20): string
    {
        return self::base32Encode(random_bytes($bytes));
    }

    // The link an authenticator app would scan as a QR code. Not used
    // for a QR image here (no image library involved), but the secret
    // inside it is exactly what someone would type in manually.
    public static function provisioningUri(string $secret, string $accountName, string $issuer = 'Caidic Hardware'): string
    {
        $label = rawurlencode($issuer.':'.$accountName);
        $query = http_build_query([
            'secret' => $secret,
            'issuer' => $issuer,
            'algorithm' => 'SHA1',
            'digits' => self::DIGITS,
            'period' => self::PERIOD,
        ]);

        return "otpauth://totp/{$label}?{$query}";
    }

    // Accepts a code from the current 30-second window, or the one
    // immediately before or after it — a small allowance for the
    // phone's clock and the server's clock not being perfectly in sync,
    // and for the few seconds it takes to type the code in.
    public static function verify(string $secret, string $code, int $window = 1): bool
    {
        $code = preg_replace('/\D/', '', (string) $code);
        if (strlen($code) !== self::DIGITS) {
            return false;
        }

        $counter = intdiv(time(), self::PERIOD);
        for ($i = -$window; $i <= $window; $i++) {
            if (hash_equals(self::codeAt($secret, $counter + $i), $code)) {
                return true;
            }
        }

        return false;
    }

    private static function codeAt(string $secret, int $counter): string
    {
        $key = self::base32Decode($secret);
        $counterBytes = pack('N*', 0, $counter); // 8-byte big-endian counter
        $hash = hash_hmac('sha1', $counterBytes, $key, true);

        $offset = ord($hash[19]) & 0x0F;
        $truncated = ((ord($hash[$offset]) & 0x7F) << 24)
            | ((ord($hash[$offset + 1]) & 0xFF) << 16)
            | ((ord($hash[$offset + 2]) & 0xFF) << 8)
            | (ord($hash[$offset + 3]) & 0xFF);

        return str_pad((string) ($truncated % (10 ** self::DIGITS)), self::DIGITS, '0', STR_PAD_LEFT);
    }

    private static function base32Encode(string $binary): string
    {
        $bits = '';
        foreach (str_split($binary) as $char) {
            $bits .= str_pad(decbin(ord($char)), 8, '0', STR_PAD_LEFT);
        }

        $output = '';
        foreach (str_split($bits, 5) as $chunk) {
            $chunk = str_pad($chunk, 5, '0', STR_PAD_RIGHT);
            $output .= self::BASE32_ALPHABET[bindec($chunk)];
        }

        return $output;
    }

    private static function base32Decode(string $base32): string
    {
        $clean = strtoupper(rtrim($base32, '='));
        $bits = '';
        foreach (str_split($clean) as $char) {
            $pos = strpos(self::BASE32_ALPHABET, $char);
            if ($pos === false) {
                continue;
            }
            $bits .= str_pad(decbin($pos), 5, '0', STR_PAD_LEFT);
        }

        $binary = '';
        foreach (str_split($bits, 8) as $byte) {
            if (strlen($byte) === 8) {
                $binary .= chr(bindec($byte));
            }
        }

        return $binary;
    }
}
