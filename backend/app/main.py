import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from app.hand_tracker import HandTracker

MAX_FRAME_BYTES = 2 * 1024 * 1024
MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "holistic_landmarker.task"


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.hand_tracker = HandTracker(MODEL_PATH)
    yield
    app.state.hand_tracker.close()


app = FastAPI(
    title="Gesture Data Bridge",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Receive local JPEG frames and return versioned hand landmark messages."""
    await websocket.accept()
    await websocket.send_json(
        {
            "schemaVersion": 1,
            "type": "hello",
            "message": "gesture-backend-ready",
            "timestamp": datetime.now(UTC).isoformat(),
            "capabilities": ["hand-landmarks-v1", "pose-landmarks-v1", "face-blow-score-v1", "person-segmentation-v1"],
        }
    )

    frame_id = 0
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            payload = message.get("bytes")
            if payload is None:
                await websocket.send_json(
                    {"schemaVersion": 1, "type": "error", "code": "binary-frame-required"}
                )
                continue
            if len(payload) > MAX_FRAME_BYTES:
                await websocket.send_json(
                    {"schemaVersion": 1, "type": "error", "code": "frame-too-large"}
                )
                continue

            frame_id += 1
            try:
                result = await asyncio.to_thread(
                    websocket.app.state.hand_tracker.detect_jpeg, payload, frame_id
                )
                await websocket.send_json(result)
            except ValueError as error:
                await websocket.send_json(
                    {
                        "schemaVersion": 1,
                        "type": "error",
                        "code": "invalid-frame",
                        "message": str(error),
                    }
                )
    except WebSocketDisconnect:
        return
