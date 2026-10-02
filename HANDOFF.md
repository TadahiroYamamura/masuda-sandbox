# HANDOFF
## 作業項目
S9（硬化）完了。S8（SSH egress）は指示により後回しで、手を付けていない。
- **BuildImageの冪等化**（`src/build.ts`・`src/images.ts`・`src/service.ts`）: `docker build`後、`ImageStore.findReusable(ociDigest, arch)`が同じ(oci_digest, arch)で資産ディレクトリが実在する最新レコードを返せば、`docker tag`と`gondolin build`を省いてその`Image`を`built`で返す。ログ行は`==> reusing existing gondolin assets <build_id> for <digest> (gondolin build skipped)`、サービスログは`"msg":"image reused"`。既存レコードは書き換えない（nameが違っても元のnameのまま）
  - Gondolinのbuild idは**内容から決まらない**（同じ入力でも毎回別id）。以前の`ImageStore.record`のコメントは誤りだったので直した
- **`node dist/cli.js images prune [--dry-run]`**（`src/prune.ts`・`src/cli.ts`、契約外）: 消すのは (1) 資産の無いレコード (2) 同じ(oci_digest, arch)の古いレコード（最新1つを残す） (3) 残るレコードが指さない資産ディレクトリ。残すのは Gondolinのref（`listImageRefs()`、例 alpine-base:latest → `3cd7a864...`）が指す資産、`sandboxes.json`の記録が使う資産、images.jsonに無く30分以内に更新された資産（実行中のビルドかもしれない）。サイズはブロック数（du相当）
- **Exec同時数上限**（`src/exec.ts`の`ExecSlots`、`src/sandboxes.ts`のEntryごと）: 既定8、超えたら`ResourceExhausted`（`too many concurrent execs (limit 8)`）。正常終了・エラー・取消で枠を返す
- **ReadFile既定64MiB**: S5で`src/files.ts`に入っていた（確認のみ）。**イベントバッファ1000件**: `src/events.ts`の`CAPACITY`（確認のみ）
- **メトリクスログ**（`src/metrics.ts`、`src/server.ts`で起動）: 60秒ごとに`{"msg":"metrics","sandboxes":<全エントリ数>,"running":<RUNNING数>,"qemu":[{"id","pid","rssKib","execs"}]}`を標準エラーへ。RSSは`/proc/<pid>/status`の`VmRSS`（macOSでは`rssKib`が出ない）。`MASUDA_SANDBOX_METRICS_INTERVAL_MS`で間隔を変えられる（検証用）
- 単体テスト追加: `test/unit/prune.test.ts`（findReusable・planPrune・applyPrune、`GONDOLIN_IMAGE_STORE`を一時ディレクトリに向ける）、`test/unit/limits.test.ts`（ExecSlots・VmRSSの解析）
## 完了した契約テスト
C-S1〜C-S7すべて緑（S8は未着手）。`node dist/cli.js serve --socket $XDG_RUNTIME_DIR/masuda-sandbox-s9.sock`に対し`pnpm test:contract`を**2回連続**で7 passed（各約31〜33秒）。C-S2は約0.7〜0.8秒で、2回とも`image reused`（既存の`b6839a0d-...`）。`~/.cache/gondolin/images/objects`は15のまま増えていない。`pnpm test`は34 passed
- 空の状態からの確認: `XDG_DATA_HOME`と`GONDOLIN_IMAGE_STORE`をscratchpadに向けた別サービスでC-S2だけを2回: 1回目`image built`（約11.7秒）で資産1つ、2回目`image reused`（0.3秒）で資産1つのまま。その一時ストアでprune（実削除）も確認し、ストアごと消した
- 実VMでの手動確認（scratchpadのスクリプト、リポジトリには残していない）: `sleep 4`を8並列中の9本目はcode 8（ResourceExhausted）、8本は全部exit 0、その後のExecは成功。`sleep 30`を8並列で取消すると直後のExecは成功（枠が戻る）
- メトリクス: 実行中のVMについて`rssKib`が351236〜515640程度で出ることを確認
## 未完と理由
- **実データへの`images prune`（実削除）は未実行**。ユーザーが実行する。`--dry-run`の結果: レコード14件（すべて`contract:test`の同一digest `sha256:3f14a23c...`、最新の`b6839a0d-...`を残す）、資産ディレクトリ14個、**合計5.3 GiB**（各386.6 MiB）。サービス停止中に実行すること
- S8は範囲外（指示により後回し）
## 次の一手
1. ユーザーが`node dist/cli.js images prune --dry-run`を見たうえで`node dist/cli.js images prune`を実行（サービス停止中）
2. `docs/work-orders.md`のS8（SSH egress）
## 注意点
- **pruneとサービスの同時実行は避ける**: images.jsonの読み書きは同一プロセス内でしか直列化していない。また、images.jsonに載っていてもビルド途中のレコードは無いが、サービスがビルド中に作った未記録の資産は30分ガードでしか守っていない
- Exec上限の枠は「ホスト側で待っているExec」の数。取消やホスト側タイムアウトで枠は返るが、Gondolinは実行を放棄するだけなのでゲスト内のプロセスは動き続けることがある。ReadFile/WriteFileは内部でvm.execを使うが枠には数えていない
- BuildImageの再利用はdocker buildの結果のimage idで判定する。`--provenance=false`を外すと毎回idが変わって再利用されなくなる（S2のコメント参照）
- 同じDockerfileを同時に2本BuildImageすると、両方とも`gondolin build`を走らせ得る（再利用判定は完了済みのレコードだけを見る）。後でpruneが古い方を消す
- metricsの`sandboxes`はSTARTING・STOPPED・FAILEDも含むエントリ数、`running`はRUNNINGのみ
- `pkill -f`で止めない。`pgrep -f '^node dist/cli.js serve'`でPIDを取ってkill。`dist/`を作り直したらサービス再起動
- 残したもの: QEMUなし（親セッションのPID 12244以外）。`/tmp/gondolin-ssh-*`なし。`sandboxes.json`は空。サービスは停止済み。Gondolin資産は15個のまま（prune待ち）。dockerタグ`masuda-sandbox/image:x86_64-3f14a23ce3f7d022`は継続
## 契約への提案
なし
