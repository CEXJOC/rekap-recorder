// Riot match and timeline files of a game folder. Saved gzip-compressed
// (match.json.gz, timeline.json.gz: about a tenth of the size); plain .json
// files, such as those of the dataset pipeline, are read too.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const hasGameFile = (dir: string, name: string) =>
  existsSync(path.join(dir, name)) || existsSync(path.join(dir, `${name}.gz`));

export function readGameFile<T>(dir: string, name: string): T {
  const plain = path.join(dir, name);
  if (existsSync(plain)) return JSON.parse(readFileSync(plain, "utf8")) as T;
  return JSON.parse(
    gunzipSync(readFileSync(`${plain}.gz`)).toString("utf8"),
  ) as T;
}

export async function writeGameFile(
  dir: string,
  name: string,
  value: unknown,
  compress = true,
) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, compress ? `${name}.gz` : name);
  const text = JSON.stringify(value);
  await writeFile(`${file}.tmp`, compress ? gzipSync(text) : text);
  await rename(`${file}.tmp`, file);
}
