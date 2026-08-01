#!/usr/bin/env bash
# Backup / restore the user's real ~/.sati (only when a test opts in).
# Default L1/L2 sandboxes never call these — they use SATI_HOME under a temp dir.

sati_user_config__real_home() {
  echo "${HOME}/.sati"
}

# Copy ~/.sati → ~/.sati.backup-release-smoke.<pid>
sati_user_config_backup() {
  local real
  real="$(sati_user_config__real_home)"
  SATI_USER_CONFIG_BACKUP="${real}.backup-release-smoke.$$"
  if [[ ! -e "$real" ]]; then
    SATI_USER_CONFIG_HAD_CONFIG=0
    return 0
  fi
  SATI_USER_CONFIG_HAD_CONFIG=1
  rm -rf "$SATI_USER_CONFIG_BACKUP"
  cp -a "$real" "$SATI_USER_CONFIG_BACKUP"
  echo "  backed up ${real} → ${SATI_USER_CONFIG_BACKUP}"
}

# Restore from backup; removes smoke-written config if there was no prior config.
sati_user_config_restore() {
  local real
  real="$(sati_user_config__real_home)"
  if [[ "${SATI_USER_CONFIG_HAD_CONFIG:-0}" == "1" && -d "${SATI_USER_CONFIG_BACKUP:-}" ]]; then
    rm -rf "$real"
    mv "$SATI_USER_CONFIG_BACKUP" "$real"
    echo "  restored ${real} from backup"
  elif [[ "${SATI_USER_CONFIG_HAD_CONFIG:-0}" == "0" && -d "$real" ]]; then
    rm -rf "$real"
    echo "  removed smoke-created ${real} (no prior config)"
  fi
  unset SATI_USER_CONFIG_BACKUP SATI_USER_CONFIG_HAD_CONFIG
}
