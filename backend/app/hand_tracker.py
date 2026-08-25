from __future__ import annotations

import os
import base64
from pathlib import Path
from threading import Lock
from time import perf_counter

MPL_CACHE = Path(__file__).resolve().parents[1] / ".cache" / "matplotlib"
MPL_CACHE.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(MPL_CACHE))

import cv2  # noqa: E402
import mediapipe as mp  # noqa: E402
import numpy as np


class HandTracker:
    """Thread-safe holistic tracker for hands, pose and facial gestures."""

    def __init__(self, model_path: Path) -> None:
        if not model_path.is_file():
            raise FileNotFoundError(
                f"MediaPipe model not found: {model_path}. Run the model download step."
            )

        options = mp.tasks.vision.HolisticLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
            running_mode=mp.tasks.vision.RunningMode.IMAGE,
            min_face_detection_confidence=0.55,
            min_face_landmarks_confidence=0.55,
            min_pose_detection_confidence=0.55,
            min_pose_landmarks_confidence=0.55,
            min_hand_landmarks_confidence=0.55,
            output_face_blendshapes=True,
            output_segmentation_mask=True,
        )
        self._landmarker = mp.tasks.vision.HolisticLandmarker.create_from_options(options)
        self._lock = Lock()

    def detect_jpeg(self, payload: bytes, frame_id: int) -> dict:
        started = perf_counter()
        encoded = np.frombuffer(payload, dtype=np.uint8)
        bgr_frame = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        if bgr_frame is None:
            raise ValueError("Frame is not a valid JPEG image")

        rgb_frame = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
        with self._lock:
            result = self._landmarker.detect(image)

        hands = []
        for handedness, landmarks in (
            ("Left", result.left_hand_landmarks),
            ("Right", result.right_hand_landmarks),
        ):
            if not landmarks:
                continue
            hands.append(
                {
                    "handedness": handedness,
                    "score": 1.0,
                    "landmarks": [
                        {
                            "x": round(float(landmark.x), 6),
                            "y": round(float(landmark.y), 6),
                            "z": round(float(landmark.z), 6),
                        }
                        for landmark in landmarks
                    ],
                }
            )

        pose = [
            {
                "x": round(float(landmark.x), 6),
                "y": round(float(landmark.y), 6),
                "z": round(float(landmark.z), 6),
                "visibility": round(float(landmark.visibility or 0.0), 4),
            }
            for landmark in result.pose_landmarks
        ]

        segmentation_mask = None
        if result.segmentation_mask is not None:
            mask = result.segmentation_mask.numpy_view()
            mask = np.clip(mask * 255.0, 0, 255).astype(np.uint8)
            mask = cv2.resize(mask, (240, 135), interpolation=cv2.INTER_AREA)
            mask = cv2.GaussianBlur(mask, (7, 7), 0)
            encoded_ok, encoded_mask = cv2.imencode(
                ".png", mask, [cv2.IMWRITE_PNG_COMPRESSION, 6]
            )
            if encoded_ok:
                segmentation_mask = base64.b64encode(encoded_mask).decode("ascii")

        person_distance_meters = None
        if len(pose) > 12 and pose[11]["visibility"] > 0.45 and pose[12]["visibility"] > 0.45:
            shoulder_span = abs(pose[12]["x"] - pose[11]["x"])
            if shoulder_span > 0.03:
                person_distance_meters = round(
                    0.38 / (2.0 * shoulder_span * np.tan(np.deg2rad(30))), 3
                )

        blendshapes = {
            category.category_name: float(category.score)
            for category in (result.face_blendshapes or [])
        }
        mouth_pucker = blendshapes.get("mouthPucker", 0.0)
        mouth_funnel = blendshapes.get("mouthFunnel", 0.0)
        cheek_puff = blendshapes.get("cheekPuff", 0.0)
        jaw_open = blendshapes.get("jawOpen", 0.0)
        # A visual blow requires sustained pursed/funnelled lips with a mostly closed jaw.
        # This deliberately rejects ordinary speech at the cost of requiring a clear gesture.
        if mouth_pucker < 0.55 or mouth_funnel < 0.16 or jaw_open > 0.24:
            blow_score = 0.0
        else:
            speech_penalty = min(jaw_open * 2.5, 0.75)
            blow_score = (
                mouth_pucker * 0.7 + mouth_funnel * 0.2 + cheek_puff * 0.1
            ) * (1.0 - speech_penalty)

        return {
            "schemaVersion": 1,
            "type": "hands",
            "frameId": frame_id,
            "hands": hands,
            "pose": pose,
            "segmentationMask": segmentation_mask,
            "personDistanceMeters": person_distance_meters,
            "facePresent": bool(result.face_landmarks),
            "blowScore": round(blow_score, 4),
            "faceSignals": {
                "mouthPucker": round(mouth_pucker, 4),
                "mouthFunnel": round(mouth_funnel, 4),
                "cheekPuff": round(cheek_puff, 4),
                "jawOpen": round(jaw_open, 4),
            },
            "processingMs": round((perf_counter() - started) * 1000, 2),
        }

    def close(self) -> None:
        self._landmarker.close()
