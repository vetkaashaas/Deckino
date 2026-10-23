const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
if (!config.resolver.assetExts.includes('onnx')) {
  config.resolver.assetExts.push('onnx');
}
if (!config.resolver.assetExts.includes('tflite')) {
  config.resolver.assetExts.push('tflite');
}

// expo-image renders the client's SVG brand assets natively.
if (!config.resolver.assetExts.includes('svg')) {
  config.resolver.assetExts.push('svg');
}

// Native build output (gigabytes under android/) isn't JS: crawling and watching it without watchman stalls Metro.
config.resolver.blockList = [].concat(
  config.resolver.blockList ?? [],
  // Also matches the folder itself (no trailing separator), which is what lets the crawler skip it whole.
  /[\\/]android[\\/](?:app[\\/])?(?:build|\.cxx|\.gradle)(?:[\\/]|$)/,
);

module.exports = config;
