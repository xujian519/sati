@echo off
setlocal enabledelayedexpansion
REM ============================================================================
REM Sati Windows Build Script (aligned with macOS release.sh)
REM Usage: build-win.bat [options]
REM   --skip-install   skip pnpm install (reuse installed deps)
REM   --skip-build     skip builds (reuse existing ui/dist + dist/src)
REM   --skip-tests     skip the test gate (emergency local builds only, never for release)
REM   --skip-sign      force-skip Authenticode signing
REM   --arm64          build arm64 installer (auto-downloads arm64 runtime; default x64)
REM   --pull           git pull origin main before building (default: no, to avoid clobbering local changes)
REM
REM Signing: set CSC_LINK (path to a pfx/p12 cert or base64) and
REM   CSC_KEY_PASSWORD, then electron-builder signs automatically; without them
REM   the installer is unsigned (SmartScreen shows "unknown publisher"), see RELEASING.md.
REM
REM NOTE: this file is ASCII-only on purpose. Batch files with non-ASCII bytes
REM are read by cmd.exe using the system OEM codepage; on a GBK console a UTF-8
REM file's bytes get byte-shifted and can swallow CR/LF and REM prefixes,
REM corrupting parsing. Keep all comments and echo text ASCII.
REM ============================================================================

set "REPO_ROOT=%~dp0..\..\..\"
set "DESKTOP_DIR=%~dp0..\"
set "UI_DIR=%REPO_ROOT%ui"
set "MEMORY_DIR=%REPO_ROOT%src\context\memory\edgeclaw-memory-core"
set "RESOURCES=%DESKTOP_DIR%resources"

REM ---- Arg parsing ----
set SKIP_INSTALL=0
set SKIP_BUILD=0
set SKIP_TESTS=0
set SKIP_SIGN=0
set ARM64=0
set DO_PULL=0

for %%a in (%*) do (
    if "%%a"=="--skip-install" set SKIP_INSTALL=1
    if "%%a"=="--skip-build" set SKIP_BUILD=1
    if "%%a"=="--skip-tests" set SKIP_TESTS=1
    if "%%a"=="--skip-sign" set SKIP_SIGN=1
    if "%%a"=="--arm64" set ARM64=1
    if "%%a"=="--pull" set DO_PULL=1
)

if %ARM64%==1 (
    set "TARGET_ARCH=arm64"
) else (
    set "TARGET_ARCH=x64"
)

echo.
echo ========================================
echo  Sati Windows Builder
echo ========================================
echo.

REM ---- Step 0: version lockstep (same preflight as release.sh) ----
REM NOTE: the node -e JS must avoid "!" characters. setlocal enabledelayedexpansion
REM mangles "!" inside for /f command strings (e.g. !== becomes garbage), which
REM broke this check. The ternary form below is bang-free.
echo [0] Verifying version lockstep...
set "VERSION="
for /f "delims=" %%v in ('node -e "const r=require('./package.json'),d=require('./apps/desktop/package.json'),u=require('./ui/package.json');if((r.version===d.version)+(d.version===u.version)===2)console.log(d.version)"') do set "VERSION=%%v"
if not defined VERSION (
    echo ERROR: version mismatch across root / ui / apps-desktop package.json
    echo   Run "node scripts/bump-version.mjs" from the repo root to sync all three.
    exit /b 1
)
echo OK: version %VERSION%

REM ---- Step 1: repository test gate (release gate; same as release.sh) ----
if %SKIP_TESTS%==0 (
    echo.
    echo [1] Running repository tests...
    cd /d "%REPO_ROOT%"
    call corepack pnpm test
    if errorlevel 1 (
        echo ERROR: pnpm test failed
        echo   Fix tests or use --skip-tests for emergency local builds only.
        exit /b 1
    )
    echo OK
) else (
    echo [1] Skipping tests ^(--skip-tests^)
)

REM ---- Step 2: optional git pull (default off to avoid clobbering local changes) ----
if %DO_PULL%==1 (
    echo.
    echo [2] Pulling latest from GitHub...
    cd /d "%REPO_ROOT%"
    git pull origin main
    if errorlevel 1 (
        echo ERROR: git pull failed
        exit /b 1
    )
    echo OK
) else (
    echo [2] Skipping git pull ^(use --pull to fetch origin/main^)
)

