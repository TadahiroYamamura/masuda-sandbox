# 作業単位（masuda-sandbox）

1項目を1セッションで終える。完了の判定は対応する契約テスト（`test/contract/`）が緑であること。各項目の「やらないこと」を守る。契約（`sandbox.proto`）は変えない。

共通の前提: 全体設計は`../masuda/docs/design/overview.md`の第6章。Gondolinの使い方は`node_modules/@earendil-works/gondolin/docs/`と、masudaリポジトリの`docs/research/spike-gondolin/`の動くスクリプト。

## S1. 骨組みと`serve`

- `pnpm install`、`tsconfig.json`、`buf generate`で`src/gen/`を作る
- `src/cli.ts`: `serve --socket <path>`。Connect（`@connectrpc/connect-node`）をh2cでUnixソケットに。既存のソケットファイルは起動時に消す
- 起動時に`gcSessions()`、SIGTERMで全サンドボックスをDestroyしてから終了
- `ListSandboxes`（空）、`GetSandbox`（NotFound）を実装。他のRPCは`Unimplemented`
- ログは標準エラーへ1行JSON
- やらないこと: VMの起動
- 契約テスト: C-S1

## S2. イメージ

- `BuildImage`: `docker build`（context_dir/dockerfile/arch）→ タグ付け → `gondolin build --config`（`oci.image`、`runtimeDefaults.rootfsMode: cow`）→ build_idを`$XDG_DATA_HOME/masuda-sandbox/images.json`に名前・arch・OCI digestと共に記録。ログ行をストリーム
- `ListImages`
- アーキテクチャ既定はホスト。macOSではpostBuildを使わないので`container`は不要
- 契約テスト: C-S2

## S3. VMの生成とExec

- `CreateSandbox`: `VM.create({sandbox: {imagePath}, memory, cpus, env, dns: {mode: synthetic, syntheticHostMapping: per-host}, tcp, httpHooks, sessionLabel: id})`。idの重複は`AlreadyExists`。VMはサービスのプロセスが所有し、レジストリ（メモリ + `$XDG_DATA_HOME/masuda-sandbox/sandboxes.json`）に記録
- `Exec`: argv/shell、`user`（既定`default_user`、`runuser -u <user> -- env ...`で切替、envはすべて明示的に渡す）、cwd、stdin、pty、timeout。stdout/stderrをストリームし`Exited`で終える
- `GetSandbox`/`DestroySandbox`（冪等）
- サービス再起動後、以前のサンドボックスは`STOPPED`として`GetSandbox`に出る（VMはプロセスと共に死ぬため）
- やらないこと: 方針・秘密（S4）、ファイル（S5）
- 契約テスト: C-S3

## S4. 方針と秘密

- `CreateSandboxRequest.secrets`から、`createHttpHooks`の`secrets`を組む。プレースホルダは`makePlaceholderFunc`（prefix/lengthの指定があればそれ）で作り、`Sandbox.placeholders`で返す。サンドボックスの生涯で不変
- `isRequestAllowed`はサンドボックスごとの可変な`Policy`を参照する。`enabled_secrets`に無い秘密のプレースホルダを含むリクエストは拒否（`secret-not-enabled`）
- `SUBSTITUTE_IN_BODY`の秘密は、自前の`onRequest`でボディ内のプレースホルダも置換する（`request.clone().text()`で読み、置換して新しい`Request`を返す）。ヘッダは既定の置換に任せる
- `SetPolicy`は次の接続から効く
- 拒否・開始・完了を内部イベントキューへ入れる（S7が配信）
- 契約テスト: C-S4

## S5. ファイル転送

- `ReadFile`: `vm.fs.stat`でシンボリックリンク・ディレクトリ・サイズ上限を弾き、`readFileStream`でストリーム
- `WriteFile`: 親ディレクトリ作成、一時ファイルへ書いてから`mv`で置換（既存のシンボリックリンクは置き換える）、mode・ownerを`chmod`/`chown`
- 契約テスト: C-S5

## S6. tcp_mapsとSSH

- `tcp_maps`を`tcp.hosts`へ。upstreamはループバック以外を拒否
- `EnableSsh`: `vm.enableSsh({user})`。秘密鍵PEMを返し、`ssh_argv`も組む。`DisableSsh`
- 契約テスト: C-S6

## S7. 観測

- `WatchEvents`: seq付き、サンドボックスごとに直近1000件のリングバッファで`after_seq`の再送、以後はライブ
- `Sandbox.last_http_activity`・`inflight_http_requests`
- `StateChanged`（STARTING→RUNNING、RUNNING→STOPPED/FAILED）。QEMUプロセスの異常終了を検知してFAILEDにする
- 契約テスト: C-S7

## S8. SSH egress

