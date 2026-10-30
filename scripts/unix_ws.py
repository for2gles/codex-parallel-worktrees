"""Small RFC 6455 text client for a same-user local Unix socket. No TCP/TLS."""
import asyncio
import base64
import hashlib
import json
import os
import struct

MAX_FRAME = 4 * 1024 * 1024
GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class UnixWebSocket:
    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.write_lock = asyncio.Lock()

    @classmethod
    async def connect(cls, path):
        reader, writer = await asyncio.open_unix_connection(str(path), limit=MAX_FRAME)
        try:
            key = base64.b64encode(os.urandom(16))
            writer.write(b"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                         b"Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
                         b"Sec-WebSocket-Key: " + key + b"\r\n\r\n")
            await writer.drain()
            header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
            lines = header.decode("ascii").split("\r\n")
            fields = dict(line.split(":", 1) for line in lines[1:] if ":" in line)
            fields = {k.strip().lower(): v.strip() for k, v in fields.items()}
            expected = base64.b64encode(hashlib.sha1(key + GUID).digest()).decode()
            if lines[0].split()[1] != "101" or fields.get("sec-websocket-accept") != expected:
                raise RuntimeError("Local app-server rejected the WebSocket handshake")
            if fields.get("upgrade", "").lower() != "websocket":
                raise RuntimeError("Invalid WebSocket upgrade response")
            return cls(reader, writer)
        except BaseException:
            writer.close()
            await writer.wait_closed()
            raise

    async def frame(self, opcode, data=b""):
        if len(data) > MAX_FRAME:
            raise RuntimeError("WebSocket message exceeds size limit")
        n = len(data)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n <= 65535:
            head += b"\xfe" + struct.pack("!H", n)
        else:
            head += b"\xff" + struct.pack("!Q", n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        async with self.write_lock:
            self.writer.write(head + mask + masked)
            await self.writer.drain()

    async def send(self, message):
        await self.frame(1, json.dumps(message, ensure_ascii=False).encode())

    async def receive(self):
        fragments = bytearray()
        fragmented = False
        while True:
            try:
                first, second = await self.reader.readexactly(2)
            except asyncio.IncompleteReadError as exc:
                raise RuntimeError("Codex app-server disconnected") from exc
            final, opcode = bool(first & 0x80), first & 0x0f
            if first & 0x70 or second & 0x80:
                raise RuntimeError("Invalid/unexpected WebSocket extensions or server masking")
            length = second & 0x7f
            if length == 126:
                length = struct.unpack("!H", await self.reader.readexactly(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", await self.reader.readexactly(8))[0]
            if length > MAX_FRAME or len(fragments) + length > MAX_FRAME:
                raise RuntimeError("WebSocket response exceeds size limit")
            if opcode >= 8 and (not final or length > 125):
                raise RuntimeError("Invalid WebSocket control frame")
            data = await self.reader.readexactly(length)
            if opcode == 8:
                raise RuntimeError("Codex app-server closed its WebSocket")
            if opcode == 9:
                await self.frame(10, data)
                continue
            if opcode == 10:
                continue
            if opcode == 1 and not fragmented:
                fragmented = True
            elif opcode != 0 or not fragmented:
                raise RuntimeError("Expected a WebSocket text message or continuation")
            fragments.extend(data)
            if final:
                return json.loads(fragments.decode("utf-8"))

    async def close(self):
        self.writer.close()
        await self.writer.wait_closed()
