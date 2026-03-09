#!/usr/bin/env bash
set -euo pipefail

# [WHY] 一键执行 Web 构建、Capacitor 同步和 Android Release 编译
# [WHAT] 按固定顺序运行：npm run build -> npx cap sync -> ./gradlew assembleRelease

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$REPO_ROOT/android"

log() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf '\n[ERROR] %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "未找到命令: $1"
}

check_java() {
  require_cmd java

  local java_version_output java_major
  java_version_output="$(java -version 2>&1 | head -n 1)"
  java_major="$(java -XshowSettings:properties -version 2>&1 | awk -F'= ' '/java.specification.version/ {print $2; exit}')"

  if [[ -z "$java_major" ]]; then
    printf '[WARN] 无法自动识别 JDK 版本，当前信息: %s\n' "$java_version_output"
    return
  fi

  if [[ "$java_major" != "21" ]]; then
    printf '[WARN] 当前 JDK 版本为 %s，Release 构建建议使用 JDK 21\n' "$java_major"
    printf '[WARN] java -version: %s\n' "$java_version_output"
  else
    printf '[INFO] 检测到 JDK 21\n'
  fi
}

require_cmd npm
require_cmd npx
require_cmd bash
check_java

cd "$REPO_ROOT"
log '构建 Web 资源'
npm run build

log '同步 Capacitor 到 Android'
npx cap sync

[[ -d "$ANDROID_DIR" ]] || fail "Android 工程目录不存在: $ANDROID_DIR"
cd "$ANDROID_DIR"

[[ -x "./gradlew" ]] || chmod +x ./gradlew

log '编译 Android Release'
./gradlew assembleRelease

log '完成'
printf '[INFO] Release APK/AAB 输出请查看 android/app/build/outputs/\n'