REM ---- Step 3: install dependencies ----
if %SKIP_INSTALL%==0 (
    echo.
    echo [3] Installing dependencies ^(pnpm^)...
    cd /d "%REPO_ROOT%"
    call corepack pnpm install --ignore-scripts
    if errorlevel 1 (
        echo ERROR: pnpm install failed
        exit /b 1
    )
    cd /d "%DESKTOP_DIR%"
    call corepack pnpm install
    if errorlevel 1 (
        echo ERROR: desktop pnpm install failed
        exit /b 1
    )
    echo OK
) else (
    echo [3] Skipping install ^(--skip-install^)
)

REM ---- Step 4: download Node.js for Windows (per target arch + SHA256) ----
REM v22.23.2: bundled SQLite ships FTS5 (law_fts full-text search depends on it;
REM v22.14.0 lacks FTS5 and MATCH throws "no such module: fts5" -- see the
REM comments in scripts/download-node.sh).
set "NODE_VERSION=22.23.2"
set "NODE_ZIP=node-v%NODE_VERSION%-win-%TARGET_ARCH%.zip"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ZIP%"
set "NODE_EXE=%RESOURCES%\node-bin\node.exe"

if exist "%NODE_EXE%" (
    set "CUR_ARCH="
    for /f "delims=" %%a in ('"%NODE_EXE%" -p process.arch 2^>nul') do set "CUR_ARCH=%%a"
    if "!CUR_ARCH!"=="%TARGET_ARCH%" (
        echo [4] Node.js already present ^(!CUR_ARCH!^), skipping download
        goto :node_ok
    )
    echo   Existing node.exe is !CUR_ARCH! but target is %TARGET_ARCH% - re-downloading
)

echo.
echo [4] Downloading Node.js v%NODE_VERSION% ^(%TARGET_ARCH%^)...
mkdir "%RESOURCES%\node-bin" 2>nul
cd /d "%RESOURCES%\node-bin"
curl -fsSL -o "%NODE_ZIP%" "%NODE_URL%"
if errorlevel 1 (
    echo ERROR: Node download failed ^(network/proxy?^)
    exit /b 1
)
REM SHA256 check (same pattern as download-node.sh)
curl -fsSL -o SHASUMS256.txt "https://nodejs.org/dist/v%NODE_VERSION%/SHASUMS256.txt"
set "EXPECTED_HASH="
for /f "usebackq delims=" %%l in (`findstr /c:"%NODE_ZIP%" SHASUMS256.txt`) do (
    for /f "tokens=1" %%h in ("%%l") do set "EXPECTED_HASH=%%h"
)
if not defined EXPECTED_HASH (
    echo ERROR: could not find SHA256 line for %NODE_ZIP% in SHASUMS256.txt
    exit /b 1
)
for /f "delims=" %%h in ('powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 '%NODE_ZIP%').Hash.ToLower()"') do set "ACTUAL_HASH=%%h"
if /i not "!ACTUAL_HASH!"=="!EXPECTED_HASH!" (
    echo ERROR: SHA256 mismatch for %NODE_ZIP%
    echo   expected: !EXPECTED_HASH!
    echo   actual:   !ACTUAL_HASH!
    exit /b 1
)
echo   SHA256 OK
tar xf "%NODE_ZIP%" "node-v%NODE_VERSION%-win-%TARGET_ARCH%/node.exe"
if errorlevel 1 (
    echo ERROR: Node archive extraction failed
    exit /b 1
)
move /y "node-v%NODE_VERSION%-win-%TARGET_ARCH%\node.exe" node.exe >nul
if errorlevel 1 (
    echo ERROR: Node binary move failed
    exit /b 1
)
rd /s /q "node-v%NODE_VERSION%-win-%TARGET_ARCH%"
del "%NODE_ZIP%" SHASUMS256.txt 2>nul
:node_ok
echo OK: Node v%NODE_VERSION% ^(%TARGET_ARCH%^)

