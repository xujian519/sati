#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# node:sqlite 需启用 FTS5（law_search 的 law_fts 全文检索依赖）。
# v22.14.0 的 bundled SQLite 未编译 FTS5（MATCH 抛 no such module: fts5），
# 首个带 FTS5 的 22.x 为 v22.18.0，此处取最新 22.x LTS 补丁。
NODE_VERSION="22.23.2"
ARCHIVE="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
OUT_DIR="${ROOT}/resources/node-bin"
OUT_BIN="${OUT_DIR}/node"
EXPECTED_VER="v${NODE_VERSION}"

if [[ -x "${OUT_BIN}" ]]; then
  ver="$("${OUT_BIN}" --version 2>/dev/null || true)"
  if [[ "${ver}" == "${EXPECTED_VER}" ]]; then
    echo "Node ${EXPECTED_VER} already present at ${OUT_BIN}; skipping download."
    exit 0
  fi
  echo "Existing binary reports '${ver}', expected '${EXPECTED_VER}'; re-downloading."
fi

mkdir -p "${OUT_DIR}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "Downloading ${BASE_URL}/${ARCHIVE} ..."
curl -fsSL "${BASE_URL}/${ARCHIVE}" -o "${TMP}/${ARCHIVE}"

echo "Downloading SHASUMS256.txt for checksum verification ..."
curl -fsSL "${BASE_URL}/SHASUMS256.txt" -o "${TMP}/SHASUMS256.txt"

LINE="$(grep -F "${ARCHIVE}" "${TMP}/SHASUMS256.txt" | head -n1)"
if [[ -z "${LINE}" ]]; then
  echo "error: could not find SHA256 line for ${ARCHIVE} in SHASUMS256.txt" >&2
  exit 1
fi
EXPECTED_SHA256="$(awk '{print $1}' <<< "${LINE}")"

ACTUAL_SHA256="$(shasum -a 256 "${TMP}/${ARCHIVE}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
  echo "error: SHA256 mismatch for ${ARCHIVE}" >&2
  echo "  expected: ${EXPECTED_SHA256}" >&2
  echo "    actual: ${ACTUAL_SHA256}" >&2
  exit 1
fi

echo "SHA256 OK (${ACTUAL_SHA256})"

TAR_PREFIX="node-v${NODE_VERSION}-darwin-arm64"
tar -xzf "${TMP}/${ARCHIVE}" -C "${TMP}" "${TAR_PREFIX}/bin/node"
install -m 0755 "${TMP}/${TAR_PREFIX}/bin/node" "${OUT_BIN}"

VERIFY="$("${OUT_BIN}" --version)"
if [[ "${VERIFY}" != "${EXPECTED_VER}" ]]; then
  echo "error: ${OUT_BIN} --version returned '${VERIFY}', expected '${EXPECTED_VER}'" >&2
  exit 1
fi

echo "Installed ${VERIFY} -> ${OUT_BIN}"
