@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
REM ============================================================================
REM Sati Windows Signature / Integrity Verifier (verify-signature-win.bat)
REM ----------------------------------------------------------------------------
REM Windows counterpart of install-sati.sh (the macOS Gatekeeper repair helper).
REM Windows has no quarantine/provenance xattr, so there is nothing to "repair" —
REM the user-facing risk is an UNSIGNED installer triggering SmartScreen. This
REM script answers three questions about a downloaded Sati-*.exe:
REM   1. File integrity      → SHA256 hash (cross-check against a published hash)
REM   2. Authenticode status → Signed (OV/EV) / Unknown / NotSigned
REM   3. Publisher           → who signed it (confirms it's really Sati)
REM
REM Usage:
REM   verify-signature-win.bat [path-to-installer.exe]
REM   verify-signature-win.bat            (auto-finds dist-electron\Sati-*.exe)
REM
REM Exit 0 = all checks pass (signed or hash matches); 1 = verification failed.
REM ============================================================================

set "EXE=%~1"
if "%EXE%"=="" (
    for %%f in ("%~dp0..\dist-electron\Sati-*.exe") do (
        if exist "%%f" set "EXE=%%f"
    )
)
if "%EXE%"=="" (
    echo ERROR: no installer found. Pass a path: verify-signature-win.bat C:\path\Sati-0.0.24-win-x64.exe
    exit /b 1
)
if not exist "%EXE%" (
    echo ERROR: file not found: "%EXE%"
    exit /b 1
)

REM 把路径经环境变量传给 PowerShell，避免 %EXE% 含 ' 或 & 时被
REM 命令行解析截断/误判（set "VAR=值" 带引号可安全容纳 &；$env:SATI_EXE
REM 在 PowerShell 内以变量取值，路径中的空格/特殊字符不再需要引号转义）。
set "SATI_EXE=%EXE%"

echo.
echo =========================================
echo  Sati Windows Signature Verification
echo =========================================
echo  File: "%EXE%"

REM ── 1. Size ──
for %%a in ("%EXE%") do set "SIZE=%%~za"
set /a MB=%SIZE%/1048576
echo  Size: %MB% MB
if %SIZE% LSS 100000000 (
    echo  [FAIL] Installer looks truncated (%SIZE% bytes ^< 100MB^)
    exit /b 1
)

REM ── 2. SHA256 ──
echo.
echo -- SHA256 --
for /f "delims=" %%h in ('powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath $env:SATI_EXE).Hash.ToLower()"') do set "HASH=%%h"
if "!HASH!"=="" (
    echo  [FAIL] Could not compute SHA256 for "%EXE%"
    exit /b 1
)
echo  !HASH!
echo  Compare against the hash published with the release (README / release notes).
echo  Press Enter to verify the Authenticode signature...
pause >nul

REM ── 3. Authenticode signature ──
echo.
echo -- Authenticode signature --
powershell -NoProfile -Command "$sig = Get-AuthenticodeSignature -LiteralPath $env:SATI_EXE; Write-Host ('Status : ' + $sig.Status); Write-Host ('Signer : ' + $sig.SignerCertificate.Subject); Write-Host ('Issuer : ' + $sig.SignerCertificate.Issuer); Write-Host ('SHA256 : ' + $sig.SignerCertificate.Thumbprint); if ($sig.Status -eq 'Valid') { exit 0 } else { exit 1 }"
if errorlevel 1 (
    set "SIGNED=0"
) else (
    set "SIGNED=1"
)

echo.
if "!SIGNED!"=="1" (
    echo  [PASS] Signature VALID. Signer is listed above — confirm it is Sati / the publisher's OV/EV cert.
    echo         SmartScreen will NOT warn on this installer.
    exit /b 0
)

echo  [FAIL] Installer is NOT signed (or signature could not be validated).
echo.
echo  What this means:
echo   - If Status = NotSigned: the installer was built without a code-signing
echo     certificate (build-win.bat without CSC_LINK). Double-clicking it shows
echo     a SmartScreen "Windows protected your PC" prompt; click "More info"
echo     then "Run anyway" to proceed.
echo   - If Status = UnknownError / HashMismatch: the file may be corrupted or
echo     tampered — re-download and re-run this script before installing.
echo   - If the publisher does NOT match Sati, do NOT install this file.
echo.
exit /b 1
