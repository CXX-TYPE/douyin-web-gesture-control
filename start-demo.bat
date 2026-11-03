@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  抖音手势演示 - 本地服务器
echo  关闭这个窗口即可停止服务
echo.
where python >nul 2>nul
if %errorlevel%==0 (
    python serve.py
    goto :end
)
where py >nul 2>nul
if %errorlevel%==0 (
    py serve.py
    goto :end
)
echo [错误] 没有找到 Python，请先安装 Python 3 后重试。
pause
:end
