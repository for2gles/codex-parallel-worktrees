import asyncio
import json
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from unix_ws import UnixWebSocket, MAX_FRAME
from fake_listener import read_frame


class Writer:
    def __init__(self):
        self.data = bytearray()

    def write(self, data):
        self.data.extend(data)

    async def drain(self):
        pass


def server_frame(opcode, data, final=True):
    head = bytes([(128 if final else 0) | opcode])
    n = len(data)
    return head + (bytes([n]) if n < 126 else b"\x7e" + struct.pack("!H", n)) + data


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_fragmented_text_with_ping_is_reassembled_and_ponged(self):
        reader, writer = asyncio.StreamReader(), Writer()
        payload = json.dumps({"text":"가" * 100}, ensure_ascii=False).encode()
        reader.feed_data(server_frame(1, payload[:200], False) + server_frame(9, b"ping") + server_frame(0, payload[200:]))
        client = UnixWebSocket(reader, writer)
        self.assertEqual(await client.receive(), {"text":"가" * 100})
        pong = asyncio.StreamReader()
        pong.feed_data(writer.data)
        self.assertEqual(await read_frame(pong), (10, b"ping"))

    async def test_long_outbound_payload_is_masked_and_roundtrips(self):
        writer = Writer()
        client = UnixWebSocket(asyncio.StreamReader(), writer)
        expected = {"text":"x" * 70000}
        await client.send(expected)
        reader = asyncio.StreamReader()
        reader.feed_data(writer.data)
        opcode, payload = await read_frame(reader)
        self.assertEqual(opcode, 1)
        self.assertEqual(json.loads(payload), expected)

    async def test_oversize_frame_is_rejected_before_payload_read(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"\x81\x7f" + struct.pack("!Q", MAX_FRAME + 1))
        with self.assertRaisesRegex(RuntimeError, "size limit"):
            await UnixWebSocket(reader, Writer()).receive()

    async def test_masked_server_frame_is_rejected(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"\x81\x80")
        with self.assertRaisesRegex(RuntimeError, "masking"):
            await UnixWebSocket(reader, Writer()).receive()
