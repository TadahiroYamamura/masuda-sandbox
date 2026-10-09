# HANDOFF
## 作業項目
2026-10-09: #6。`src/egress.ts`の`createHttpHooks`に`blockInternalRanges: true`を明示した（`0ecc6b4`、`main`にpush済み、未タグ）。Gondolinの既定に頼っていた。masuda#13（triageゲートの自己解決の禁止）は「ゲストがegressで127.0.0.1やlocalhostを承認されても、ホストのループバックのmasuda serveには届かない」ことを根拠の1つにしている。作業はmasudaのセッション（masuda-d3）が行った。

**Issueの棚卸し（2026-10-09、ユーザー判断）**: マイルストーン`v0.4.0`・`v0.4.1`・`v0.5`を作った。振り分けは次のとおり。

| マイルストーン | Issue |
|---|---|
| v0.4.1（VMの作業） | #8（sshでアタッチ中だとDestroySandboxが終わらない。masuda#84の前提。sandbox側で破棄の各段に上限を設けてQEMUを止める方向）、#11（VMの中で`.ko.gz`を読めない。上流のgondolin#161と同じ件） |
| v0.5 | #4（S15 スリープ後の時計）、#1（S8 SSH egress） |
| 無し（保留） | #9（GondolinのTCP、上流#155〜#160の返事待ち）、#2（非公開APIへの依存。Gondolinの版上げのときに確認項目を回す）、#3（読み取り専用ディレクトリの件。上流への報告は、#155への反応を見てから慎重に） |

前回（2026-10-07、v0.3.0のRunJob・DeleteImage）の未完は下に残した。
## 完了した契約テスト
- 単体テスト149件とCIが緑（`0ecc6b4`）。足したテスト: 方針で許したホストでも内部アドレス（127/8、::1、10/8、172.16/12、192.168/16）への接続が断られ、外部のアドレスは通る（`test/unit/egress.test.ts`）。`blockInternalRanges: false`にすると落ちる
- 契約テスト（実VM）は今回回していない。前回はC-S1〜C-S7とC-S16の15件が緑（`0d31786`）。v0.4.0のリリース前に回す
## 未完と理由
- v0.4.0のタグ: masudaのリリース（Skill `release`、週末）のときに打つ。その前に契約テストを実VMで回す
- #11: 上流のgondolin#161にUbuntu 24.04での再現と、ビルドの設定では避けにくいことをコメントした（masudaの`~/work/gondolin-notes/`）。上流の反応を見て、v0.4.1でsandbox側の手当て（起動時に展開するか、ビルド時か）をするか決める
- S8（SSH egress）は手を付けていない
- DeleteImageの「使用中か」の確認と削除の間に、同じイメージでCreateSandbox・RunJobが始まると起動に失敗しうる（直していない）
- ゲストの時計がずれる原因は調べていない（S15と根が近いかもしれない）
## 次の一手
1. 週末のv0.4.0のリリース前に契約テストを実VMで回し、タグを打つ
2. v0.4.1の#8（masuda#84の前提）
## 注意点
- 契約テストは専用のソケット（例 `$XDG_RUNTIME_DIR/masuda-sandbox-<名前>.sock`）で立てたサービスに対して回す。回す前にハーネス（masudaの`masuda list --all`）に走行中のワークスペースが無いことを確かめ、終わったら自分のサービスのPIDをkillして`pgrep -af qemu-system`を見る
- `pnpm test`は`pnpm build`済みのdistを前提にする（`test/unit/dist.test.ts`）
- `masuda-sandbox`を入れ直すと、ハーネスに手で当てたgondolinのTCPの修正（masudaの`~/work/gondolin-notes/harness-hotfix/`）が消える。入れ直したら当て直す
- 上流（Gondolin）への投稿は、ユーザーがWebの画面から個人のアカウント（TadahiroYamamura）で行う。この端末の`gh`は社用のアカウントで、`scripts/gh.sh`のトークンは自分のリポジトリだけ
## 契約への提案
- なし
