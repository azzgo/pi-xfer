/**
 * A stand-in for `xfer-adapterd`, so the gateway's argv can be asserted without
 * an engine, a socket or a real send. It records the argv it was given and
 * prints what the real CLI prints, driven by `stub-config.json` in its own
 * directory — which the gateway passes as `--dir`, exactly like a real host.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const argv = process.argv.slice(2);
const dirFlag = argv.indexOf("--dir");
const dir = dirFlag >= 0 ? argv[dirFlag + 1] : process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(dir, "stub-config.json"), "utf-8"));

fs.appendFileSync(config.log, `${JSON.stringify(argv)}\n`);

if (config.copyTo) {
  const fileIndex = argv[0] === "mesh" ? 3 : 2;
  fs.copyFileSync(argv[fileIndex], config.copyTo);
}

if (config.stdout) process.stdout.write(config.stdout);
if (config.stderr) process.stderr.write(config.stderr);
process.exitCode = config.code ?? 0;
