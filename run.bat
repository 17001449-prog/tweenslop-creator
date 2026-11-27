@echo off
setlocal
cd /d "%~dp0"
echo Starting TweenSlop Studio...
where py >nul 2>nul
if not errorlevel 1 (
  py -3 app.py --host 127.0.0.1 --open
) else (
  python app.py --host 127.0.0.1 --open
)
echo.
echo If the browser did not open, visit http://127.0.0.1:8000/
pause
