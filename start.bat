@echo off
REM ZCode Task Queue - Windows 启动器
REM 用法：start.bat [start|stop|restart|status|preflight]

setlocal EnableDelayedExpansion

set "COMMAND=%~1"
if "%COMMAND%"=="" set COMMAND=start

REM 获取当前目录
cd /d "%~dp0"

REM 检查 Node.js 是否安装
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 找不到 Node.js，请先安装 Node.js >= 22.13.0
    echo 下载地址：https://nodejs.org/
    exit /b 1
)

for /f "tokens=*" %%i in ('node -p process.versions.node') do set NODE_VERSION=%%i
echo [信息] Node.js 版本：%NODE_VERSION%

REM 执行主脚本
node start.js %COMMAND% %*

endlocal
exit /b %ERRORLEVEL%
