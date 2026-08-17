@echo off
setlocal enabledelayedexpansion
REM ============================================================================
REM Sati Desktop Windows Installer Verifier (verify-installer.bat)
REM ----------------------------------------------------------------------------
REM Validates a built Sati Windows installer / unpacked app:
REM   1. Installer EXE exists and has nonzero size
REM   2. App directory structure is correct (Sati.exe, resources)
REM   3. Bundled Node.js and Bun binaries are present and runnable
REM   4. Bundle tars exist and are extractable
REM   5. Gateway process starts and responds on /health
REM      (with stub sati.yaml for runtime-equivalent wiring)
REM
REM Usage:
REM   verify-installer.bat <DIST_ELECTRON_DIR>
REM   verify-installer.bat   (auto-detects dist-electron in parent)
REM   exit 0 = all checks pass; exit 1 = any failure
REM ============================================================================

set PASS=0
set FAIL=0
set WARN=0

REM --- Locate dist-electron ---
set "DIST_DIR=%~1"
if "%DIST_DIR%"=="" (
    set "DIST_DIR=%~dp0..\dist-electron"
)
if not exist "%DIST_DIR%" (
    echo ERROR: dist-electron directory not found: %DIST_DIR%
    exit /b 2
)

echo.
echo =========================================
echo  Sati Windows Installer Verification
echo =========================================
echo  Dir: %DIST_DIR%
echo.

REM -- 1. Installer EXE --
echo -- 1. Installer EXE --

set "FOUND_EXE="
for %%f in ("%DIST_DIR%\Sati Setup*.exe" "%DIST_DIR%\Sati-*.exe") do (
    if exist "%%f" (
        set "FOUND_EXE=%%f"
        set /a PASS+=1
        echo   [PASS] Installer found: %%~nxf
    )
)
if "%FOUND_EXE%"=="" (
    set /a WARN+=1
    echo   [WARN] No installer EXE found in %DIST_DIR% ^(may be --dir build^)
)

REM -- 2. Unpacked app structure --
echo.
echo -- 2. Unpacked app structure --

set "WIN_UNPACKED=%DIST_DIR%\win-unpacked"
if not exist "%WIN_UNPACKED%" (
    for /d %%d in ("%DIST_DIR%\win*") do (
        if exist "%%d\Sati.exe" set "WIN_UNPACKED=%%d"
    )
)

if exist "%WIN_UNPACKED%\Sati.exe" (
    set /a PASS+=1
    echo   [PASS] Sati.exe present
) else (
    set /a FAIL+=1
    echo   [FAIL] Sati.exe not found
    echo         Looked in: %WIN_UNPACKED%
)

REM -- 3. Bundled resources --
echo.
echo -- 3. Bundled resources --

set "RES=%WIN_UNPACKED%\resources"
if not exist "%RES%" (
    set /a FAIL+=1
    echo   [FAIL] resources directory not found
    goto :skip_resources
)

if exist "%RES%\app.asar" (
    set /a PASS+=1
    echo   [PASS] app.asar present
) else (
    set /a FAIL+=1
    echo   [FAIL] app.asar missing
)

if exist "%RES%\node-bin\node.exe" (
    set /a PASS+=1
    for /f "delims=" %%v in ('"%RES%\node-bin\node.exe" --version 2^>nul') do (
        echo   [PASS] Bundled Node present (%%v^)
    )
) else (
    set /a FAIL+=1
    echo   [FAIL] node-bin\node.exe missing
)

if exist "%RES%\bun-bin\bun.exe" (
    set /a PASS+=1
    for /f "delims=" %%v in ('"%RES%\bun-bin\bun.exe" --version 2^>nul') do (
        echo   [PASS] Bundled Bun present (%%v^)
    )
) else (
    set /a FAIL+=1
    echo   [FAIL] bun-bin\bun.exe missing
)

if exist "%RES%\satiui-bundle.tar" (
    set /a PASS+=1
    echo   [PASS] satiui-bundle.tar present
) else (
    set /a FAIL+=1
    echo   [FAIL] satiui-bundle.tar missing
)

if exist "%RES%\sati-main-bundle.tar" (
    set /a PASS+=1
    echo   [PASS] sati-main-bundle.tar present
) else (
    set /a FAIL+=1
    echo   [FAIL] sati-main-bundle.tar missing
)

if exist "%RES%\sati-memory-core-bundle.tar" (
    set /a PASS+=1
    echo   [PASS] sati-memory-core-bundle.tar present
) else (
    set /a FAIL+=1
    echo   [FAIL] sati-memory-core-bundle.tar missing
)

:skip_resources

REM -- 4. Bundle extraction smoke test --
echo.
echo -- 4. Bundle extraction smoke test --

set "SANDBOX=%TEMP%\sati-verify-%RANDOM%"
mkdir "%SANDBOX%" 2>nul

