/**
 * Pack a loadable extension into dist/.
 *
 * Bundled entries: background, sidebar, builder, prompt, network UI, activity log, devtools.
 * Copied (path-stable): manifest, HTML, CSS, icons, catalog JSON, classic
 * content scripts under inject/ and network/inject/.
 *
 * Left behind: node_modules, scripts/, tests, README/CONTEXT, webpack config,
 * and ESM sources that are already inlined into the entries (lib/, most of
 * sidebar/network JS, CodeMirror source, network-hook generators).
 */
const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");
const TerserPlugin = require("terser-webpack-plugin");
const esbuild = require("esbuild");

/**
 * Minify copied JSON/CSS/classic JS. Webpack already minifies bundled entries.
 * @param {Buffer} content
 * @param {string} absoluteFrom
 */
async function minifyCopiedAsset(content, absoluteFrom) {
  const source = content.toString();
  if (absoluteFrom.endsWith(".json")) {
    return JSON.stringify(JSON.parse(source));
  }
  const loader = absoluteFrom.endsWith(".css") ? "css" : "js";
  const result = await esbuild.transform(source, {
    minify: true,
    loader,
    legalComments: "none",
  });
  return result.code;
}

module.exports = {
  mode: "production",
  target: ["web", "es2022"],
  devtool: false,
  entry: {
    background: "./background.js",
    "sidebar/sidebar": "./sidebar/sidebar.js",
    "builder/builder": "./builder/builder.js",
    "prompt/params": "./prompt/params.js",
    "network/ui/rules": "./network/ui/rules.js",
    "devtools/devtools": "./devtools/devtools.js",
    "activity-log/activity-log": "./activity-log/activity-log.js",
  },
  output: {
    filename: "[name].js",
    path: path.resolve(__dirname, "dist"),
    clean: true,
    iife: true,
    publicPath: "",
  },
  module: {
    parser: {
      javascript: {
        // Sidebar lazy-loads CodeMirror. Async chunks cannot be fetched from
        // an extension URL without extra publicPath wiring, so fold them in.
        dynamicImportMode: "eager",
      },
    },
  },
  resolve: {
    extensions: [".js"],
  },
  performance: {
    hints: false,
  },
  optimization: {
    minimize: true,
    splitChunks: false,
    runtimeChunk: false,
    minimizer: [
      new TerserPlugin({
        extractComments: false,
        terserOptions: {
          // executeScript({ func }) serializes the function source into the
          // page. Do not hoist nested helpers out of those function bodies.
          compress: {
            hoist_funs: false,
            hoist_vars: false,
          },
          format: { comments: false },
        },
      }),
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: "manifest.json" },
        { from: "icon.png" },
        {
          from: "icons",
          to: "icons",
          globOptions: { ignore: ["**/*.md"] },
        },
        {
          from: "data/links.json",
          to: "data/links.json",
          transform: minifyCopiedAsset,
        },
        {
          from: "network/data/network-rule-templates.json",
          to: "network/data/network-rule-templates.json",
          transform: minifyCopiedAsset,
        },
        {
          from: "**/*.html",
          globOptions: {
            ignore: ["**/node_modules/**", "**/dist/**"],
          },
        },
        {
          from: "**/*.css",
          globOptions: {
            ignore: ["**/node_modules/**", "**/dist/**"],
          },
          transform: minifyCopiedAsset,
        },
        {
          from: "inject/*.js",
          to: "inject/[name][ext]",
          transform: minifyCopiedAsset,
        },
        {
          from: "network/inject/*.js",
          to: "network/inject/[name][ext]",
          transform: minifyCopiedAsset,
        },
      ],
    }),
  ],
};
