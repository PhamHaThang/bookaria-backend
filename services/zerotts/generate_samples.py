"""Generate the bundled voice samples once, rather than on each preview click."""

import argparse
import io
import os
from pathlib import Path
import re

import soundfile as sf
from server import MODEL_REVISION, ZeroTTS, speech

SAMPLE_TEXT = (
    "Xin chào! Chào mừng bạn đến với Bookaria – nền tảng sáng tạo và trải nghiệm sách tương tác, "
    "kết hợp công nghệ thực tế tăng cường và trí tuệ nhân tạo."
)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Studio public/audio/voice-samples directory")
    output = parser.parse_args().output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parent / ".cache" / "huggingface"))
    model = ZeroTTS.from_pretrained("zeroweight-ai/ZeroTTS", revision=MODEL_REVISION,
                                    intra_op_num_threads=4)
    for voice in model.list_voices():
        if not re.fullmatch(r"[a-z0-9_-]{1,64}", voice):
            raise ValueError("Invalid voice id")
        audio, rate = sf.read(io.BytesIO(speech(model, SAMPLE_TEXT, voice)), dtype="float32")
        target = output / f"{voice}.mp3"
        temporary = output / f".{voice}.mp3"
        sf.write(temporary, audio, rate, format="MP3", subtype="MPEG_LAYER_III",
                 bitrate_mode="VARIABLE", compression_level=0.5)
        info = sf.info(temporary)
        assert info.frames > 0 and info.samplerate == rate and info.channels == 1
        temporary.replace(target)
        print(f"{voice}: {info.duration:.2f}s, {target.stat().st_size} bytes", flush=True)
