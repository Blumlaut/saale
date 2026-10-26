import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2);
const norm = (f) => readFileSync(f, "utf8").split("\n").map((l) => l.trim().replace(/\s+/g, " "));
const A = norm(a), B = norm(b);
const map = new Map();
for (let i = 0; i + 4 <= B.length; i++) {
  const k = B.slice(i, i + 4).join("\n");
  if (!map.has(k)) map.set(k, i);
}
let i = 0;
while (i + 4 <= A.length) {
  const k = A.slice(i, i + 4).join("\n");
  const j = map.get(k);
  if (j === undefined) { i++; continue; }
  let len = 4;
  while (i + len < A.length && j + len < B.length && A[i + len] === B[j + len]) len++;
  console.log(`--- A:${i + 1}-${i + len} (${len} lines)  B:${j + 1}-${j + len}`);
  console.log(`    ${A[i].slice(0, 90)}`);
  console.log(`    ...${A[i + len - 1].slice(0, 90)}`);
  i += len;
}
