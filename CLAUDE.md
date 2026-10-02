# masuda-sandbox

masudaのサンドボックスサービス。TypeScript。[Gondolin](https://github.com/earendil-works/gondolin)（`@earendil-works/gondolin`）を包み、`proto/masuda/sandbox/v1/sandbox.proto`のConnect APIをUnixソケットで提供する常駐プロセス。全体像は[masudaリポジトリの`docs/design/overview.md`](../masuda/docs/design/overview.md)。

## 開発

- Node 22.19以上、pnpm。`pnpm install && pnpm build && pnpm test`
- protoからの生成: `buf generate`（`src/gen/`、コミットする）
- 契約テスト: `pnpm test:contract`。実VM（QEMU + KVM）で動く。`MASUDA_SANDBOX_SOCKET`が指すサービスを叩く。これが緑なら作業項目は完了
- サービスの起動: `pnpm start -- serve --socket $XDG_RUNTIME_DIR/masuda-sandbox.sock`
- QEMUは`sudo apt install qemu-system-x86 qemu-utils lz4`（Linux）。sudoが要る作業はユーザーに頼む
- イメージビルドにはDocker

## Gondolinの扱いで分かっていること（スパイク済み）

- SSHフォワーダもHTTP中継も同じNodeプロセス内で動く。**同期的に子プロセスを待たない**（`execFileSync`で詰まった実績あり）。すべて非同期
- 制御プロセスが死ぬとQEMUが孤児で残る。起動時に`gcSessions()`を呼び、自分のセッションだけを掃除する
- `/etc/gondolin/mitm/ca.crt`はFUSE配下で非rootから読めない。システムCAバンドルは`update-ca-certificates`で更新されるので動く。非rootでも読める写しを置くのはイメージ側の仕事（masudaが用意するDockerfile）
- `httpHooks.isRequestAllowed`は呼び出しごとに評価されるので、可変な集合を参照すれば実行中に方針を切り替えられる
- `tcp.hosts`は`dns.mode: synthetic` + `syntheticHostMapping: per-host`が要る
- 検証に使ったスクリプトはmasudaリポジトリの`docs/research/spike-gondolin/`にある

## GitHub操作

`gh`を直接使わず`scripts/gh.sh`を使う（`.env`のトークンを渡すラッパー。`.env`はClaudeから読めない）。

## 契約の扱い

- `proto/masuda/sandbox/v1/sandbox.proto`は契約。**変えない**。変えたくなったら`HANDOFF.md`の「契約への提案」に書いて止まる
- 内部構造は自由。Gondolinの型を契約の外へ漏らさない

## 作業の進め方

- 作業単位は`docs/work-orders.md`の1項目。1項目を1セッションで終える
- セッション開始時: `HANDOFF.md`→`docs/work-orders.md`の該当項目→`sandbox.proto`の順に読む
- Gondolinのソース・docsの調査はサブエージェントに出す。`node_modules/@earendil-works/gondolin/`に全部ある
- 実VMのテストはQEMUプロセスを残しやすい。テスト後に`pgrep qemu-system`で確認する
- コミットはユーザーの承認を得てから。メッセージは`<type>(<scope>): <summary>`に`## 意図`・`## 設計上の考慮点`・（あれば）`## 懸念事項`。ADRは書かない

## HANDOFF.md

セッション終了時に、次の見出しで**上書き**する（スキルは使わない。読むのはエージェント）。

```
# HANDOFF
## 作業項目
## 完了した契約テスト
## 未完と理由
## 次の一手
## 注意点
## 契約への提案
```

## コメント

コードのコメントは、10行以上の要約、他の選択肢がある中での選択理由、コードから読めない背景、トレードオフ、のいずれかを満たすものだけ書く。
