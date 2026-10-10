# Normalize every .cmd in this repo to ASCII + CRLF + no BOM.
# Rationale: cmd.exe running under a CJK code page (936) mis-parses UTF-8 batch
# files, which breaks labels, quotes and echo output.
# Usage: powershell -File tools/normalize-cmd.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Get-ChildItem -Path $root -Filter '*.cmd' -File | ForEach-Object {
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    if ($hasBom) { $text = $text.Substring(1) }
    $text = ($text -replace "`r`n", "`n") -replace "`n", "`r`n"
    $nonAscii = [regex]::Matches($text, '[^\x00-\x7F]').Count
    if ($nonAscii -gt 0) {
        Write-Warning "$($_.Name) contains $nonAscii non-ASCII chars; cmd.exe may fail under code page 936"
    }
    [System.IO.File]::WriteAllBytes($_.FullName, [System.Text.Encoding]::ASCII.GetBytes($text))
    Write-Host "normalized: $($_.Name)"
}
