@echo off
title Antigravity 汉化还原工具

set "NODE_CMD=node"
where node >nul 2>nul
if %errorlevel%==0 goto NODE_READY

if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files\nodejs\node.exe"
    set "PATH=C:\Program Files\nodejs;%PATH%"
    goto NODE_READY
)
if exist "C:\Program Files (x86)\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files (x86)\nodejs\node.exe"
    set "PATH=C:\Program Files (x86)\nodejs;%PATH%"
    goto NODE_READY
)
if exist "%LOCALAPPDATA%\Programs\node\node.exe" (
    set "NODE_CMD=%LOCALAPPDATA%\Programs\node\node.exe"
    set "PATH=%LOCALAPPDATA%\Programs\node;%PATH%"
    goto NODE_READY
)

echo.
echo ==========================================
echo [错误] 未检测到 Node.js 环境！
echo ==========================================
echo Antigravity 汉化工具需要 Node.js 运行环境支持。
echo 请访问官方网站下载安装（建议选择 LTS 最新长期支持版本）：
echo   https://nodejs.org/
echo.
echo 安装完成后，请重新双击运行此脚本。
echo.
pause
exit /b 1

:NODE_READY

echo.
echo [1/2] 正在还原官方文件...
"%NODE_CMD%" "%~dp0localization_engine.js" --huifu %*

if %errorlevel% neq 0 goto FAIL

echo.
echo [2/2] 还原完成！
echo.
echo 提示：Antigravity 已恢复至官方原版英文状态。
echo.
echo 窗口将在 5 秒后自动关闭...
ping -n 5 127.0.0.1 >nul
exit /b 0

:FAIL
echo.
echo [错误] 还原失败，请检查上方错误信息。
echo.
pause
exit /b 1
