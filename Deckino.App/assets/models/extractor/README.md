# Extractor model drop-in

This folder is for the **converted** on-device extractor (TFLite/ONNX), not the
PyTorch checkpoint from training.

## Where the trained weights live

Training runs on the NVIDIA PC. On that machine click **Pack for other PCs**
on the Toolbox Card Extraction page, copy the compact handoff ZIP to this
machine, and click **Import bundle** here.

That installs:

- `data/training/artifacts/<model-version>/extractor.pt`
- matching `config.json`, `preprocessing.json`, `thresholds.json`
- `data/training/current-extraction.json` — the pointer other tools should read

Do not put `extractor.pt` in this App folder. The phone cannot run PyTorch
checkpoints.

## Getting the model onto the phone

Automatic: `scripts/start-deckino-android.ps1` exports the newest imported
model to ONNX on CPU and copies it here before Metro starts. The Scan screen
loads `extractor.onnx` plus `mobile-manifest.json` and `thresholds.json`. If
Scan still shows an older `extractor: ...` version, rebuild the Android dev
client. TFLite is optional; do not ship a converted `.tflite` unless its
heatmap output shapes are 80×80.
