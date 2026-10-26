import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["src/components", "src/lib", "src/app", "src/hooks", "src/server"];
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(name)) files.push(p);
  }
}
for (const r of roots) { try { walk(r); } catch {} }

const W = 10;
const blocks = new Map();
for (const f of files) {
  const norm = readFileSync(f, "utf8").split("\n").map((l) =>
    l.trim().replace(/\s+/g, " ").replace(/,$/, "")
  );
  const keep = (l) => l.length > 2 && !/^import |^from |^[{()}\[\];]+$|^(\/\/|\*|\/\*)/.test(l);
  for (let i = 0; i + W <= norm.length; i++) {
    const win = norm.slice(i, i + W);
    if (win.filter(keep).length < W - 2) continue;
    const key = win.join("\n");
    if (!blocks.has(key)) blocks.set(key, []);
    blocks.get(key).push(`${f}:${i + 1}`);
  }
}
const hits = [...blocks.entries()].filter(([, locs]) => {
  const fileset = new Set(locs.map((l) => l.split(":")[0]));
  return fileset.size > 1;
});
const byPair = new Map();
for (const [key, locs] of hits) {
  const k = [...new Set(locs.map((l) => l.split(":")[0]))].sort().join(" | ");
  if (!byPair.has(k)) byPair.set(k, []);
  byPair.get(k).push({ start: parseInt(locs[0].split(":")[1], 10), locs, text: key });
}
const rows = [];
for (const [pair, list] of byPair) {
  list.sort((a, b) => a.start - b.start);
  rows.push({ pair, windows: list.length, locs: list[0].locs });
}
rows.sort((a, b) => b.windows - a.windows);
for (const r of rows.slice(0, 45)) {
  console.log(`${String(r.windows).padStart(4)} windows  ${r.pair}`);
  console.log(`      at ${r.locs.slice(0, 4).join(" ")}`);
}
