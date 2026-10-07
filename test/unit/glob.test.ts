import { describe, expect, it } from "vitest";

import { selectFiles } from "../../src/files.js";
import { baseDir, match, patternError } from "../../src/glob.js";

// 期待値はmasudaのinternal/privileged/glob_test.go（Goの実装のテスト）から写したもの。
describe("match", () => {
  const cases: [string, string, boolean][] = [
    ["build/**", "build/artifact.txt", true],
    ["build/**", "build/a/b/c.bin", true],
    ["build/**", "build", false],
    ["build/**", "builds/x", false],
    ["**/*.xml", "report.xml", true],
    ["**/*.xml", "a/b/report.xml", true],
    ["a/**/b.txt", "a/b.txt", true],
    ["a/**/b.txt", "a/x/y/b.txt", true],
    ["out.txt", "out.txt", true],
    ["out.txt", "x/out.txt", false],
    ["*.txt", "a/b.txt", false],
    ["build", "build/a", false],
  ];
  it.each(cases)("Goの実装と同じく %s は %s に当たるかどうかが一致する", (pat, name, want) => {
    expect(match(pat, name)).toBe(want);
  });

  // Goのpath.Matchの構文（?・文字クラス・否定・範囲）がセグメントの中で同じように効く。
  const syntax: [string, string, boolean][] = [
    ["a/[ab]/c", "a/b/c", true],
    ["a/[ab]/c", "a/x/c", false],
    ["a/[^ab]/c", "a/x/c", true],
    ["a/[^ab]/c", "a/a/c", false],
    ["r[0-9].log", "r7.log", true],
    ["r[0-9].log", "rx.log", false],
    ["?.txt", "a.txt", true],
    ["?.txt", "ab.txt", false],
    ["**/**/x", "x", true],
    ["**", "a/b", true],
  ];
  it.each(syntax)("path.Matchの構文 %s を %s に照らした結果が %s になる", (pat, name, want) => {
    expect(match(pat, name)).toBe(want);
  });
});

describe("patternError", () => {
  it.each(["build/**", "out.txt", "**/*.xml", "a/[ab]/c"])("正しいパターン %s を受け付ける", (p) => {
    expect(patternError(p)).toBeUndefined();
  });
  it.each(["", "/etc/passwd", "../x", "a/../b", "./a", "a//b", "a/[", "a\\b", "[]", "a/[a-]"])("不正なパターン %s を拒む", (p) => {
    expect(patternError(p)).toBeDefined();
  });
});

describe("baseDir", () => {
  it.each([
    ["build/**", "build"],
    ["**/*.xml", "."],
    ["a/b/*.txt", "a/b"],
    ["out.txt", "out.txt"],
  ])("%s のfindの起点は %s になる", (pat, want) => {
    expect(baseDir(pat)).toBe(want);
  });
});

describe("selectFiles", () => {
  it("findの出力から当たるものだけを正規化・重複除去・辞書順にし、許可ビットの下位9ビットを残す", () => {
    const out = ["4755 10 ./build/z.bin", "644 3 build/a.txt", "644 3 ./build/a.txt", "600 1 other.txt", "644 1 ../escape/x", "bad line", ""].join("\0");
    expect(selectFiles(out, ["build/**", "**/x"])).toEqual([
      { rel: "build/a.txt", mode: 0o644, size: 3 },
      { rel: "build/z.bin", mode: 0o755, size: 10 },
    ]);
  });

  it("改行を含むファイル名もNUL区切りで1つとして扱う", () => {
    expect(selectFiles("644 1 ./a\nb.txt\0", ["*.txt"])).toEqual([{ rel: "a\nb.txt", mode: 0o644, size: 1 }]);
  });
});
