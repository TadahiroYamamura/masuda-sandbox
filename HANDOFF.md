# HANDOFF
## 作業項目
2026-10-07: #10（RunJob）と#5（DeleteImage）。v0.3.0として公開した（`0d31786`、タグv0.3.0）。作業はmasudaのセッション（masuda-d3）の監督のもと、サブエージェントが実装した。

- `RunJob`（サーバーストリーム）: 使い捨てVMの作成→inputs（HostFile、または動いている別のsandboxからVMからVMへ直接写すFromSandbox）→setup_shell→shell→outputsをoutputs_host_dirへ回収→破棄。Phase・stdout・stderr・拒否した通信（denied）を流し、最後にFinished（setup・exited・job_timed_out・outputs・outputs_error・denied_hosts）。VMは成否・キャンセル・全体の期限切れのどれでも壊す。ジョブのVMは`job-<uuid>`で、sandboxes.jsonに書かない。段取りは`src/jobs.ts`、globは`src/glob.ts`（masudaの`privileged.Match`と同じ意味）
- `DeleteImage`: イメージの記録・Gondolinの資産・Dockerのイメージを、サービスの中で消す。使用中ならFailedPrecondition、無ければ何もしない。契約テストの後片付けをこれに切り替え、`test/contract/cleanup-image.ts`は消した
- `masuda-sandbox run`（`src/run.ts`）: ソケット経由でRunJobを呼ぶクライアント。終了コードはコマンドのもの（時間切れ124、前処理の失敗122、全体の期限切れ123、動かせなかった125）
- Execの時間切れの判定を「経過時間が期限以上」から「期限の半分以上」に緩めた（`guestTimedOut`、ExecのRPCにも効く）。期限はゲストの時計、経過時間はホストの時計で測っていて、起動直後のVMでは食い違い、RunJobの時間切れを4回に1回ほど見逃した。代償はコメントにある
## 完了した契約テスト
- C-S1〜C-S7とC-S16（RunJob 6件・DeleteImage 1件）の15件が緑（実VM、`0d31786`）。単体テスト148件
## 未完と理由
- S8（SSH egress）は手を付けていない
- DeleteImageの「使用中か」の確認と削除の間に、同じイメージでCreateSandbox・RunJobが始まると起動に失敗しうる（直していない）
- ゲストの時計がずれる原因は調べていない（S15と根が近いかもしれない）
## 次の一手
1. `docs/work-orders.md`のS8
## 注意点
- 契約テストは専用のソケット（例 `$XDG_RUNTIME_DIR/masuda-sandbox-<名前>.sock`）で立てたサービスに対して回す。回す前にハーネス（masudaの`masuda list --all`）に走行中のワークスペースが無いことを確かめ、終わったら自分のサービスのPIDをkillして`pgrep -af qemu-system`を見る
- `pnpm test`は`pnpm build`済みのdistを前提にする（`test/unit/dist.test.ts`）
- `masuda-sandbox`を入れ直すと、ハーネスに手で当てたgondolinのTCPの修正（masudaの`~/work/gondolin-notes/harness-hotfix/`）が消える。入れ直したら当て直す
## 契約への提案
- なし
