# HANDOFF
## 作業項目
S1（骨組みと`serve`）完了。`src/cli.ts`（`serve --socket`）、`src/server.ts`（h2c over Unixソケット、gcSessions、SIGTERM処理）、`src/service.ts`（ListSandboxes/GetSandboxのみ）、`src/registry.ts`（空のレジストリ。`SandboxEntry`の`snapshot()`/`destroy()`を実装して登録する想定）、`src/log.ts`（標準エラーへ1行JSON）、`test/contract/client.ts`（Connectプロトコル、HTTP/2、`createConnection`でUnixソケットへ）
## 完了した契約テスト
C-S1（`pnpm start -- serve --socket $XDG_RUNTIME_DIR/masuda-sandbox-s1.sock`を起動し、`MASUDA_SANDBOX_SOCKET=$XDG_RUNTIME_DIR/masuda-sandbox-s1.sock pnpm test:contract`で1 passed / 6 failed。失敗はすべてUnimplemented）
## 未完と理由
- S2以降は範囲外
- `pnpm test`（単体テスト）はテストファイルが無いのでvitestが「No test files found」で失敗する
## 次の一手
`docs/work-orders.md`のS2（BuildImage/ListImages）
## 注意点
- `buf.gen.yaml`からconnectrpc/esプラグインを外した。Connect v2はサービス記述子を`sandbox_pb.ts`から使う。戻すとprotobuf-es v2と合わない`sandbox_connect.ts`が生成されビルドが壊れる
- pnpm 11はビルドスクリプトを既定で拒否する。`pnpm-workspace.yaml`の`allowBuilds`で@bufbuild/buf・esbuildを許可済み
- `pnpm start -- serve ...`ではpnpmが`--`をそのまま渡すので、cli.tsで先頭の`--`を読み飛ばしている。`pkill -f "dist/cli.js serve"`では一致しない（`dist/cli.js -- serve`になる）
- `gcSessions()`はGondolinのセッション登録ファイル（`~/.cache/gondolin/sessions`）を消すだけで、孤児のQEMUは殺さない。孤児QEMUの掃除が要るなら、S3で`sessionLabel`や`listSessions()`を手掛かりに自前で行う必要がある
- 起動時、既存ソケットに接続できる（別インスタンスが生きている）場合とソケット以外のファイルの場合は消さずに起動失敗する
- 作業時点で、このリポジトリと無関係なQEMU（親セッションのスパイク、`scratchpad/spike1`のアセット）が1つ動いていた。触っていない
## 契約への提案
なし