REM ---- Step 4b: rebuild native deps (match bundled Node ABI) ----
REM pnpm install --ignore-scripts skips all postinstalls: better-sqlite3
REM (has prebuilds but rebuild anyway), sharp (libvips prebuilt binaries are
REM fetched by its install script, must rebuild), node-pty / mupdf (node-gyp
REM compile, must rebuild). Rebuild each with the bundled node's npm so the
REM artifact matches the runtime ABI.
echo.
echo [4b] Rebuilding native deps for bundled Node...
cd /d "%REPO_ROOT%"
set "PATH=%RESOURCES%\node-bin;%PATH%"
set "NPM_CMD="
for /f "delims=" %%i in ('where npm.cmd 2^>nul') do (
    if not defined NPM_CMD set "NPM_CMD=%%i"
)
if not defined NPM_CMD (
    echo ERROR: npm.cmd not found
    exit /b 1
)
for %%i in ("%NPM_CMD%") do set "NPM_DIR=%%~dpi"
set "NPM_CLI=%NPM_DIR%node_modules\npm\bin\npm-cli.js"
if not exist "%NPM_CLI%" (
    echo ERROR: npm-cli.js not found: %NPM_CLI%
    exit /b 1
)
for %%p in (better-sqlite3 sharp node-pty mupdf) do (
    echo   Rebuilding %%p...
    "%RESOURCES%\node-bin\node.exe" "%NPM_CLI%" rebuild %%p
    if errorlevel 1 (
        if "%%p"=="sharp" (
            echo   ERROR: sharp rebuild failed. sharp's libvips prebuilt binaries are
            echo          fetched by its install script, which pnpm --ignore-scripts
            echo          skipped; without a working rebuild the packaged app crashes
            echo          on image processing. Aborting build.
            exit /b 1
        )
        echo   WARN: rebuild failed for %%p - using the shipped prebuilt binary.
        echo   WARN: the npm packages ship ABI-correct prebuilds, so this is not fatal.
        echo   WARN: verify-installer.bat L1 will confirm it loads under the bundled Node.
        echo   WARN: node-pty fails its own tsc prepare step yet loads fine via prebuilds.
    ) else (
        echo   %%p rebuilt OK
    )
)
echo OK

REM ---- Step 5: download Bun for Windows (per target arch + SHA256) ----
set "BUN_VERSION=1.3.10"
set "BUN_ZIP=bun-windows-%TARGET_ARCH%.zip"
set "BUN_URL=https://github.com/oven-sh/bun/releases/download/bun-v%BUN_VERSION%/%BUN_ZIP%"
set "BUN_EXE=%RESOURCES%\bun-bin\bun.exe"

if exist "%BUN_EXE%" (
    set "CUR_ARCH="
    for /f "delims=" %%a in ('"%BUN_EXE%" -p process.arch 2^>nul') do set "CUR_ARCH=%%a"
    if "!CUR_ARCH!"=="%TARGET_ARCH%" (
        echo [5] Bun already present ^(!CUR_ARCH!^), skipping download
        goto :bun_ok
    )
    echo   Existing bun.exe is !CUR_ARCH! but target is %TARGET_ARCH% - re-downloading
)

