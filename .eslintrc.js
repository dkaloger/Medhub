module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    // `void promise` marks a deliberately unawaited promise.
    'no-void': ['warn', { allowAsStatement: true }],
    // Bit operations are intentional in the base64 decoder and noise generator.
    'no-bitwise': 'off',
  },
};
