import io
import json
import threading
import unittest
import urllib.error
import urllib.request
import wave
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import numpy as np
import soundfile as sf
from server import Handler, speech, encode_mp3


class FakeModel:
    sample_rate = 48000

    def synthesize_stream(self, text, voice, **options):
        yield np.zeros((1, 4800), dtype=np.float32)


class SpeechTest(unittest.TestCase):
    def test_audio_is_complete_pcm_wav(self):
        with wave.open(io.BytesIO(speech(FakeModel(), "Xin chào.", "maichi"))) as audio:
            self.assertEqual(audio.getframerate(), 48000)
            self.assertEqual(audio.getnchannels(), 1)
            self.assertEqual(audio.getsampwidth(), 2)
            self.assertGreater(audio.getnframes(), 0)

    def test_authenticated_service_rejects_invalid_and_parallel_requests(self):
        Handler.model = FakeModel()
        Handler.api_key = "test-key"
        Handler.voices = [{"id": "maichi", "name": "Mai Chi"}]
        service = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=service.serve_forever, daemon=True).start()
        endpoint = f"http://127.0.0.1:{service.server_port}/speech"

        def send(body, key="test-key"):
            request = urllib.request.Request(endpoint, json.dumps(body).encode(),
                {"Content-Type": "application/json", "Authorization": "Bearer " + key})
            return urllib.request.urlopen(request)

        try:
            with patch("server.speech", wraps=speech) as synthesize:
                for body, key, status in [
                    ({"text": "Xin chào", "voice": "maichi"}, "wrong", 401),
                    ({"text": "x" * 1501, "voice": "maichi"}, "test-key", 400),
                    ({"text": "Xin chào", "voice": "../other"}, "test-key", 400),
                    *[({"text": "Xin chào", "voice": "maichi", **options}, "test-key", 400)
                      for options in [{"speed": 0.7}, {"speed": True}, {"speed": float("nan")},
                                      {"speed": float("inf")}, {"temperature": 1.1},
                                      {"voiceStrength": 2}, {"pause": "unknown"}]],
                ]:
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        send(body, key)
                    self.assertEqual(error.exception.code, status)
                synthesize.assert_not_called()
                Handler.generation_lock.acquire()
                try:
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        send({"text": "Xin chào", "voice": "maichi"})
                    self.assertEqual(error.exception.code, 429)
                finally:
                    Handler.generation_lock.release()
                with send({"text": "Xin chào", "voice": "maichi"}) as response:
                    self.assertEqual(response.headers["Content-Type"], "audio/mpeg")
                    data = response.read()
                    with sf.SoundFile(io.BytesIO(data)) as audio:
                        self.assertEqual(audio.format, "MP3")
                        self.assertEqual(audio.samplerate, 48000)
                        self.assertEqual(audio.channels, 1)
                with send({"text": "Xin chào", "voice": "maichi", "speed": 1.2,
                           "pause": "long", "temperature": 0.6, "voiceStrength": 1.2}) as response:
                    self.assertEqual(response.status, 200)
                synthesize.assert_called_with(Handler.model, "Xin chào", "maichi", "long", 0.6, 1.2)
        finally:
            service.shutdown()
            service.server_close()

    def test_mp3_is_96_kbps_mono_and_preserves_speech_duration(self):
        rate = 48000
        samples = (0.15 * np.sin(2 * np.pi * 440 * np.arange(rate) / rate)).astype("float32")
        wav = io.BytesIO()
        sf.write(wav, samples, rate, format="WAV", subtype="PCM_16")
        encoded = encode_mp3(wav.getvalue())
        with sf.SoundFile(io.BytesIO(encoded)) as audio:
            self.assertEqual(audio.format, "MP3")
            self.assertEqual(audio.channels, 1)
            self.assertEqual(audio.samplerate, rate)
            self.assertEqual(audio.frames, rate)
            self.assertIn("96 kbps", audio.extra_info)
            self.assertIn("constant", audio.extra_info)
            self.assertGreater(np.max(np.abs(audio.read())), 0.05)
        self.assertLess(len(encoded), len(wav.getvalue()) / 6)
        self.assertEqual(len(encoded) % 288, 0)
        for offset in range(0, len(encoded), 288):
            self.assertEqual(encoded[offset], 0xff)
            self.assertEqual(encoded[offset + 1] & 0xfe, 0xfa)
            self.assertEqual(encoded[offset + 2] & 0xfe, 0x74)
            self.assertEqual(encoded[offset + 3] & 0xc0, 0xc0)

    def test_pause_only_between_paragraphs_and_model_settings_forwarded(self):
        model = FakeModel()
        with patch.object(model, "synthesize_stream", wraps=model.synthesize_stream) as generate:
            frames = []
            for pause in ("short", "medium", "long"):
                with sf.SoundFile(io.BytesIO(speech(model, "Xin chào.\nHẹn gặp lại.", "maichi",
                                                   pause, 0.6, 1.2))) as audio:
                    frames.append(audio.frames)
            self.assertEqual(frames, [9600 + int(gap * 48000) for gap in (0.05, 0.15, 0.4)])
            self.assertEqual(generate.call_count, 6)
            for call in generate.call_args_list:
                self.assertEqual(call.kwargs, {"voice": "maichi", "audio_temperature": 0.6, "cfg_scale": 1.2})

    def test_speed_changes_duration_without_changing_pitch(self):
        rate = 48000
        wav = io.BytesIO()
        sf.write(wav, 0.15 * np.sin(2 * np.pi * 440 * np.arange(rate * 2) / rate),
                 rate, format="WAV", subtype="PCM_16")
        for speed in (0.8, 1, 1.2):
            with self.subTest(speed=speed):
                encoded = encode_mp3(wav.getvalue(), speed)
                audio, actual_rate = sf.read(io.BytesIO(encoded))
                self.assertEqual(actual_rate, rate)
                self.assertAlmostEqual(len(audio) / rate, 2 / speed, delta=0.06)
                frequencies = np.fft.rfftfreq(len(audio), 1 / rate)
                peak = frequencies[np.argmax(np.abs(np.fft.rfft(audio)))]
                self.assertAlmostEqual(peak, 440, delta=3)
                self.assertEqual(len(encoded) % 288, 0)


if __name__ == "__main__":
    unittest.main()