echo.
echo [5] Downloading Bun v%BUN_VERSION% ^(%TARGET_ARCH%^)...
mkdir "%RESOURCES%\bun-bin" 2>nul
cd /d "%RESOURCES%\bun-bin"
curl -fsSL -o "%BUN_ZIP%" "%BUN_URL%"
if errorlevel 1 (
    echo ERROR: Bun download failed ^(network/proxy?^)
    exit /b 1
)
REM SHA256 check: Bun releases ship a SHASUMS256.txt; if the entry is missing,
REM degrade to a warning (--version is still the last line of defense), but never
REM silently accept a bad package (same pattern as download-bun.sh).
curl -fsSL -o SHASUMS256.txt "https://github.com/oven-sh/bun/releases/download/bun-v%BUN_VERSION%/SHASUMS256.txt" 2>nul
set "EXPECTED_HASH="
if exist SHASUMS256.txt (
    for /f "usebackq delims=" %%l in (`findstr /c:"%BUN_ZIP%" SHASUMS256.txt`) do (
        for /f "tokens=1" %%h in ("%%l") do set "EXPECTED_HASH=%%h"
    )
)
if defined EXPECTED_HASH (
    for /f "delims=" %%h in ('powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 '%BUN_ZIP%').Hash.ToLower()"') do set "ACTUAL_HASH=%%h"
    if /i not "!ACTUAL_HASH!"=="!EXPECTED_HASH!" (
        echo ERROR: SHA256 mismatch for %BUN_ZIP%
        exit /b 1
    )
    echo   SHA256 OK
) else (
    echo   WARN: %BUN_ZIP% not listed in SHASUMS256.txt; skipping checksum
)
tar xf "%BUN_ZIP%" "bun-windows-%TARGET_ARCH%/bun.exe"
if errorlevel 1 (
    echo ERROR: Bun archive extraction failed
    exit /b 1
)
move /y "bun-windows-%TARGET_ARCH%\bun.exe" bun.exe >nul
if errorlevel 1 (
    echo ERROR: Bun binary move failed
    exit /b 1
)
rd /s /q "bun-windows-%TARGET_ARCH%"
del "%BUN_ZIP%" SHASUMS256.txt 2>nul
"%BUN_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: bun.exe did not run; installer would ship without the Bun runtime
    exit /b 1
)
:bun_ok
echo OK: Bun v%BUN_VERSION% ^(%TARGET_ARCH%^)

REM ---- Step 6: build satiui (vite) ----
if %SKIP_BUILD%==0 (
    echo.
    echo [6] Building satiui ^(vite^)...
    cd /d "%UI_DIR%"
    call npx vite build
    if errorlevel 1 (
        echo ERROR: vite build failed
        exit /b 1
    )
    echo OK
) else (
    echo [6] Skipping builds ^(--skip-build^)
    goto :skip_builds
)

REM ---- Step 7: build memory-core + sati-main (tsc) ----
echo.
echo [7] Building memory-core + sati-main ^(tsc^)...
cd /d "%MEMORY_DIR%"
if exist lib rd /s /q lib
call npx tsc -p tsconfig.json
if errorlevel 1 (
    echo ERROR: memory-core tsc build failed
    exit /b 1
)
cd /d "%REPO_ROOT%"
call npx tsc -p tsconfig.json
if errorlevel 1 (
    echo ERROR: tsc build failed
    exit /b 1
)
mkdir dist\src\extension\plugins 2>nul
xcopy /E /I /Y src\extension\plugins\builtin dist\src\extension\plugins\builtin >nul
echo OK

REM ---- Step 8: create bundle tars (exclude lists aligned with release.sh) ----
echo.
echo [8] Creating bundle tars...

REM satiui bundle: only dev deps and caches excluded (UI deps are in dist/ via vite)
cd /d "%UI_DIR%"
tar cf "%RESOURCES%\satiui-bundle.tar" ^
    --exclude=node_modules/.pnpm/electron* --exclude=node_modules/.pnpm/@electron* ^
    --exclude=node_modules/.pnpm/node_modules/@sati ^
    --exclude=node_modules/electron --exclude=*.map ^
    --exclude=node_modules/.cache --exclude=node_modules/.bin ^
    --exclude=node_modules/typescript --exclude=node_modules/@typescript ^
    --exclude=node_modules/@babel --exclude=node_modules/playwright-core ^
    --exclude=node_modules/@vitest --exclude=node_modules/vitest ^
    --exclude=node_modules/@types --exclude=node_modules/prettier ^
    --exclude=node_modules/oxlint --exclude=node_modules/@esbuild ^
    --exclude=node_modules/esbuild --exclude=node_modules/rollup ^
    --exclude=node_modules/@rollup --exclude=node_modules/eslint ^
    --exclude=node_modules/@eslint --exclude=node_modules/vite ^
    --exclude=node_modules/@vitejs ^
    --exclude=node_modules/**/examples --exclude=node_modules/**/test ^
    --exclude=node_modules/**/tests --exclude=node_modules/**/__tests__ ^
    --exclude=node_modules/**/*.md ^
    package.json server shared dist scripts node_modules
