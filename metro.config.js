const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const fs = require('fs');
const path = require('node:path');

const rnwPath = fs.realpathSync(path.resolve(require.resolve('react-native-windows/package.json'), '..'));
const escape = (p) => p.replace(/[/\\]/g, '/');

/**
 * Metro configuration for Android, macOS and Windows.
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    blockList: [
      // Native build output must not be watched or bundled (MSBuild also locks these files).
      new RegExp(`${escape(path.resolve(__dirname, 'windows'))}.*`),
      new RegExp(`${escape(path.resolve(__dirname, 'macos', 'build'))}.*`),
      new RegExp(`${escape(path.resolve(__dirname, 'macos', 'Pods'))}.*`),
      new RegExp(`${escape(rnwPath)}/build/.*`),
      new RegExp(`${escape(rnwPath)}/target/.*`),
      /.*\.ProjectImports\.zip/,
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