set "CCUI_DIR=%SANDBOX%\satiui"
mkdir "%CCUI_DIR%" 2>nul
if exist "%RES%\satiui-bundle.tar" (
    tar xf "%RES%\satiui-bundle.tar" -C "%CCUI_DIR%" 2>nul
    if exist "%CCUI_DIR%\server\index.js" (
        set /a PASS+=1
        echo   [PASS] satiui-bundle extracted, server\index.js present
    ) else (
        set /a FAIL+=1
        echo   [FAIL] server\index.js missing after extraction
    )
    if exist "%CCUI_DIR%\server\services\server-boot.js" (
        findstr /C:"SATI_DESKTOP" "%CCUI_DIR%\server\services\server-boot.js" >nul
        if not errorlevel 1 (
            set /a PASS+=1
            echo   [PASS] ui server boot skips browser auto-open when SATI_DESKTOP=1
        ) else (
            set /a FAIL+=1
            echo   [FAIL] server-boot.js lacks SATI_DESKTOP guard - bundle is stale
        )
    ) else (
        set /a FAIL+=1
        echo   [FAIL] server\services\server-boot.js missing after extraction - bundle is stale
    )
)

set "CCM_DIR=%SANDBOX%\sati-main"
mkdir "%CCM_DIR%" 2>nul
if exist "%RES%\sati-main-bundle.tar" (
    tar xf "%RES%\sati-main-bundle.tar" -C "%CCM_DIR%" 2>nul
    if exist "%CCM_DIR%\dist\src\cli\sati.js" (
        set /a PASS+=1
        echo   [PASS] sati-main-bundle extracted, dist\src\cli\sati.js present
    ) else (
        set /a FAIL+=1
        echo   [FAIL] dist\src\cli\sati.js missing after extraction
    )
)

set "MEM_DIR=%SANDBOX%\sati-memory-core"
mkdir "%MEM_DIR%" 2>nul
if exist "%RES%\sati-memory-core-bundle.tar" (
    tar xf "%RES%\sati-memory-core-bundle.tar" -C "%MEM_DIR%" 2>nul
    if exist "%MEM_DIR%\lib\index.js" (
        set /a PASS+=1
        echo   [PASS] sati-memory-core extracted, lib\index.js present
    ) else (
        set /a FAIL+=1
        echo   [FAIL] lib\index.js missing after extraction
    )
)

REM -- 4b. Bundled Node FTS5 check --
echo.
echo -- 4b. Bundled Node FTS5 check --

set "NODE_BIN=%RES%\node-bin\node.exe"
if not exist "%NODE_BIN%" (
    set /a WARN+=1
    echo   [WARN] Skipping FTS5 check ^(no bundled node^)
    goto :skip_fts5
)

REM law_fts full-text search depends on node:sqlite FTS5 (compiled in from
REM v22.18+); without it MATCH throws "no such module: fts5" and search
REM degrades to LIKE. Create an fts5 virtual table and MATCH against it.
"%NODE_BIN%" -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.exec('CREATE VIRTUAL TABLE t USING fts5(x)'); db.prepare('INSERT INTO t (x) VALUES (?)').run('hello'); const row = db.prepare('SELECT x FROM t WHERE t MATCH ?').get('hello'); if (row == null) process.exit(1); console.log('fts5 ok');" >nul 2>nul
if errorlevel 1 (
    set /a FAIL+=1
    echo   [FAIL] Bundled Node lacks FTS5 - law_fts full-text search will degrade to LIKE
) else (
    set /a PASS+=1
    echo   [PASS] Bundled Node FTS5 available
)
:skip_fts5

REM -- 4c. Native modules load check --
echo.
echo -- 4c. Native modules load check --

if not exist "%NODE_BIN%" (
    set /a WARN+=1
    echo   [WARN] Skipping native check ^(no bundled node^)
    goto :skip_native
)
if not exist "%CCM_DIR%\node_modules" (
    set /a WARN+=1
    echo   [WARN] Skipping native check ^(no sati-main node_modules^)
    goto :skip_native
)
if not exist "%CCUI_DIR%\node_modules" (
    set /a WARN+=1
    echo   [WARN] Skipping native check ^(no satiui node_modules^)
    goto :skip_native
)

