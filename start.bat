@echo off
chcp 65001 >nul
echo ============================================
echo   KSKC 网页版聚类分析 - 启动服务
echo ============================================
echo.

set PYTHON=C:\Users\rozen\.workbuddy\binaries\python\envs\kskc\Scripts\python.exe
if not exist "%PYTHON%" (
    echo [错误] 未找到 Python 环境，请先安装依赖。
    pause
    exit /b 1
)

echo 正在启动服务，端口 8000 ...
echo 请在浏览器打开: http://localhost:8000
echo 按 Ctrl+C 停止服务
echo.
"%PYTHON%" app.py
pause