- `ssh_egress`を`ssh`オプションへ。`execPolicy`で`getInfoFromSshExecRequest`を使い、`git-receive-pack`は`push_allowed_refs`に合う場合だけ許す（refはコマンドからは取れないので、pushの可否はホスト単位で判定し、ref制限はmasuda側のpublishで二重に守る。この制約はHANDOFFに記録する）
- 契約テスト: C-S8（`SSH_AUTH_SOCK`と到達可能なgitホストが要るので、環境が無ければskip）

## S9. 硬化

- `BuildImage`の冪等化: `docker build`の結果の`oci_digest`が`images.json`の既存エントリと同じで、その資産ディレクトリが実在するなら、`gondolin build`を省いて既存の`Image`を返す。契約テストを回すたびに約390MBの資産が増えるのを止める（S3時点で確認）
- 1サンドボックスあたりのExec同時数の上限、`ReadFile`既定64MiB、イベントバッファ上限
- サービスのメトリクス（サンドボックス数、QEMUのRSS）を`ListSandboxes`に載せない。別途ログへ
- macOSでの動作確認はM5で行う。ここではLinux

## S10. 実機1周で見つかった不足（M8の結果）

- **`disk_mib`**（契約に追加済み）: `CreateSandboxRequest.disk_mib`をGondolinの`rootfs.size`に渡す。イメージに`resize2fs`が無ければ`FailedPrecondition`で理由を返す。0なら従来どおり。実機では「中身+20%+64MiB」の既定だとGo入りイメージで空きが約200MBしかなく、`go test`が`No space left on device`になった
- **Execの既定の環境変数**: `HOME`は実行ユーザーのホーム（`getent passwd`）、`XDG_CACHE_HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`は`$HOME/.cache`等（root所有の`/tmp/.cache`を非rootが書けなかった）、`PATH`に`/usr/local/bin`と`$HOME/.local/bin`を含める、Dockerイメージの`ENV`（`docker image inspect`の`Config.Env`）をExecの既定環境に引き継ぐ。リクエストの`env`はこれらを上書きする
- **読み取り専用ディレクトリを含むイメージのビルド失敗**: Dockerfileで非rootの`go mod download`を実行したイメージを`BuildImage`すると、`gondolin build`が`EACCES /tmp/gondolin-build-XXXX`で失敗し一時ディレクトリが残る。原因を切り分け、sandbox側で直せる（例: 失敗時の一時ディレクトリを`chmod -R u+w`してから消す、OCIのexport後に権限を補正する）なら直す。Gondolin側の不具合ならupstreamへのIssueの下書きをHANDOFFに書く
- 契約テスト: C-S1〜C-S7が緑のまま。`disk_mib`の確認は手動（`df -h /`で増えること）でよく、HANDOFFに結果を書く

## S11. 応答無しで終わったHTTPリクエストの終端イベント（契約に明記済み）

- `HttpRequestStarted`を出したリクエストは、応答が無く終わった場合（クライアントが接続を閉じた、上流が失敗した、中断された）も必ず`HttpRequestFinished`（`status: 0`）を出す。masudaの活動判定が「進行中」に張り付かないため（M8の実機で、応答前に切られたPOST /v1/messagesが未完了のまま残り、入力待ちが表示されなかった）
- `inflight_http_requests`もこれで減らす。S4の「10分で捨てる」規則はこの上で保険として残す
- 契約テスト: C-S1〜C-S7が緑のまま。単体テストで確認

## S12. レスポンスのストリーミングを取り戻す（S11の発見。優先度高）

- サービスが常に`onResponse`を渡しているため、Gondolinは**応答を全部バッファしてからゲストへ送る**。Claude APIのSSE（`/v1/messages`）もストリーミングにならず、ゲストのClaude Codeは応答の最後まで何も受け取らない。長い応答ではGondolinの応答サイズ上限に当たる恐れもある
- `onResponse`を渡すのをやめる。ステータスと完了時刻は、S11の`netwatch`でホスト→ゲストへ送られる最初のバイト列（`HTTP/1.1 200 ...`のステータス行）を読んで得る。完了は接続のクローズ（S11のとおり）。`HttpRequestFinished.status`はこれで埋める
- 確認: 実機で`curl -N https://httpbin.org/stream/20`（または`/drip`）を流し、ゲスト側で最初の行が応答完了を待たずに届くこと（`curl -w '%{time_starttransfer}'`が全体時間より十分短い）。契約テストC-S1〜C-S7は緑のまま、`pnpm test`も緑
- **PATHの約束**（契約を直した）: 既定環境のPATHに、イメージのENVがPATHを持っていても必ず`$HOME/.local/bin`を先頭に足す（native Claude Codeの置き場所。公式ubuntuイメージはENVでPATHを持つので、S10の実装だと隠れる）

## S13. 配布（v0.1.0に向けて）