if errorlevel 1 (
    echo ERROR: satiui tar creation failed
    exit /b 1
)
echo   satiui-bundle.tar OK

REM sati-main bundle: additionally exclude browser-only UI deps (not imported by
REM the backend; verified zero references by import scan). Also exclude the
REM workspace's own @sati/desktop junction under .pnpm/node_modules - without
REM it, tar walks into apps/desktop/ (resources/*.tar, dist-electron, ...) via
REM the pnpm junction and balloons the bundle to multiple GB ("Can't add
REM archive to itself").
cd /d "%REPO_ROOT%"
tar cf "%RESOURCES%\sati-main-bundle.tar" ^
    --exclude=node_modules/.pnpm/electron* --exclude=node_modules/.pnpm/@electron* ^
    --exclude=node_modules/.pnpm/node_modules/@sati ^
    --exclude=node_modules/electron --exclude=*.map ^
    --exclude=node_modules/.cache --exclude=node_modules/.bin ^
    --exclude=node_modules/typescript --exclude=node_modules/@typescript ^
    --exclude=node_modules/@babel --exclude=node_modules/playwright-core ^
    --exclude=node_modules/@vitest --exclude=node_modules/vitest ^
    --exclude=node_modules/@types --exclude=node_modules/prettier ^
    --exclude=node_modules/oxlint --exclude=node_modules/@esbuild ^
    --exclude=node_modules/esbuild --exclude=node_modules/rollup ^
    --exclude=node_modules/@rollup --exclude=node_modules/eslint ^
    --exclude=node_modules/@eslint --exclude=node_modules/vite ^
    --exclude=node_modules/@vitejs ^
    --exclude=node_modules/**/examples --exclude=node_modules/**/test ^
    --exclude=node_modules/**/tests --exclude=node_modules/**/__tests__ ^
    --exclude=node_modules/**/*.md ^
    --exclude=node_modules/.pnpm/echarts* --exclude=node_modules/.pnpm/@univerjs* ^
    --exclude=node_modules/.pnpm/mermaid* --exclude=node_modules/.pnpm/lucide-react* ^
    --exclude=node_modules/.pnpm/react-syntax-highlighter* --exclude=node_modules/.pnpm/prismjs* ^
    --exclude=node_modules/.pnpm/shiki* --exclude=node_modules/.pnpm/@shikijs* ^
    --exclude=node_modules/.pnpm/pdfjs-dist* --exclude=node_modules/.pnpm/tailwindcss* ^
    --exclude=node_modules/.pnpm/caniuse-lite* --exclude=node_modules/.pnpm/unicode-regex* ^
    --exclude=node_modules/.pnpm/katex* --exclude=node_modules/.pnpm/date-fns* ^
    --exclude=node_modules/.pnpm/rxjs* --exclude=node_modules/.pnpm/jsdom* ^
    --exclude=node_modules/.pnpm/@biomejs* --exclude=node_modules/.pnpm/biome* ^
    --exclude=node_modules/.pnpm/eslint-plugin-* --exclude=node_modules/.pnpm/@typescript-eslint* ^
    --exclude=node_modules/.pnpm/app-builder-lib* --exclude=node_modules/.pnpm/@dnd-kit* ^
    --exclude=node_modules/.pnpm/framer-motion* --exclude=node_modules/.pnpm/clsx* ^
    --exclude=node_modules/.pnpm/class-variance-authority* --exclude=node_modules/.pnpm/@radix-ui* ^
    --exclude=node_modules/.pnpm/@floating-ui* --exclude=node_modules/.pnpm/@hookform* ^
    --exclude=node_modules/.pnpm/react-hook-form* --exclude=node_modules/.pnpm/sonner* ^
    --exclude=node_modules/.pnpm/@tanstack* --exclude=node_modules/.pnpm/recharts* ^
    --exclude=node_modules/.pnpm/@emotion* --exclude=node_modules/.pnpm/@mui* ^
    --exclude=node_modules/.pnpm/@types+react* --exclude=node_modules/.pnpm/@types+react-dom* ^
    --exclude=node_modules/.pnpm/csstype* ^
    --exclude=apps --exclude=ui --exclude=old_ui ^
    --exclude=edgeclaw-memory-core --exclude=docs --exclude=tests ^
    --exclude=third-party --exclude=dist/tests --exclude=dist/scripts ^
    --exclude=.git --exclude=packages ^
    src dist\src scripts node_modules vendor package.json tsconfig.json
if errorlevel 1 (
    echo ERROR: sati-main tar creation failed
    exit /b 1
)
echo   sati-main-bundle.tar OK

cd /d "%MEMORY_DIR%"
tar cf "%RESOURCES%\sati-memory-core-bundle.tar" ^
    package.json lib ui-source
if errorlevel 1 (
    echo ERROR: sati-memory-core tar creation failed
    exit /b 1
)
echo   sati-memory-core-bundle.tar OK

:skip_builds

REM ---- Step 9: emit build-info.json ----
echo.
echo [9] Generating build-info.json...
cd /d "%REPO_ROOT%"
for /f "delims=" %%i in ('git rev-parse --short HEAD 2^>nul') do set "GIT_SHA=%%i"
for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set "GIT_FULL_SHA=%%i"
for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "GIT_BRANCH=%%i"

REM ISO date: %date% substring slicing depends on the locale format, so use
REM PowerShell to get a fixed yyyy-MM-dd.
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "BUILD_DATE=%%i"

REM Signing mode marker: win-signed iff CSC_LINK is set and not --skip-sign
if %SKIP_SIGN%==1 (
    set "BUILD_MODE=win-unsigned"
) else if defined CSC_LINK (
    set "BUILD_MODE=win-signed"
) else (
    set "BUILD_MODE=win-unsigned"
)

mkdir "%DESKTOP_DIR%dist" 2>nul
echo {"version":"%VERSION%","gitSha":"%GIT_SHA%","gitFullSha":"%GIT_FULL_SHA%","gitBranch":"%GIT_BRANCH%","buildDate":"%BUILD_DATE%","mode":"%BUILD_MODE%"} > "%DESKTOP_DIR%dist\build-info.json"
echo OK: v%VERSION% ^(%GIT_SHA%^) mode=%BUILD_MODE%

REM ---- Step 10: compile desktop TypeScript ----
echo.
echo [10] Compiling desktop TypeScript...
cd /d "%DESKTOP_DIR%"
call npx tsc
if errorlevel 1 (
    echo ERROR: desktop tsc failed
    exit /b 1
)
echo OK

REM ---- Step 11: electron-builder ----
echo.
echo [11] Running electron-builder ^(--win --%TARGET_ARCH%^)...

if %SKIP_SIGN%==1 (
    set "CSC_IDENTITY_AUTO_DISCOVERY=false"
    echo   Signing: skipped ^(--skip-sign^)
) else if defined CSC_LINK (
    echo   Signing: Authenticode via CSC_LINK ^(CSC_KEY_PASSWORD required if the key is encrypted^)
) else (
    set "CSC_IDENTITY_AUTO_DISCOVERY=false"
    echo   WARN: no CSC_LINK set - installer will be UNSIGNED.
    echo         Users will see SmartScreen "unknown publisher" warning.
    echo         To sign, set CSC_LINK + CSC_KEY_PASSWORD, see RELEASING.md.
)

call npx electron-builder --win --%TARGET_ARCH%
if errorlevel 1 (
    echo ERROR: electron-builder failed
    exit /b 1
)

echo.
echo ========================================
echo  Build complete!
echo ========================================
echo.
echo Output:
dir /b "%DESKTOP_DIR%dist-electron\*.exe"
echo.
echo Location: %DESKTOP_DIR%dist-electron\
echo.
echo Next steps:
echo   verify-installer.bat                              L1 artifact smoke
echo   node scripts\release-l2-win.mjs dist-electron\win-unpacked   L2 smoke
echo   node scripts\publish-win.mjs dist-electron         publish to GitHub Releases
