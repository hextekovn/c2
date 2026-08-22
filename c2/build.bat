@echo off
echo ========================================
echo  Dang dong goi Bot Client thanh EXE...
echo ========================================
echo.

REM Cài đặt dependencies
pip install pyinstaller websockets pyautogui pillow psutil requests

REM Đóng gói
pyinstaller --onefile --noconsole --name bot_client --add-data "config.json;." bot_client.py

echo.
echo ========================================
echo  Hoan thanh! File exe o thu muc: dist\
echo ========================================
pause