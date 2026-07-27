import fs from "node:fs";
import path from "node:path";

const [operation, sourceArg, destinationArg] = process.argv.slice(2);

if (operation === "clean") {
  if (!sourceArg) throw new Error("fs-task clean requires a target.");
  fs.rmSync(path.resolve(sourceArg), { recursive: true, force: true });
} else if (operation === "move") {
  if (!sourceArg || !destinationArg) {
    throw new Error("fs-task move requires source and destination paths.");
  }
  const source = path.resolve(sourceArg);
  const destination = path.resolve(destinationArg);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(source, destination);
} else {
  throw new Error(`Unsupported fs-task operation: ${operation || "<missing>"}`);
}