- **`GetServerInfo`**（契約に追加済み）: `version`（ビルド時に埋める。タグ`vX.Y.Z`の`X.Y.Z`、無ければ`dev`）、`contract`/`contract_sha256`（ビルド時に`sandbox.proto`のSHA-256を埋める）、`gondolin_version`（`package.json`から）、`platform`
- **配布物はtarball**（npm公開はv1.0以降）: esbuildで`dist/`を1ファイルに束ね（Gondolinとその依存は束ねず`dependencies`に残す。krun runnerはoptional）、`npm pack`で`masuda-sandbox-X.Y.Z.tgz`を作る。利用者は`npm install -g <tgz のURL>`で入れる。`README.md`に手順
- **GitHub Actions `release.yml`**: タグ`v*`のpushで、`pnpm install`→`pnpm build`→単体テスト→tarball→GitHub Releaseに添付（`softprops/action-gh-release`等）、SHA-256のチェックサムも添付。契約テストはKVMが要るのでCIでは回さない（手元で回したことをリリース手順で確認する）
- **CI `ci.yml`**: `main`/`develop`へのpushとPRで、`pnpm install`→`pnpm build`→`pnpm test`（単体のみ）
- `masuda-sandbox --version`
- 契約テスト: C-S1〜C-S7が緑のまま。`GetServerInfo`の単体テスト

## S15. ホストのスリープ後にゲストの時計を合わせる

- 実測（2026-10-02）: WindowsをスリープしてもQEMU（Gondolin）のVMは生き残るが、ゲストの時計はスリープした時間だけ遅れたまま進む（kvm-clockの再同期がかからない）。約10分のスリープで約10分の遅れ
- 影響: ゲスト内のコミット日時・ログの時刻がずれる。長時間のスリープではTLS検証やAPIの時刻判定が狂いうる。masudaはWIPスナップショットの「最新」をコミット日時で選ぶ
- 対処: Gondolinにゲストエージェントが無いので`Exec`で合わせる。(a) 各`Exec`の前に、ホスト時刻とゲストの`date +%s`の差が閾値（例30秒）を超えていれば`date -s @<host epoch>`をrootで打つ（コストは1 Exec分）。または(b) サービスがホストの時刻の跳び（`setInterval`の実測間隔が大きくずれた）を検知したときだけ全サンドボックスで合わせる。(b)を基本に(a)を保険にするのが妥当
- 契約は変えない。単体テストと、実機で`date -s`が効くことの確認

## S16. 使い捨てVMのジョブ（RunJob）とDeleteImage（契約に追加済み。v0.3.0）

- 背景: Issue #10（masudaの特権コマンドの仕組みをsandboxへ移す）と#5（契約テストがサービスの外から資産ストアを書き換える）
- **`RunJob`**: 1回の呼び出しで、使い捨てVMの作成→inputs（`HostFile`・`FromSandbox`）の投入→`setup_shell`→`shell`→outputsの回収→破棄。VMは成否・キャンセル・全体の期限切れのどれでも壊す。秘密・tcp_maps・sshは持たない。拒否した通信はVMの起動直後から購読し、`denied`で流して`Finished.denied_hosts`に集計する。VMのidは`job-<uuid>`で、`sandboxes.json`には書かない
- 段取りは`src/jobs.ts`（`JobEnv`を受け取る`runJob`/`streamJob`）。VMを使わない単体テスト（`test/unit/jobs.test.ts`）で順序・前処理の失敗・失敗/キャンセル/期限切れでの破棄・outputsの一部回収を確かめる
- globはmasudaの`internal/privileged/glob.go`と同じ意味（`src/glob.ts`、`test/unit/glob.test.ts`）
- **`DeleteImage`**: images.jsonの記録・Gondolinの資産・BuildImageが作ったDockerのイメージを消す。使っているsandboxがあれば`FailedPrecondition`、記録の無いbuild_idは何もしない。契約テストC-S2の後片付けをこれに切り替えた
- **CLI `masuda-sandbox run`**: ソケット経由で`RunJob`を呼ぶ。終了コードはコマンドのもの（ほかの割り当ては`masuda-sandbox run`の使い方を参照）
- 契約テスト: C-S16（ホストのファイルの投入→加工→回収、0以外の終了と`timeout_ms`、許可していないホストの拒否、前処理の失敗、`FromSandbox`、キャンセルでVMが残らないこと、`DeleteImage`）。C-S1〜C-S7は緑のまま

## 契約テストの対応表

| テスト | 項目 |
|---|---|
| C-S1 | S1 |
| C-S2 | S2 |
| C-S3 | S3 |
| C-S4 | S4 |
| C-S5 | S5 |
| C-S6 | S6 |
| C-S7 | S7 |
| C-S8 | S8 |
| C-S16 | S16 |
