# Artwork recognizer drop-in

Filled by `scripts/ensure-artwork-mobile.ps1`, which `scripts/start-deckino-android.ps1`
runs before Metro starts. Do not edit these files by hand.

- `recognizer.onnx` (git-ignored): the artwork embedding network with the prototype
  index baked in; input the 224x224 recognition crop, output the top 128 prototypes.
- `app-labels.json` (git-ignored): oracle ids, card names and prototype → card mapping.
- `mobile-manifest.json`: model version, crop contract and the app's score floor.

## Where the model comes from

The artwork model trains on the NVIDIA laptop. Import its bundle in the Toolbox on
this PC; that writes `data/training/current-artwork.json`. The ensure script then
exports that model on CPU into `data/training/mobile/artwork/<model-version>/`,
proves the app's TypeScript crop and decision reproduce the export's fixture
(`scripts/verify-artwork-model.mjs`, report in `app-verification.json` there), and
copies the three files here. A model change needs a Metro restart, not a dev-client
rebuild.
