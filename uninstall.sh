#!/usr/bin/env bash

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure scripts have execute permission
chmod +x "$0" "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/uninstall.sh" 2>/dev/null || true

# Locate Node.js runtime (handling standard paths, user NVM/fnm/volta/pnpm under sudo)
find_node_dir() {
    if command -v node >/dev/null 2>&1; then
        local node_bin
        node_bin="$(command -v node)"
        echo "${node_bin%/*}"
        return 0
    fi
    for p in /usr/local/bin; do
        if [ -f "$p/node" ] && [ -x "$p/node" ]; then
            echo "$p"
            return 0
        fi
    done
    local homes=()
    [ -n "$HOME" ] && homes+=("$HOME")
    if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
        local sudo_home=""
        if command -v getent >/dev/null 2>&1; then
            local entry
            entry=$(getent passwd "$SUDO_USER" 2>/dev/null || true)
            if [ -n "$entry" ]; then
                local old_ifs="$IFS"
                IFS=:
                set -- $entry
                IFS="$old_ifs"
                sudo_home="$6"
            fi
        fi
        [ -z "$sudo_home" ] && sudo_home="/home/$SUDO_USER"
        [ "$sudo_home" != "$HOME" ] && homes+=("$sudo_home")
    fi
    for h in "${homes[@]}"; do
        [ -d "$h" ] || continue
        # Direct common paths
        for cand in \
            "$h/.local/bin" \
            "$h/bin" \
            "$h/.volta/bin" \
            "$h/.asdf/shims" \
            "$h/.n/bin" \
            "$h/.local/share/pnpm" \
            "$h/.nvm/current/bin" \
            "$h/.local/share/fnm/current/bin"; do
            if [ -f "$cand/node" ] && [ -x "$cand/node" ]; then
                echo "$cand"
                return 0
            fi
        done
        # NVM version directories (select latest version)
        local latest_nvm=""
        for nvm_node in "$h"/.nvm/versions/node/*/bin/node; do
            if [ -f "$nvm_node" ] && [ -x "$nvm_node" ]; then
                latest_nvm="$nvm_node"
            fi
        done
        if [ -n "$latest_nvm" ]; then
            echo "${latest_nvm%/*}"
            return 0
        fi
        # FNM version directories (select latest version)
        local latest_fnm=""
        for fnm_node in "$h"/.local/share/fnm/node-versions/*/installation/bin/node; do
            if [ -f "$fnm_node" ] && [ -x "$fnm_node" ]; then
                latest_fnm="$fnm_node"
            fi
        done
        if [ -n "$latest_fnm" ]; then
            echo "${latest_fnm%/*}"
            return 0
        fi
    done
    for p in /usr/bin /bin /usr/sbin /sbin; do
        if [ -f "$p/node" ] && [ -x "$p/node" ]; then
            echo "$p"
            return 0
        fi
    done
    return 1
}

NODE_DIR=$(find_node_dir || true)
if [ -n "$NODE_DIR" ]; then
    export PATH="$NODE_DIR:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
    echo "[错误] 未检测到 Node.js 环境，请先安装 Node.js (v16+) 后再运行此脚本。"
    exit 1
fi

# Check if target installation directory requires elevated permissions
set +e
node "$SCRIPT_DIR/localization_engine.js" --check-write "$@" >/dev/null 2>&1
CHECK_STATUS=$?
set -e

if [ "$CHECK_STATUS" -eq 2 ] && [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        echo "[提示] 检测到 Antigravity 安装在系统目录，需要管理员权限，正在请求提权..."
        if [ -x "$SCRIPT_DIR/uninstall.sh" ]; then
            exec sudo env "PATH=$PATH" "$SCRIPT_DIR/uninstall.sh" "$@"
        else
            exec sudo env "PATH=$PATH" bash "$SCRIPT_DIR/uninstall.sh" "$@"
        fi
    else
        echo "[权限不足] 目标安装目录位于系统目录，需要 root 权限，且当前环境未找到 sudo 命令。"
        echo "请切换为 root 用户后重新运行此脚本。"
        exit 1
    fi
fi

echo ""
echo "[1/2] 正在还原官方文件..."
if ! node "$SCRIPT_DIR/localization_engine.js" --huifu "$@"; then
    echo ""
    echo "[错误] 还原失败，请检查上方错误信息。"
    if [ "$(id -u)" -ne 0 ]; then
        echo "提示：如果上方显示“权限不足”或 “EACCES”，请使用 sudo 重新运行此脚本。"
        echo "示例：sudo ./uninstall.sh"
    fi
    exit 1
fi

echo ""
echo "[2/2] 还原完成！"
echo ""
echo "提示：Antigravity 已恢复至官方原版英文状态。"
