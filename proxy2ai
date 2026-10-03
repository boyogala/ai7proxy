#!/usr/bin/env bash

# ==============================================================================
# ai7proxy - Linux (Debian/Ubuntu) 一键部署与后台常驻管理脚本 (proxy2ai)
# ==============================================================================

set -e

# 获取脚本所在的真实项目目录
SCRIPT_PATH="$(readlink -f "$0")"
PROJECT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
SERVICE_NAME="ai7proxy"
PORT=7749

# 颜色输出定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 必须具备 root 权限以配置系统服务和全局命令
check_root() {
    if [ "$EUID" -ne 0 ]; then
        echo -e "${RED}[错误] 请使用 sudo 或 root 权限运行此命令！例如: sudo proxy2ai${NC}"
        exit 1
    fi
}

# 1. 检测并安装 Node.js (推荐 v20+ / v22 LTS)
check_and_install_node() {
    local need_install=false

    if ! command -v node >/dev/null 2>&1; then
        need_install=true
    else
        NODE_VER=$(node -v | tr -d 'v' | cut -d'.' -f1)
        if [ "$NODE_VER" -lt 20 ]; then
            echo -e "${YELLOW}[提示] 当前 Node.js 版本 (v$NODE_VER) 低于推荐要求 (v20+)，准备升级...${NC}"
            need_install=true
        fi
    fi

    if [ "$need_install" = true ]; then
        echo -e "${BLUE}[1/4] 正在安装 Node.js 22 LTS 与构建工具...${NC}"
        apt-get update -y
        apt-get install -y curl ca-certificates gnupg build-essential
        mkdir -p /etc/apt/keyrings
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
        apt-get update -y
        apt-get install -y nodejs
        echo -e "${GREEN}[✔] Node.js $(node -v) 与 npm $(npm -v) 安装成功！${NC}"
    else
        echo -e "${GREEN}[✔] Node.js 环境合格: $(node -v)${NC}"
    fi
}

# 2. 编译并构建项目
build_project() {
    echo -e "${BLUE}[2/4] 正在安装依赖并编译 TypeScript...${NC}"
    cd "$PROJECT_DIR"
    npm install
    npm run build
    echo -e "${GREEN}[✔] 项目编译完成！${NC}"
}

