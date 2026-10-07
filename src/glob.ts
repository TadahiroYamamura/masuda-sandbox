// RunJobのinputs（FromSandbox.patterns）とoutputsのglob。masudaの特権コマンドが使っていた
// Goの実装（masudaの`internal/privileged/glob.go`）と同じ意味にしてある。masudaの宣言
// （privilegedCommandsのinputs・outputs）をそのまま渡せるようにするため。
//
// 各セグメントはGoの`path.Match`の構文（`*`・`?`・`[...]`・`[^...]`・`\`によるエスケープ）か、
// 0個以上のセグメントに当たる`**`。ただしvalidatePatternが`\`を拒むので、エスケープは
// 実際には使えない（Goの側も同じ）。

type Token =
  | { kind: "star" }
  | { kind: "any" }
  | { kind: "lit"; ch: string }
  | { kind: "class"; negated: boolean; ranges: [string, string][] };

class BadPattern extends Error {}

// Goのpath.MatchのgetEscと同じ規則: クラスの中で`-`・`]`を範囲の端に置けない、
// クラスが閉じずに終わるのは不正。
function classChar(cs: string[], i: number): [string, number] {
  let c = cs[i];
  if (c === undefined || c === "-" || c === "]") throw new BadPattern("syntax error in pattern");
  if (c === "\\") {
    i += 1;
    c = cs[i];
    if (c === undefined) throw new BadPattern("syntax error in pattern");
  }
  i += 1;
  if (i >= cs.length) throw new BadPattern("syntax error in pattern");
  return [c, i];
}

function compileSegment(seg: string): Token[] {
  const cs = Array.from(seg);
  const out: Token[] = [];
  let i = 0;
  while (i < cs.length) {
    const c = cs[i]!;
    if (c === "*") {
      out.push({ kind: "star" });
      i += 1;
    } else if (c === "?") {
      out.push({ kind: "any" });
      i += 1;
    } else if (c === "\\") {
      const next = cs[i + 1];
      if (next === undefined) throw new BadPattern("syntax error in pattern");
      out.push({ kind: "lit", ch: next });
      i += 2;
    } else if (c === "[") {
      i += 1;
      let negated = false;
      if (cs[i] === "^") {
        negated = true;
        i += 1;
      }
      const ranges: [string, string][] = [];
      for (;;) {
        if (cs[i] === "]" && ranges.length > 0) {
          i += 1;
          break;
        }
        let lo: string;
        [lo, i] = classChar(cs, i);
        let hi = lo;
        if (cs[i] === "-") [hi, i] = classChar(cs, i + 1);
        ranges.push([lo, hi]);
      }
      out.push({ kind: "class", negated, ranges });
    } else {
      out.push({ kind: "lit", ch: c });
      i += 1;
    }
  }
  return out;
}

function codePoint(c: string): number {
  return c.codePointAt(0)!;
}

function matchTokens(toks: Token[], cs: string[]): boolean {
  if (toks.length === 0) return cs.length === 0;
  const [t, ...rest] = toks as [Token, ...Token[]];
  if (t.kind === "star") {
    for (let k = 0; k <= cs.length; k++) if (matchTokens(rest, cs.slice(k))) return true;
    return false;
  }
  const c = cs[0];
  if (c === undefined) return false;
  let ok: boolean;
  if (t.kind === "any") ok = true;
  else if (t.kind === "lit") ok = t.ch === c;
  else {
    const p = codePoint(c);
    ok = t.ranges.some(([lo, hi]) => codePoint(lo) <= p && p <= codePoint(hi)) !== t.negated;
  }
  return ok && matchTokens(rest, cs.slice(1));
}

function matchSegment(pat: string, name: string): boolean {
  let toks: Token[];
  try {
    toks = compileSegment(pat);
  } catch {
    return false;
  }
  return matchTokens(toks, Array.from(name));
}

// 1つのパターンを検査する。不正なら理由を返す。
export function patternError(p: string): string | undefined {
  if (p.trim() === "") return "empty pattern";
  if (p.startsWith("/") || p.includes("\\")) return `${JSON.stringify(p)} must be relative`;
  for (const seg of p.split("/")) {
    if (seg === "") return `${JSON.stringify(p)} has an empty path segment`;
    if (seg === "." || seg === "..") return `${JSON.stringify(p)} must not contain ${JSON.stringify(seg)}`;
    if (seg === "**") continue;
    try {
      compileSegment(seg);
    } catch (e) {
      return `${JSON.stringify(p)}: ${(e as Error).message}`;
    }
  }
  return undefined;
}

// nameは`/`区切りの相対パス。
export function match(pattern: string, name: string): boolean {
  return matchSegs(pattern.split("/"), name.split("/"));
}

function matchSegs(pat: string[], name: string[]): boolean {
  while (pat.length > 0) {
    if (pat[0] === "**") {
      while (pat[0] === "**") pat = pat.slice(1);
      if (pat.length === 0) return name.length > 0;
      for (let i = 0; i < name.length; i++) if (matchSegs(pat, name.slice(i))) return true;
      return false;
    }
    if (name.length === 0) return false;
    if (!matchSegment(pat[0]!, name[0]!)) return false;
    pat = pat.slice(1);
    name = name.slice(1);
  }
  return name.length === 0;
}

// パターンのうちワイルドカードを含まない先頭のセグメント（findを始める場所）。
// 先頭からワイルドカードなら"."。
export function baseDir(pattern: string): string {
  const lit: string[] = [];
  for (const seg of pattern.split("/")) {
    if (seg === "**" || /[*?[\\]/.test(seg)) break;
    lit.push(seg);
  }
  return lit.length === 0 ? "." : lit.join("/");
}
