import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { RunJobEvent_FinishedSchema } from "../../src/gen/masuda/sandbox/v1/sandbox_pb.js";
import { exitCodeOf } from "../../src/run.js";

const fin = (f: Parameters<typeof create<typeof RunJobEvent_FinishedSchema>>[1]) => create(RunJobEvent_FinishedSchema, f);
const ok = { exitCode: 0, signal: "", timedOut: false };

describe("exitCodeOf", () => {
  it.each([
    ["コマンドの終了コードをそのまま返す", fin({ setup: ok, exited: { ...ok, exitCode: 7 } }), 7],
    ["シグナルで終わったら128+番号を返す", fin({ exited: { exitCode: -1, signal: "SIGKILL", timedOut: false } }), 137],
    ["--timeoutで時間切れなら124を返す", fin({ exited: { exitCode: 137, signal: "", timedOut: true } }), 124],
    ["前処理が失敗したら122を返す", fin({ setup: { ...ok, exitCode: 1 } }), 122],
    ["全体の期限切れなら、コマンドの結果があっても123を返す", fin({ jobTimedOut: true, exited: ok }), 123],
  ])("%s", (_name, f, want) => {
    expect(exitCodeOf(f)).toBe(want);
  });
});
