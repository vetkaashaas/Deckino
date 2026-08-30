# FFmpeg runtime

Deckino.Tools uses FFmpeg and FFprobe as separate processes to decode phone
videos. The runtime is not committed to Git. Run `Deckino.Tools/scripts/fetch-ffmpeg.ps1` to
download the pinned Windows x64 LGPL shared build and verify its SHA-256 before
extracting it into `Deckino.Tools/third_party/ffmpeg/win-x64`.

The Deckino publish script runs the fetch step automatically and copies the
runtime beneath `tools/ffmpeg/win-x64` in the portable package.

Pinned build:

- FFmpeg 9.0.1, BtbN win64 LGPL shared build
- FFmpeg commit `e47273f4d9`
- BtbN release `autobuild-2026-08-29-13-12`
- Archive SHA-256 `e452726c9282e9d8b640dd29f012db91bf6133b490b5490a37e8b0a4d3ec7ae9`

See `THIRD-PARTY-NOTICES.txt` for license and corresponding-source details.
