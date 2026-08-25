import asyncio
import json

import cv2
import numpy as np
import websockets


async def main() -> None:
    async with websockets.connect("ws://127.0.0.1:8766/ws") as websocket:
        hello = json.loads(await websocket.recv())
        assert hello["type"] == "hello"

        valid, jpeg = cv2.imencode(".jpg", np.zeros((270, 480, 3), dtype=np.uint8))
        assert valid
        await websocket.send(jpeg.tobytes())

        result = json.loads(await websocket.recv())
        assert result["type"] == "hands"
        print(f"hello -> hands ({len(result['hands'])} detected, {result['processingMs']} ms)")


if __name__ == "__main__":
    asyncio.run(main())
