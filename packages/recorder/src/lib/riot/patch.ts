// Since 2025 patches are named after the year ("patch 26.19") while the game,
// match-v5 and Data Dragon keep the old numbering ("16.19"). Both name one
// patch.
export function internalPatch(version: string): [number, number] {
  const [major, minor] = version.split(".").map(Number);
  return [major >= 25 ? major - 10 : major, minor];
}
export const patchName = (version: string) => {
  const [major, minor] = internalPatch(version);
  return `${major + 10}.${minor}`;
};
// Negative when a is an earlier patch than b, 0 for the same patch.
export function comparePatch(a: string, b: string) {
  const [x1, y1] = internalPatch(a),
    [x2, y2] = internalPatch(b);
  return x1 - x2 || y1 - y2;
}
