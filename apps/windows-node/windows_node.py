import asyncio
import json
import os
import sys
import base64
import time
from io import BytesIO

import websockets
import pyautogui
from PIL import Image, ImageGrab

# Disable pyautogui failsafe for autonomous agents, though be careful!
pyautogui.FAILSAFE = False

GATEWAY_URL = os.getenv("OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789/__openclaw__/gateway/plugin")
GATEWAY_TOKEN = os.getenv("OPENCLAW_GATEWAY_TOKEN", "")

def get_node_id():
    return f"windows-node-{os.getpid()}"

async def handle_snapshot(params):
    max_width = params.get("maxWidth")
    quality = params.get("quality", 0.8)
    format_type = params.get("format", "jpeg").lower()

    if format_type == "jpg":
        format_type = "jpeg"

    # Capture the primary screen 
    # Pillow ImageGrab grabs the primary monitor by default on Windows
    img = ImageGrab.grab()

    if max_width and img.width > max_width:
        ratio = max_width / img.width
        new_height = int(img.height * ratio)
        img = img.resize((max_width, new_height), Image.Resampling.LANCZOS)

    buffer = BytesIO()
    save_kwargs = {}
    if format_type == "jpeg":
        save_kwargs["quality"] = int(quality * 100)
        img = img.convert("RGB") # ensure no alpha channel for JPEG
    
    img.save(buffer, format=format_type.upper(), **save_kwargs)
    b64_data = base64.b64encode(buffer.getvalue()).decode("utf-8")

    return {
        "ok": True,
        "payload": {
            "format": format_type,
            "width": img.width,
            "height": img.height,
            "screenIndex": 0,
            "base64": b64_data
        }
    }

async def handle_click(params):
    x = params.get("x")
    y = params.get("y")
    button = params.get("button", "left").lower()
    click_count = params.get("clickCount", 1)
    move_only = params.get("moveOnly", False)

    if x is None or y is None:
        raise ValueError("x and y coordinates are required")

    print(f"Mouse action: move to ({x}, {y}), btn={button}, clicks={click_count}, move_only={move_only}")

    pyautogui.moveTo(x, y, duration=0.2)
    
    if not move_only:
        pyautogui.click(x=x, y=y, clicks=click_count, button=button)

    return {"ok": True}

async def handle_type(params):
    text = params.get("text", "")
    submit = params.get("submit", False)
    interval_ms = params.get("intervalMs")

    interval = (interval_ms / 1000.0) if interval_ms else 0.01

    print(f"Typing text: {text!r} (submit={submit})")
    pyautogui.typewrite(text, interval=interval)
    
    if submit:
        pyautogui.press("enter")

    return {"ok": True}

async def node_client():
    headers = {}
    if GATEWAY_TOKEN:
        headers["authorization"] = f"Bearer {GATEWAY_TOKEN}"
        
    print(f"Connecting to Gateway at {GATEWAY_URL}...")
    
    try:
        async with websockets.connect(GATEWAY_URL, additional_headers=headers) as websocket:
            print("Connected! Registering node...")
            
            # Register the node
            register_msg = {
                "type": "gateway.session.registerNode",
                "request": True,
                "msgId": "req-reg-1",
                "payload": {
                    "id": get_node_id(),
                    "name": "Windows Desktop Node",
                    "capabilities": [
                        "screen.capture",
                        "screen.control"
                    ]
                }
            }
            await websocket.send(json.dumps(register_msg))
            
            async for message in websocket:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue
                    
                msg_type = data.get("type")
                is_request = data.get("request", False)
                msg_id = data.get("msgId")
                
                if msg_type == "gateway.session.registerNode" and not is_request:
                    print(f"Registration successful: {data.get('payload')}")
                    continue

                if msg_type == "node.invoke" and is_request:
                    payload = data.get("payload", {})
                    command = payload.get("command")
                    invoke_id = payload.get("invokeId")
                    cmd_params = payload.get("params", {})
                    
                    print(f"Received invocation '{command}' (id: {invoke_id})")
                    
                    # Process the specific command
                    response_payload = None
                    error_msg = None
                    
                    try:
                        if command == "screen.snapshot":
                            response_payload = await handle_snapshot(cmd_params)
                        elif command == "screen.click":
                            response_payload = await handle_click(cmd_params)
                        elif command == "screen.type":
                            response_payload = await handle_type(cmd_params)
                        else:
                            error_msg = f"Unknown command: {command}"
                            print(error_msg)
                    except Exception as e:
                        error_msg = f"Error executing {command}: {e}"
                        print(error_msg)
                        
                    # Send result back
                    result_msg = {
                        "type": "node.invoke",
                        "request": False,
                        "msgId": msg_id,
                        "payload": response_payload if not error_msg else {"ok": False, "error": error_msg}
                    }
                    
                    await websocket.send(json.dumps(result_msg))
                    
    except Exception as e:
        print(f"Connection error: {e}")
        time.sleep(3)

async def main():
    while True:
        await node_client()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Shutting down Windows Node.")
        sys.exit(0)
