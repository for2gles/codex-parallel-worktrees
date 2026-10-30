#!/usr/bin/env python3
"""Test fixture only. Deterministic JSONL server; no model or network access."""
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time

if "--version" in sys.argv:
    print("fake-codex 1.0")
    sys.exit(0)

def send(message):
    print(json.dumps(message), flush=True)

def event(method, params):
    send({"method": method, "params": params})

turn = None
number = 0
deadline = None
task = ""
thread_id = "fake-" + str(os.getpid())

def complete(status="completed"):
    global deadline
    if status == "completed":
        for name, value in re.findall(r"MAKE ([\w.-]+) ([^\n]+)", task):
            Path(name).write_text(value + "\n")
            subprocess.run(["git", "add", "--", name], check=True, capture_output=True)
            p = subprocess.run(["git", "diff", "--cached", "--quiet"])
            if p.returncode:
                subprocess.run(["git", "commit", "-m", "test worker change"], check=True, capture_output=True)
    event("item/completed", {"threadId": thread_id, "turnId": turn,
                            "item": {"type": "agentMessage", "id": "msg", "text": "Finished: " + task}})
    event("turn/completed", {"threadId": thread_id, "turn": {"id": turn, "status": status, "error": None}})
    deadline = None

selector = selectors.DefaultSelector()
selector.register(sys.stdin, selectors.EVENT_READ)
incoming = b""
while True:
    if deadline is not None and time.monotonic() >= deadline:
        complete()
    if selector.select(0 if b"\n" in incoming else 0.02):
        chunk = os.read(sys.stdin.fileno(), 65536)
        if not chunk:
            sys.exit(0)
        incoming += chunk
    if b"\n" in incoming:
        line, incoming = incoming.split(b"\n", 1)
        msg = json.loads(line)
        method = msg.get("method")
        ident = msg.get("id")
        params = msg.get("params", {})
        if method == "initialized":
            continue
        if method == "initialize":
            result = {"userAgent": "fake"}
        elif method in {"thread/start", "thread/resume"}:
            if params.get("sandbox") not in (None, "read-only", "workspace-write"):
                send({"id":ident,"error":{"code":-32600,"message":"Invalid sandbox mode"}})
                continue
            result = {"thread": {"id": thread_id}, "model": "fake",
                      "sandbox": {"type": "workspaceWrite"}, "approvalPolicy": "onRequest"}
        elif method == "turn/start":
            number += 1
            turn = "turn-" + str(number)
            task = params["input"][0]["text"]
            if "CRASH" in task:
                sys.exit(7)
            event("turn/started", {"threadId": thread_id, "turn": {"id": turn}})
            result = {"turn": {"id": turn, "status": "inProgress"}}
            if "APPROVE" in task:
                send({"id": 900, "method": "item/commandExecution/requestApproval",
                      "params": {"threadId": thread_id, "turnId": turn, "command": "test-only"}})
            elif "FAST" in task:
                complete()
            else:
                deadline = time.monotonic() + (2 if "SLOW" in task else 0.35)
        elif method == "turn/steer":
            if deadline is None:
                send({"id": ident, "error": {"code": -1, "message": "No active turn"}})
                continue
            if params["expectedTurnId"] != turn:
                raise AssertionError("Wrong turn ID")
            task += "\n" + params["input"][0]["text"]
            deadline = time.monotonic() + 0.25
            result = {"turnId": turn}
        elif method == "turn/interrupt":
            complete("interrupted")
            result = {}
        elif method is None and ident == 900:
            complete("completed" if msg["result"]["decision"] == "accept" else "failed")
            continue
        else:
            send({"id": ident, "error": {"code": -32601, "message": "Unknown method"}})
            continue
        send({"id": ident, "result": result})
