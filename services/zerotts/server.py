"""Local CPU speech service. Run with the virtual environment's Python."""

import hmac
import io
import json
import logging
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from time import monotonic

import numpy as np
import soundfile as sf
from imageio_ffmpeg import get_ffmpeg_exe
from zerotts import ZeroTTS, normalize_vi_text
from zerotts.audio import concat_with_silence
from zerotts.chunking import chunk_text, clean_segment_punctuation, normalize_punctuation

MODEL_REVISION = "18d6681518a4becaed3c125ceb3c7db59905fe86"
MAX_CHARACTERS = 1500
MAX_AUDIO_SECONDS = 180


def speech(model, text, voice, pause="medium", temperature=0.8, voice_strength=1):
    normalized = normalize_vi_text(text)
    if len(normalized) > 6000:
        raise ValueError("Expanded text is too long")
    segments = [clean_segment_punctuation(segment)
                for paragraph in normalized.splitlines() if paragraph.strip()
                for segment in chunk_text(normalize_punctuation(paragraph), max_chunk_sec=15)]
    deadline = monotonic() + 170
    chunks = []
    samples = 0
    gap = np.zeros((1, int({"short": 0.05, "medium": 0.15, "long": 0.4}[pause] * model.sample_rate)), dtype=np.float32)
    for segment in filter(None, segments):
        if chunks:
            chunks.append(gap)
        for chunk in model.synthesize_stream(segment, voice=voice,
                audio_temperature=temperature, cfg_scale=voice_strength):
            if monotonic() > deadline:
                raise TimeoutError("Speech generation timed out")
            if not np.isfinite(chunk).all():
                raise ValueError("Invalid audio")
            samples += chunk.size
            if samples > MAX_AUDIO_SECONDS * model.sample_rate:
                raise ValueError("Audio is too long")
            chunks.append(chunk)
    if samples == 0:
        raise ValueError("Empty audio")
    audio = concat_with_silence(chunks, 0, model.sample_rate)
    result = io.BytesIO()
    sf.write(result, audio.reshape(-1), model.sample_rate, format="WAV", subtype="PCM_16")
    return result.getvalue()


def encode_mp3(wav, speed=1):
    audio, rate = sf.read(io.BytesIO(wav), dtype="float32")
    if rate != 48000 or audio.ndim != 1:
        raise ValueError("Expected 48 kHz mono speech")
    if speed != 1:
        processed = subprocess.run([
            get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "f32le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0",
            "-af", f"atempo={speed}", "-f", "f32le", "-ar", str(rate), "-ac", "1", "pipe:1",
        ], input=audio.astype("<f4").tobytes(), capture_output=True, check=True, timeout=15,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        audio = np.frombuffer(processed.stdout, dtype="<f4")
    if not 0 < audio.size <= MAX_AUDIO_SECONDS * rate or not np.isfinite(audio).all():
        raise ValueError("Invalid output audio or duration")
    result = io.BytesIO()
    # libsndfile maps this setting to 96 kbps; the encoding test checks the actual bitrate.
    sf.write(result, audio, rate, format="MP3", subtype="MPEG_LAYER_III",
             bitrate_mode="CONSTANT", compression_level=0.75)
    return result.getvalue()


class Handler(BaseHTTPRequestHandler):
    model = None
    api_key = ""
    voices = []
    generation_lock = Lock()

    def setup(self):
        super().setup()
        self.connection.settimeout(190)

    def respond(self, status, data, content_type="application/json"):
        content = json.dumps(data, ensure_ascii=False).encode("utf-8") if isinstance(data, (dict, list)) else data
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def authorized(self):
        if self.api_key and not hmac.compare_digest(
            self.headers.get("Authorization", ""), "Bearer " + self.api_key
        ):
            self.respond(401, {"error": "Unauthorized"})
            return False
        return True

    def do_GET(self):
        if self.path == "/health":
            self.respond(200, {"ready": True, "model": "ZeroTTS", "revision": MODEL_REVISION})
        elif self.path == "/voices" and self.authorized():
            self.respond(200, self.voices)
        else:
            if self.path != "/voices":
                self.respond(404, {"error": "Not found"})

    def do_POST(self):
        if not self.authorized():
            return
        if self.path != "/speech":
            self.respond(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16000 or self.headers.get_content_type() != "application/json":
                raise ValueError("Invalid request")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("Invalid request")
            text, voice = body.get("text"), body.get("voice")
            if not isinstance(text, str) or not 0 < len(text.strip()) <= MAX_CHARACTERS or not any(c.isalnum() for c in text):
                raise ValueError("Invalid text")
            if voice not in [item["id"] for item in self.voices]:
                raise ValueError("Unknown voice")
            speed = body.get("speed", 1)
            pause = body.get("pause", "medium")
            temperature = body.get("temperature", 0.8)
            voice_strength = body.get("voiceStrength", 1)
            for value, minimum, maximum in [(speed, 0.8, 1.2), (temperature, 0.5, 1), (voice_strength, 1, 1.5)]:
                if type(value) not in (int, float) or not minimum <= value <= maximum:
                    raise ValueError("Invalid speech settings")
            if pause not in ("short", "medium", "long"):
                raise ValueError("Invalid pause setting")
        except (ValueError, TypeError):
            self.respond(400, {"error": "Invalid text or voice"})
            return
        if not self.generation_lock.acquire(blocking=False):
            self.respond(429, {"error": "Speech service is busy"})
            return
        try:
            started = monotonic()
            audio = encode_mp3(speech(self.model, text.strip(), voice, pause, temperature, voice_strength), speed)
            logging.info("Generated %.1f KB in %.2f s", len(audio) / 1024, monotonic() - started)
            self.respond(200, audio, "audio/mpeg")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            logging.error("Speech generation failed", exc_info=True)
            self.respond(500, {"error": "Speech generation failed"})
        finally:
            self.generation_lock.release()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    folder = Path(__file__).resolve().parent
    os.environ.setdefault("HF_HOME", str(folder / ".cache" / "huggingface"))
    model = ZeroTTS.from_pretrained("zeroweight-ai/ZeroTTS", revision=MODEL_REVISION,
                                    intra_op_num_threads=4)
    Handler.model = model
    Handler.api_key = os.environ.get("ZEROTTS_API_KEY", "")
    Handler.voices = [{"id": name, "name": model.load_voice(name).display_name or name}
                      for name in model.list_voices()]
    logging.info("ZeroTTS ready at http://127.0.0.1:8010 (%s voices)", len(Handler.voices))
    # Loopback keeps the demo service behind Bookaria's authentication and rate limits.
    ThreadingHTTPServer(("127.0.0.1", 8010), Handler).serve_forever()
