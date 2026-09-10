#!/usr/bin/env bash

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

for node_dir in \
    "/opt/homebrew/bin" \
    "/usr/local/bin" \
    "/opt/local/bin" \
    "$HOME/.volta/bin" \
    "$HOME/.asdf/shims" \
    "$HOME/.local/share/mise/shims" \
    "$HOME/Library/pnpm" \
    "$HOME/.fnm/current/bin"
do
    if [ -d "$node_dir" ]; then
        PATH="$node_dir:$PATH"
    fi
done

if [ -d "$HOME/.nvm/versions/node" ]; then
    latest_nvm_ver="$(cd "$HOME/.nvm/versions/node" 2>/dev/null && ls -d v* 2>/dev/null | sort -t. -k 1.2,1n -k 2,2n -k 3,3n | tail -n 1)"
    if [ -n "$latest_nvm_ver" ] && [ -d "$HOME/.nvm/versions/node/$latest_nvm_ver/bin" ]; then
        PATH="$HOME/.nvm/versions/node/$latest_nvm_ver/bin:$PATH"
    fi
fi

if [ -s "$HOME/.nvm/nvm.sh" ] && ! command -v node >/dev/null 2>&1; then
    # shellcheck disable=SC1091
    \. "$HOME/.nvm/nvm.sh" 2>/dev/null || true
fi

export PATH

if ! command -v node >/dev/null 2>&1; then
    echo ""
    echo "[错误] 未检测到 Node.js 环境！"
    echo "反重力汉化工具需要 Node.js 支持（建议 v16 或更高版本）。"
    echo "请访问 https://nodejs.org/ 下载安装，或使用 Homebrew 安装："
    echo "  brew install node"
    echo ""
    if [ -t 0 ]; then
        read -rp "按 Enter 键退出..." _
    fi
    exit 1
fi

set +e
/usr/bin/env bash "$SCRIPT_DIR/uninstall.sh" "$@"
UNINSTALL_EXIT=$?
set -e

if [ -t 0 ]; then
    echo ""
    read -rp "按 Enter 键退出..." _
fi
exit $UNINSTALL_EXIT
