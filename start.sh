#!/usr/bin/env bash
# KSKC 网页版聚类分析 - 启动服务
PYTHON="C:/Users/rozen/.workbuddy/binaries/python/envs/kskc/Scripts/python.exe"
if [ ! -f "$PYTHON" ]; then
    echo "[错误] 未找到 Python 环境，请先安装依赖。"
    exit 1
fi
echo "正在启动服务，端口 8000 ..."
echo "请在浏览器打开: http://localhost:8000"
echo "按 Ctrl+C 停止服务"
"$PYTHON" app.py
