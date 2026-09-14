import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app import ai_assistant
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

# The renderer is served from the app:// scheme, which browsers treat as an
# opaque origin, so the assistant endpoint has to opt into cross-origin POSTs.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["content-type"],
)


class AssistantRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    scene: str = Field(default="", max_length=4000)


@app.get("/ai/status")
async def assistant_status() -> dict:
    return {"schemaVersion": 1, "configured": ai_assistant.is_configured(), "model": ai_assistant.MODEL}


@app.post("/ai/command")
async def assistant_command(request: AssistantRequest) -> JSONResponse:
    try:
        result = await asyncio.to_thread(ai_assistant.interpret, request.prompt, request.scene)
    except ai_assistant.AssistantUnavailable as error:
        return JSONResponse(
            status_code=503,
            content={"schemaVersion": 1, "available": False, "message": str(error)},
        )
    return JSONResponse(content={"schemaVersion": 1, "available": True, **result})


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
            "capabilities": [
                "hand-landmarks-v2",
                "pose-landmarks-v1",
                "person-segmentation-v1",
                "assistant-bridge-v1",
            ],
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
                    websocket.app.state.hand_tracker.detect_jpeg,
                    payload,
                    frame_id,
                    int(perf_counter() * 1000),
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
