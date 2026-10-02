# HANDOFF
## 作業項目
S7（観測）完了。
- `src/events.ts`: `EventQueue`に購読（`watch(afterSeq, signal)`）と`close()`を追加。リスナー登録→`after(afterSeq)`の再送→ライブの順で、seqで重複を落とす。複数購読者可。signalのabortかキューの`close()`でストリームが終わる
- **`after_seq = 0`の解釈**: 契約の文言は「0 = only new events」だが、C-S7は`afterSeq: 0`で既に起きたイベントの受信を期待している。そのため**0のときはバッファにある全件（直近1000件）を再送してからライブに移る**。`after_seq > 0`はそのseqより後を再送
- `src/sandboxes.ts`:
  - `StateChanged`: Create開始でSTARTING、Create完了でRUNNING、Destroyで`STOPPED`（detail `destroyed`）、shutdownで`STOPPED`（detail `service shutdown`）、QEMU消失で`FAILED`（detail・`failure`とも`qemu process exited`）。STARTING中のDestroyや起動失敗ではSTOPPEDを出さずキューを閉じるだけ
  - QEMU監視: GondolinはQEMU終了のイベントを公開していない（`SandboxController`の`exit`は内部、終了後は`getHostPid()`がnullになる）ので、5秒ごとに`getHostPid()`と`process.kill(pid, 0)`で確認。消えていればFAILEDにしてVMを`close()`しキューを閉じる。`closeVm`の先頭で監視を止めるので、Destroy/shutdown中の誤検知はない
  - サンドボックスの終わり（Destroy・shutdown・FAILED・起動失敗）でキューを閉じる。再起動後にSTOPPEDで復元された記録は閉じたキュー（再送なしで即終了）
  - `snapshot`に`lastHttpActivity`・`inflightHttpRequests`。RUNNING以外ではinflightは0
- `src/egress.ts`: `activity()`。lastは開始・完了・拒否（protocol含む）の直近時刻。inflightは保留中のうち10分（`PENDING_TTL_MS`）以内に開始したもの
- `src/service.ts`: `watchEvents`（存在しないidはNotFound）
- `test/unit/events.test.ts`を追加
## 完了した契約テスト
C-S1〜C-S7すべて。`node dist/cli.js serve --socket $XDG_RUNTIME_DIR/masuda-sandbox-s7.sock`を起動し`MASUDA_SANDBOX_SOCKET=... pnpm test:contract`で**7 passed**（全体約44秒、C-S7は約5.3秒）。`pnpm test`は30 passed
手動確認（scratchpadのスクリプト、リポジトリには残していない）: Create前後のSTARTING→RUNNING、`https://example.com/foo/bar?secret=1&x=2`が`path: "/foo/bar"`（クエリなし）、finishedにstatus・durationMs、denied（host-not-allowed）、Destroyで`STOPPED`後にストリーム終了、`afterSeq: 2`の別購読者は3以降を受信。QEMUをSIGKILLすると約5秒でFAILED（`failure`に理由）、そのサンドボックスへのExecはFailedPrecondition、ストリームは終了、Destroyで記録が消える
## 未完と理由
- S8以降は範囲外
- inflightが1以上になる瞬間（応答待ちの最中）はテストしていない（ロジックは単体で読める範囲）
## 次の一手
`docs/work-orders.md`のS8（SSH egress）
## 注意点
- FAILEDの検知は最大5秒遅れる。Gondolinが`autoRestart`を有効にした場合はPIDが入れ替わり得るが、現状は既定（無効）で使っている
- FAILEDになったサンドボックスは`entries`に残る（Get/Listで見える）。Destroyで消える。同じidでのCreateは上書きされる（従来どおり）。CreateでEventQueueが新しくなるのでseqは1から振り直し
- イベントのキューは閉じると以後の`watch`は再送だけで終わる。S8でSSH egressのイベントを足すなら`SandboxEvent`に枠がないので契約側の判断が要る
- `tcp.hosts`宛の通信はHTTP中継を通らないのでイベントに出ない（S6から）
- **GondolinのsshdはゲストPID 1（sandboxd）が回収しない**。killするとゾンビになり`kill -0`は成功し続ける。`ssh.ts`は`/proc/<pid>/stat`の状態Zを終了とみなしている
- Gondolinは1VMにつきSSHアクセスを1つしか持たない。`vm.enableSsh`は内部で`execFileSync("ssh-keygen")`を使う
- サービスは`pkill -f`で止めない（自分のbashに一致する）。`pgrep -f '^node dist/cli.js serve'`でPIDを取ってkill
- `dist/`を作り直したらサービスの再起動が必要
- 契約テストは毎回C-S2でイメージを作る。このセッションでGondolin資産`fd17bc5c-...`・`2d97b809-...`が増えた（images.jsonに記録済み。`~/.cache/gondolin/images/objects`は計6.0G）。掃除はS9のBuildImage冪等化の範囲
- 無関係なQEMU（PID 12244）とGondolin資産`3cd7a864...`・`c4dc6a9f...`は親セッションのもの。触っていない
- 残したもの: QEMUなし（12244以外）。`/tmp/gondolin-ssh-*`なし。dockerタグ`masuda-sandbox/image:x86_64-3f14a23ce3f7d022`（S2から継続）と`masuda-sandbox-test:latest`（以前から）。`sandboxes.json`は空。サービスは停止済み
## 契約への提案
- `WatchEventsRequest.after_seq`のコメント「0 = only new events」は、C-S7（`afterSeq: 0`で既発のイベントを受け取る）と食い違う。実装は「0 = バッファにある全件を再送」としたので、コメントを「0 = replay everything still buffered」に直すのが整合的（契約ファイルは変更していない）
