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

# Detection thresholds are deliberately lower than the MediaPipe defaults: the
# viewer is driven by hands that move fast and are often backlit by a monitor,
# and a missed frame is far more disruptive here than an occasional false
# positive that the frontend's temporal filter discards anyway.
MIN_HAND_CONFIDENCE = 0.28
MIN_POSE_DETECTION_CONFIDENCE = 0.4
MIN_POSE_LANDMARKS_CONFIDENCE = 0.4
MIN_FACE_CONFIDENCE = 0.45

# Below this mean luminance the frame is contrast-boosted before inference.
LOW_LIGHT_THRESHOLD = 105.0
CLAHE_CLIP_LIMIT = 2.4


class HandTracker:
    """Thread-safe holistic tracker for hands, pose and facial gestures.

    Runs in VIDEO mode so MediaPipe can carry hand regions of interest across
    frames instead of re-detecting from scratch every time; this is what keeps a
    visible hand from dropping out between frames.
    """

    def __init__(self, model_path: Path) -> None:
        if not model_path.is_file():
            raise FileNotFoundError(
                f"MediaPipe model not found: {model_path}. Run the model download step."
            )

        options = mp.tasks.vision.HolisticLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            min_face_detection_confidence=MIN_FACE_CONFIDENCE,
            min_face_landmarks_confidence=MIN_FACE_CONFIDENCE,
            min_pose_detection_confidence=MIN_POSE_DETECTION_CONFIDENCE,
            min_pose_landmarks_confidence=MIN_POSE_LANDMARKS_CONFIDENCE,
            min_hand_landmarks_confidence=MIN_HAND_CONFIDENCE,
            output_face_blendshapes=False,
            output_segmentation_mask=True,
        )
        self._landmarker = mp.tasks.vision.HolisticLandmarker.create_from_options(options)
        self._lock = Lock()
        self._clahe = cv2.createCLAHE(clipLimit=CLAHE_CLIP_LIMIT, tileGridSize=(8, 8))
        self._last_timestamp_ms = 0

    def _enhance(self, bgr_frame: np.ndarray) -> tuple[np.ndarray, bool]:
        """Lift contrast on dim frames so the hand keeps enough edge detail."""
        luminance = float(bgr_frame[..., 1].mean())
        if luminance >= LOW_LIGHT_THRESHOLD:
            return bgr_frame, False
        lab = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2LAB)
        lab[..., 0] = self._clahe.apply(lab[..., 0])
        return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR), True

    def detect_jpeg(self, payload: bytes, frame_id: int, timestamp_ms: int | None = None) -> dict:
        started = perf_counter()
        encoded = np.frombuffer(payload, dtype=np.uint8)
        bgr_frame = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        if bgr_frame is None:
            raise ValueError("Frame is not a valid JPEG image")

        bgr_frame, low_light_boosted = self._enhance(bgr_frame)
        rgb_frame = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
        with self._lock:
            # VIDEO mode rejects non-increasing timestamps, so clamp rather than
            # trusting the wall clock the renderer sent.
            stamp = max(int(timestamp_ms or 0), self._last_timestamp_ms + 1)
            self._last_timestamp_ms = stamp
            result = self._landmarker.detect_for_video(image, stamp)

        hands = []
        for handedness, landmarks in (
            ("Left", result.left_hand_landmarks),
            ("Right", result.right_hand_landmarks),
        ):
            if not landmarks:
                continue
            points = [
                {
                    "x": round(float(landmark.x), 6),
                    "y": round(float(landmark.y), 6),
                    "z": round(float(landmark.z), 6),
                }
                for landmark in landmarks
            ]
            # Landmarks that fall outside the frame are extrapolations; report how
            # much of the hand is genuinely in view so the frontend can weight it.
            inside = sum(1 for point in points if -0.05 <= point["x"] <= 1.05 and -0.05 <= point["y"] <= 1.05)
            hands.append(
                {
                    "handedness": handedness,
                    "score": round(inside / max(len(points), 1), 3),
                    "landmarks": points,
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
            mask = cv2.resize(mask, (256, 144), interpolation=cv2.INTER_AREA)
            mask = cv2.GaussianBlur(mask, (5, 5), 0)
            encoded_ok, encoded_mask = cv2.imencode(
                ".png", mask, [cv2.IMWRITE_PNG_COMPRESSION, 3]
            )
            if encoded_ok:
                segmentation_mask = base64.b64encode(encoded_mask).decode("ascii")

        person_distance_meters = None
        if len(pose) > 12 and pose[11]["visibility"] > 0.35 and pose[12]["visibility"] > 0.35:
            shoulder_span = abs(pose[12]["x"] - pose[11]["x"])
            if shoulder_span > 0.03:
                person_distance_meters = round(
                    0.38 / (2.0 * shoulder_span * np.tan(np.deg2rad(30))), 3
                )

        return {
            "schemaVersion": 1,
            "type": "hands",
            "frameId": frame_id,
            "hands": hands,
            "pose": pose,
            "segmentationMask": segmentation_mask,
            "personDistanceMeters": person_distance_meters,
            "lowLightBoosted": low_light_boosted,
            "processingMs": round((perf_counter() - started) * 1000, 2),
        }

    def close(self) -> None:
        self._landmarker.close()
