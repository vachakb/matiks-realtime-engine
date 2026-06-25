// Monorepo Metro config: the Nitro module lives at <repo>/modules (a first-class package the
// example app depends on), so Metro must watch the repo root and resolve node_modules from the
// app's folder — otherwise the module can't find react-native-nitro-modules.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
