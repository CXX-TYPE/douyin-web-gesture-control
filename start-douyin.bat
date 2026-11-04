@echo off
chcp 65001 >nul
set "EXT=%~dp0extension"
echo.
echo  [1/3] Closing Edge ...
taskkill /IM msedge.exe /F >nul 2>&1
timeout /t 3 >nul
echo  [2/3] Starting Edge with the gesture extension ...
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --load-extension="%EXT%" "https://www.douyin.com/?recommend=1"
echo  [3/3] Done.
echo.
echo  On the Douyin page, press  Alt + G  to toggle gesture control.
echo  Allow camera access when the browser asks.
echo.
timeout /t 8 >nul