# 3. 注册为 systemd 系统后台守护服务
setup_systemd() {
    echo -e "${BLUE}[3/4] 正在配置后台守护进程 (systemd)...${NC}"
    NODE_BIN=$(which node)

    cat <<EOF > /etc/systemd/system/${SERVICE_NAME}.service
[Unit]
Description=ai7proxy High-Performance Transparent AI Proxy Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${PROJECT_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
ExecStart=${NODE_BIN} dist/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable ${SERVICE_NAME} >/dev/null 2>&1
    systemctl restart ${SERVICE_NAME}
    echo -e "${GREEN}[✔] 后台服务已成功启动并设置为开机自启！${NC}"
}

# 4. 创建全局快捷指令 /usr/local/bin/proxy2ai
setup_global_command() {
    if [ ! -f /usr/local/bin/proxy2ai ] || [ "$(readlink -f /usr/local/bin/proxy2ai)" != "$SCRIPT_PATH" ]; then
        ln -sf "$SCRIPT_PATH" /usr/local/bin/proxy2ai
        chmod +x /usr/local/bin/proxy2ai
    fi
}

# 部署或启动服务
start_service() {
    check_root

    # 如果已经在运行中，友好提示
    if systemctl is-active --quiet ${SERVICE_NAME} 2>/dev/null; then
        echo -e "\n${CYAN}================================================================${NC}"
        echo -e "${GREEN}✔ ai7proxy 当前已经在后台正常运行中！${NC}"
        echo -e "监听端口: ${YELLOW}http://127.0.0.1:${PORT}${NC}"
        echo -e "健康检查: ${YELLOW}http://127.0.0.1:${PORT}/health${NC}"
        echo -e "\n常用管理命令:"
        echo -e "  - 关闭代理服务:   ${YELLOW}proxy2ai stop${NC}"
        echo -e "  - 重启代理服务:   ${YELLOW}proxy2ai restart${NC}"
        echo -e "  - 查看运行状态:   ${YELLOW}proxy2ai status${NC}"
        echo -e "  - 实时查看日志:   ${YELLOW}proxy2ai log${NC}"
        echo -e "  - 彻底卸载清除:   ${RED}proxy2ai uninstall${NC}"
        echo -e "${CYAN}================================================================${NC}\n"
        exit 0
    fi

    check_and_install_node
    build_project
    setup_systemd
    setup_global_command

    echo -e "\n${GREEN}================================================================${NC}"
    echo -e "${GREEN}🎉 ai7proxy 已成功在后台常驻运行！${NC}"
    echo -e "本地监听端口:   ${YELLOW}http://127.0.0.1:${PORT}${NC}"
    echo -e "健康检查端点:   ${YELLOW}http://127.0.0.1:${PORT}/health${NC}"
    echo -e "全局快捷指令:   系统任意目录下均可直接输入 ${BLUE}proxy2ai${NC}"
    echo -e "\n操作指南:"
    echo -e "  1. 如需修改源码: 先执行 ${YELLOW}proxy2ai stop${NC} -> 修改代码 -> 输入 ${GREEN}proxy2ai${NC} (或直接 ${BLUE}proxy2ai restart${NC})"
    echo -e "  2. 查看实时日志: ${YELLOW}proxy2ai log${NC}"
    echo -e "  3. 彻底卸载清除: ${RED}proxy2ai uninstall${NC}"
    echo -e "${GREEN}================================================================${NC}\n"
}

# 停止服务
stop_service() {
    check_root
    echo -e "${YELLOW}[正在停止] 关闭 ai7proxy 后台服务...${NC}"
    if systemctl is-active --quiet ${SERVICE_NAME} 2>/dev/null; then
        systemctl stop ${SERVICE_NAME}
        echo -e "${GREEN}[✔] ai7proxy 服务已彻底停止！${NC}"
    else
        echo -e "${BLUE}[提示] ai7proxy 服务当前未在运行。${NC}"
    fi
}

# 重启并热更新服务
restart_service() {
    check_root
    echo -e "${YELLOW}[重新编译] 正在检查文件变更并重新构建...${NC}"
    build_project
    systemctl restart ${SERVICE_NAME}
    echo -e "${GREEN}[✔] ai7proxy 已成功重新编译并重启！${NC}"
}

# 查看状态
status_service() {
    systemctl status ${SERVICE_NAME}
}

# 实时日志
log_service() {
    echo -e "${BLUE}[提示] 正在输出实时请求日志 (按 Ctrl+C 退出)...${NC}"
    journalctl -u ${SERVICE_NAME} -f
}

# 彻底卸载清除，不留任何痕迹
uninstall_service() {
    check_root

    echo -e "\n${RED}================================================================${NC}"
    echo -e "${RED}⚠️  警告: 即将从系统中彻底卸载并删除 ai7proxy！${NC}"
    echo -e "此操作将:"
    echo -e "  1. 彻底停止并注销 ai7proxy 系统后台服务;"
    echo -e "  2. 清除 /etc/systemd/system/${SERVICE_NAME}.service 配置文件;"
    echo -e "  3. 删除全局快捷命令 /usr/local/bin/proxy2ai;"
    echo -e "  4. 彻底删除项目目录: ${PROJECT_DIR}。"
    echo -e "${RED}================================================================${NC}"

    read -r -p "您确定要彻底删除吗？请输入 [y/N]: " confirm
    case "$confirm" in
        [yY][eE][sS]|[yY])
            echo -e "\n${YELLOW}[1/4] 停止并禁用 systemd 服务...${NC}"
            systemctl stop ${SERVICE_NAME} 2>/dev/null || true
            systemctl disable ${SERVICE_NAME} 2>/dev/null || true

            echo -e "${YELLOW}[2/4] 清除系统服务注册与日志配置...${NC}"
            rm -f /etc/systemd/system/${SERVICE_NAME}.service
            systemctl daemon-reload
            systemctl reset-failed 2>/dev/null || true

            echo -e "${YELLOW}[3/4] 移除全局快捷命令...${NC}"
            rm -f /usr/local/bin/proxy2ai

            echo -e "${YELLOW}[4/4] 彻底删除项目文件目录...${NC}"
            rm -rf "${PROJECT_DIR}"

            echo -e "\n${GREEN}✔ [完成] ai7proxy 已从本系统中彻底清除，不留任何痕迹！${NC}\n"
            ;;
        *)
            echo -e "\n${BLUE}[已取消] 卸载操作已取消。${NC}\n"
            exit 0
            ;;
    esac
}

# 入口指令分发
case "$1" in
    stop)
        stop_service
        ;;
    restart)
        restart_service
        ;;
    status)
        status_service
        ;;
    log)
        log_service
        ;;
    uninstall|remove|purge)
        uninstall_service
        ;;
    start)
        start_service
        ;;
    *)
        start_service
        ;;
esac
