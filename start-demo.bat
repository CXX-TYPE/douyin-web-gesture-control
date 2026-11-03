@echo off
chcp 65001 >nul
cd /d "%~dp0"
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
echo [ERROR] Python 3 not found. Please install it first.
pause
:end
