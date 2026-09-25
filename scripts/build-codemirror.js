const esbuild = require("esbuild");
const path = require("path");

const rootDir = path.join(__dirname, "..");

esbuild
  .build({
    entryPoints: [path.join(rootDir, "lib", "codemirror-fields.js")],
    outfile: path.join(rootDir, "lib", "codemirror-fields.bundle.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["firefox128"],
    logLevel: "info",
  })
  .then(() => {
    console.log("Wrote lib/codemirror-fields.bundle.js");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
