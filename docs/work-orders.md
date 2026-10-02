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

- 1サンドボックスあたりのExec同時数の上限、`ReadFile`既定64MiB、イベントバッファ上限
- サービスのメトリクス（サンドボックス数、QEMUのRSS）を`ListSandboxes`に載せない。別途ログへ
- macOSでの動作確認はM5で行う。ここではLinux

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
