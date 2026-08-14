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

REM ---- overall build timer (epoch seconds via PowerShell, locale-safe) ----
for /f "delims=" %%t in ('powershell -NoProfile -Command "(Get-Date -UFormat %%s)"') do set "BUILD_START_S=%%t"

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
cd /d "%REPO_ROOT%"
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
REM apps/desktop is a pnpm-workspace member, so the single root install covers
REM the desktop deps (electron, electron-builder, yaml) - the old second
REM `pnpm install` in apps/desktop was redundant resolution/network time.
if %SKIP_INSTALL%==0 (
    echo.
    echo [3] Installing dependencies ^(pnpm^)...
    cd /d "%REPO_ROOT%"
    call corepack pnpm install --ignore-scripts
    if errorlevel 1 (
        echo ERROR: pnpm install failed
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

REM ---- Step 4b: native-deps preflight (bundled Node) ----
REM Every native module ships an ABI-correct prebuilt binary for the bundled
REM Node runtime, so the old `npm rebuild better-sqlite3 sharp node-pty mupdf`
REM loop was pure waste: 5-15 min of node-gyp/MSVC per build, and it silently
REM degraded to a warning when MSVC was absent. Verified under bundled Node
REM v22.23.2: better-sqlite3@13 ships prebuilds/win32-x64.node (FTS5 included),
REM node-pty@1.1 ships prebuilds/win32-x64/pty.node, sharp's binary is the
REM @img/sharp-* optional dep, mupdf is pure WASM. check-native-win.mjs loads
REM all four with the bundled node and fails fast if that assumption breaks.
echo.
echo [4b] Preflighting native deps under bundled Node...
"%RESOURCES%\node-bin\node.exe" "%DESKTOP_DIR%scripts\check-native-win.mjs"
if errorlevel 1 (
    echo ERROR: native-deps preflight failed - see messages above.
    echo   Fix: re-run pnpm install with scripts enabled, or bump pnpm-lock.yaml.
    exit /b 1
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
REM node_modules/.pnpm/node_modules is the pnpm public-hoist root: on Windows
REM bsdtar follows its junctions and materializes full copies of every hoisted
REM package (638MB/60k entries in sati-main; here the ui .pnpm is a junction to
REM the root store that tar does not follow, so this is a no-op that guards the
REM layout). The runtime re-links top-level entries to the vstore directly, so
REM the hoist root is never needed after extraction.
cd /d "%UI_DIR%"
tar cf "%RESOURCES%\satiui-bundle.tar" ^
    --exclude=node_modules/.pnpm/electron* --exclude=node_modules/.pnpm/@electron* ^
    --exclude=node_modules/.pnpm/node_modules ^
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
REM the backend; verified zero references by import scan). The big one is the
REM pnpm public-hoist root node_modules/.pnpm/node_modules: on Windows bsdtar
REM FOLLOWS its junctions and materializes a full copy of every hoisted package
REM (~638MB / 59,919 entries of the 1.45GB tar - the previous per-package
REM excludes like --exclude=node_modules/.pnpm/@univerjs* only removed the
REM vstore copy while the same packages leaked back in through the hoist root).
REM Excluding the whole root drops the tar to ~745MB; the runtime's
REM reconstructPnpmLinks() re-creates top-level junctions straight from the
REM vstore, so the hoist root is never needed after extraction (verified: its
REM 866 entries have vstore equivalents except 18 dev/browser-only orphans).
REM (This also covers the old @sati/desktop junction worry: the whole hoist
REM root, @sati/desktop included, is gone.)
cd /d "%REPO_ROOT%"
tar cf "%RESOURCES%\sati-main-bundle.tar" ^
    --exclude=node_modules/.pnpm/electron* --exclude=node_modules/.pnpm/@electron* ^
    --exclude=node_modules/.pnpm/node_modules ^
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

REM Remove stale installers before building:
REM   1) arch-ambiguous "Sati-<ver>-win.exe" (combined x64+arm64 NSIS that
REM      electron-builder emitted while win.target.arch was a list - the
REM      historical 800MB+ junk; publish-win.mjs must never see it)
REM   2) per-arch installers from other versions (0.0.24/0.0.26 leftovers,
REM      ~1.7GB, confuse the dir listing; publish already filters by version)
REM Same-version other-arch files (e.g. Sati-0.0.27-win-arm64.exe from an
REM earlier --arm64 run) are kept.
for %%f in ("%DESKTOP_DIR%dist-electron\Sati-*-win.exe") do (
    if exist "%%f" (
        del "%%f" "%%~nf.exe.blockmap" 2>nul
        echo   Removed arch-ambiguous installer: %%~nxf
    )
)
for %%f in ("%DESKTOP_DIR%dist-electron\Sati-*-win-*.exe") do (
    if exist "%%f" (
        set "FN=%%~nxf"
        echo !FN! | findstr /r /c:"^Sati-%VERSION%-win-" >nul
        if errorlevel 1 (
            del "%%f" "%%~nf.exe.blockmap" 2>nul
            echo   Removed stale installer: !FN!
        )
    )
)

REM CN-friendly download mirrors: electron-builder fetches the electron zip's
REM SHASUMS + winCodeSign/nsis from GitHub, which routinely stalls for the full
REM 10-min request timeout on CN networks ("Timeout awaiting 'request'"). The
REM npmmirror CDN mirrors all three; only set as defaults, so explicit env vars
REM win for users who prefer GitHub.
if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
if not defined ELECTRON_BUILDER_BINARIES_MIRROR set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

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
set "BUILD_END_S="
for /f "delims=" %%t in ('powershell -NoProfile -Command "(Get-Date -UFormat %%s)"') do set "BUILD_END_S=%%t"
if defined BUILD_START_S if defined BUILD_END_S (
    set /a BUILD_SECS=BUILD_END_S - BUILD_START_S
    echo Total build time: !BUILD_SECS! seconds ^(about !BUILD_SECS!/60 minutes^)
)
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
