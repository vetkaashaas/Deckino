# Extractor model drop-in

This folder is for the **converted** on-device extractor (TFLite/ONNX), not the
PyTorch checkpoint from training.

## Where the trained weights live

Training runs on the NVIDIA PC. Copy the compact handoff ZIP to this machine
and import it:

```powershell
powershell -File .\scripts\sync-extraction-model.ps1 -Pack          # on the training PC
powershell -File .\scripts\sync-extraction-model.ps1 -Path <zip>    # on this PC
```

That installs:

- `data/training/artifacts/<model-version>/extractor.pt`
- matching `config.json`, `preprocessing.json`, `thresholds.json`
- `data/training/current-extraction.json` — the pointer other tools should read

Do not put `extractor.pt` in this App folder. The phone cannot run PyTorch
checkpoints.

## After a mobile export exists

Copy with `scripts/copy-extractor-to-app.ps1`. The Scan screen loads
`extractor.onnx` plus `mobile-manifest.json` and `thresholds.json`. Rebuild the
Android dev client after replacing the ONNX file. TFLite is optional; do not
ship a converted `.tflite` unless its heatmap output shapes are 80×80.
