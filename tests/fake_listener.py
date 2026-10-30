"""Independent WebSocket test server backed by the deterministic JSONL fixture."""
import asyncio
import base64
import contextlib
import hashlib
import json
from pathlib import Path
import struct
import sys


async def read_frame(reader):
    a, b = await reader.readexactly(2)
    n = b & 127
    if n == 126:
        n = struct.unpack("!H", await reader.readexactly(2))[0]
    elif n == 127:
        n = struct.unpack("!Q", await reader.readexactly(8))[0]
    if not b & 128 or n > 4 * 1024 * 1024:
        raise RuntimeError("Client mask/length invalid")
    mask = await reader.readexactly(4)
    data = await reader.readexactly(n)
    return a & 15, bytes(v ^ mask[i % 4] for i, v in enumerate(data))


async def frame(writer, opcode, data):
    n = len(data)
    head = bytes([128 | opcode])
    head += bytes([n]) if n < 126 else b"\x7e" + struct.pack("!H", n) if n < 65536 else b"\x7f" + struct.pack("!Q", n)
    writer.write(head + data)
    await writer.drain()


async def serve(path):
    backend = await asyncio.create_subprocess_exec(sys.executable, str(Path(__file__).with_name("fake_codex.py")),
              "app-server", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
    clients = []
    pending = {}
    counter = 0
    stop = asyncio.Event()

    async def client(reader, writer):
        nonlocal counter
        try:
            header = (await reader.readuntil(b"\r\n\r\n")).decode()
            fields = {k.lower(): v.strip() for k, v in (line.split(":", 1) for line in header.split("\r\n")[1:] if ":" in line)}
            accept = base64.b64encode(hashlib.sha1((fields["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
            writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
            await writer.drain()
            clients.append(writer)
            while True:
                opcode, data = await read_frame(reader)
                if opcode == 8:
                    break
                if opcode == 9:
                    await frame(writer, 10, data)
                    continue
                msg = json.loads(data)
                if "method" in msg and "id" in msg:
                    counter += 1
                    pending[counter] = (writer, msg["id"])
                    msg["id"] = counter
                backend.stdin.write(json.dumps(msg).encode() + b"\n")
                await backend.stdin.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            if writer in clients:
                clients.remove(writer)
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    async def pump():
        try:
            while True:
                line = await backend.stdout.readline()
                if not line:
                    break
                msg = json.loads(line)
                if "id" in msg and "method" not in msg:
                    writer, ident = pending.pop(msg["id"])
                    msg["id"] = ident
                    targets = [writer]
                elif "id" in msg:
                    targets = clients[:1]
                else:
                    targets = clients[:]
                for writer in targets:
                    with contextlib.suppress(ConnectionError):
                        await frame(writer, 1, json.dumps(msg).encode())
        finally:
            for writer in clients:
                writer.close()
            stop.set()

    server = await asyncio.start_unix_server(client, path=str(path))
    task = asyncio.create_task(pump())
    try:
        await stop.wait()
    finally:
        server.close()
        await server.wait_closed()
        if backend.returncode is None:
            backend.terminate()
            await backend.wait()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


def run(address):
    assert address.startswith("unix://")
    asyncio.run(serve(Path(address[7:])))
