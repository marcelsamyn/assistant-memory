import { readdir } from "node:fs/promises";

const packageName = "@marcelsamyn/memory";
const sdkDir = new URL("../dist/sdk/", import.meta.url);

const sdkModuleNames = (await readdir(sdkDir))
  .filter((fileName) => fileName.endsWith(".js"))
  .map((fileName) => fileName.slice(0, -".js".length))
  .filter((moduleName) => moduleName !== "index")
  .sort();

await Promise.all([
  import(`${packageName}/sdk`),
  ...sdkModuleNames.map(
    (moduleName) => import(`${packageName}/sdk/${moduleName}`),
  ),
]);

console.log("SDK package exports import cleanly.");