REM Native modules are checked from the tree the runtime actually resolves
REM them in, against the bundled Node:
REM   - better-sqlite3 / node-pty are ui deps  -> resolve from the satiui tree
REM   - sharp / mupdf are root deps            -> resolve from the sati-main tree
REM     (sharp from its .pnpm vstore dir, mirroring the runtime's
REM      reconstructPnpmLinks() relinked layout - the bare top-level copy
REM      cannot see its isolated deps; mupdf is ESM-only, so it needs a
REM      dynamic import, not require())
REM Preflight (build-win.bat step 4b) already verified the dev tree; this
REM re-verifies the extracted artifact.
pushd "%CCUI_DIR%"
set NATIVE_OK=0
for %%m in (better-sqlite3 node-pty) do (
    "%NODE_BIN%" -e "require('%%m')" >nul 2>nul
    if errorlevel 1 (
        echo   [FAIL] native module "%%m" failed to load ^(satiui tree^)
    ) else (
        echo   [PASS] native module %%m loads ^(satiui tree^)
        set /a NATIVE_OK+=1
    )
)
popd
pushd "%CCM_DIR%"
"%NODE_BIN%" -e "const fs=require('fs'),p=require('node:path');const d=fs.readdirSync('node_modules/.pnpm').filter(x=>x.startsWith('sharp@'));if (d.length === 0) process.exit(2);const s=require(p.resolve('node_modules/.pnpm',d[0],'node_modules/sharp'));s({create:{width:2,height:2,channels:3,background:'#fff'}}).png().toBuffer().then(()=>process.exit(0)).catch(()=>process.exit(1));" >nul 2>nul
if errorlevel 2 (
    echo   [FAIL] sharp vstore dir not found in sati-main tree
) else if errorlevel 1 (
    echo   [FAIL] native module sharp failed to load ^(sati-main vstore^)
) else (
    echo   [PASS] native module sharp loads ^(sati-main vstore^)
    set /a NATIVE_OK+=1
)
"%NODE_BIN%" --input-type=module -e "const m=await import('mupdf'); if (m == null || m.default == null) process.exit(1);" >nul 2>nul
if errorlevel 1 (
    echo   [FAIL] native module mupdf failed to load ^(ESM import^)
) else (
    echo   [PASS] native module mupdf loads ^(ESM import^)
    set /a NATIVE_OK+=1
)
popd
if !NATIVE_OK!==4 (
    set /a PASS+=1
    echo   [PASS] all native modules load
) else (
    set /a FAIL+=1
    echo   [FAIL] one or more native modules failed to load
)
:skip_native

REM -- 5. Gateway smoke test --
echo.
echo -- 5. Gateway smoke test --

REM Reconstruct pnpm junctions exactly like server-manager.ts does at runtime:
REM the bare extracted tree cannot resolve isolated transitive deps (e.g.
REM @google/genai -> p-retry ERR_MODULE_NOT_FOUND) because Windows bsdtar
REM materialized the vstore junctions as real dirs.
"%NODE_BIN%" "%~dp0relink-pnpm-win.mjs" "%CCM_DIR%" "%CCUI_DIR%"
if errorlevel 1 (
    echo   [FAIL] pnpm link reconstruction failed
    goto :skip_gateway
)

set "SATI_HOME=%SANDBOX%\home\.sati"
mkdir "%SATI_HOME%" 2>nul

REM Create stub V2 sati.yaml
(
echo schemaVersion: 1
echo agent:
echo   model: sati/test-model
echo model:
echo   providers:
echo     sati:
echo       protocol: anthropic
echo       url: "https://example.invalid/v1"
echo       apiKey: "smoke-test-not-real"
echo       models:
echo         test-model: {}
) > "%SATI_HOME%\sati.yaml"

set "NODE_BIN=%RES%\node-bin\node.exe"
set GATEWAY_PORT=19789

if not exist "%NODE_BIN%" (
    set /a WARN+=1
    echo   [WARN] Skipping gateway smoke test ^(no bundled node^)
    goto :skip_gateway
)
if not exist "%CCM_DIR%\dist\src\cli\sati.js" (
    set /a WARN+=1
    echo   [WARN] Skipping gateway smoke test ^(no gateway entry^)
    goto :skip_gateway
)

REM Start the gateway with runtime-equivalent wiring (pnpm vstore relink +
REM junctions). The bare extracted tree cannot resolve isolated transitive
REM deps or the edgeclaw-memory-core workspace link.
"%NODE_BIN%" "%~dp0gateway-smoke-win.mjs" "%CCM_DIR%" "%CCUI_DIR%" "%MEM_DIR%" "%NODE_BIN%" "%SANDBOX%\home" %GATEWAY_PORT%
if errorlevel 1 (
    set /a FAIL+=1
    echo   [FAIL] Gateway smoke test failed
) else (
    set /a PASS+=1
    echo   [PASS] Gateway healthy
)

REM Kill gateway (identity-checked: only kill a Sati gateway process; the
REM port may be held by the developer's own running Sati or an unrelated app)
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":%GATEWAY_PORT% " ^| findstr "LISTEN"') do (
    powershell -NoProfile -Command "if ((Get-CimInstance Win32_Process -Filter 'ProcessId=%%p' -ErrorAction SilentlyContinue).CommandLine -match 'sati') { Stop-Process -Id %%p -Force }" >nul 2>nul
)

:skip_gateway

REM -- Cleanup --
if exist "%SANDBOX%" (
    rmdir /s /q "%SANDBOX%" 2>nul
)

REM -- Summary --
echo.
echo =========================================
echo  Summary
echo =========================================
echo   Pass: %PASS%    Warn: %WARN%    Fail: %FAIL%
echo.

if %FAIL%==0 (
    echo  [OK] Windows installer verification PASSED
    exit /b 0
) else (
    echo  [ERROR] Windows installer verification FAILED
    exit /b 1
)
