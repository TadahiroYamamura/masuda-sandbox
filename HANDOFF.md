# HANDOFF
## 作業項目
S3（VMの生成とExec）完了。
- `src/sandboxes.ts`: `SandboxRegistry`。メモリ + `$XDG_DATA_HOME/masuda-sandbox/sandboxes.json`（秘密は名前だけ。値はメモリの`Entry.secrets`に`SecretDecl`のまま保持）。`load()`で記録をすべて`STOPPED`として復元。`create`（STARTING→RUNNING。生きている同idは`AlreadyExists`、STOPPED/FAILEDの同idは置き換え。起動失敗はエントリを消して例外）、`destroy`（冪等。エントリと記録を消し、起動中なら`ready`を待ってから`vm.close()`）、`running(id)`（NotFound / FailedPrecondition）、`shutdown()`（SIGTERM時。VMを閉じるが記録は残す）
- `src/vm.ts`: `bootVm`。`VM.create({sandbox:{imagePath}, memory:"<MiB>M", cpus, env, dns:{synthetic, per-host}, sessionLabel:id})`→`vm.start()`。Gondolinの型は`GuestVm = Pick<VM, "exec"|"close"|"getHostPid">`までに絞っている
- `src/exec.ts`: `guestArgv`（純関数、`test/unit/exec.test.ts`で単体テスト）と`runExec`（Started→stdout/stderr→Exited）
- `src/datafile.ts`: `dataDir`とJSONの原子的書き込み。`images.ts`もこれを使うように変更
- `src/service.ts`: `createSandbox`（images.jsonでbuild_idを確認→`getImageObjectDirectory(buildId)`が実在するか確認）、`destroySandbox`、`exec`
- 既定値: memory 4096MiB、cpus 4。`default_user`は必須（空はInvalidArgument）
## 完了した契約テスト
C-S1・C-S2・C-S3。`node dist/cli.js -- serve --socket $XDG_RUNTIME_DIR/masuda-sandbox-s3.sock`を起動し、`MASUDA_SANDBOX_SOCKET=$XDG_RUNTIME_DIR/masuda-sandbox-s3.sock pnpm test:contract`で3 passed / 4 failed（C-S4は placeholders 未実装、C-S5はWriteFile Unimplemented、C-S6はtcp_maps未配線で502、C-S7はWatchEvents未実装。いずれも想定どおり）。C-S3は約6秒。`pnpm test`（単体）も5 passed
手動で確認したこと: サービス再起動後に`STOPPED`で見える／同idの再Createで置き換わる／SIGTERMでVMが閉じる（QEMUが残らない）／stdin・pty（`\r\n`のまとまった出力がstdoutに来る）／timeoutでバックグラウンドの孫まで殺される
## 未完と理由
- S4以降は範囲外。`tcp_maps`・`secrets`・`policy`・`ssh_egress`は保存のみ
- 実行中のVMの異常終了を検知して`FAILED`にする仕組みは無い（Gondolinに状態の公開APIが無い。S7の状態イベントと一緒に考える）
- クライアントがExecのストリームを途中で切っても、timeout未指定ならゲスト側のプロセスは走り続ける（Gondolinにexecを止めるメッセージが無い。abortはホスト側で見捨てるだけ）
## 次の一手
`docs/work-orders.md`のS4（方針と秘密）。`createHttpHooks`の結果を`bootVm`に渡す（`httpHooks`とプレースホルダの`env`）。`Entry.secrets`に値があり、`snapshot()`の`placeholders`は今は空
## 注意点
- 今は`httpHooks`を渡していないので、ゲストの外向きHTTPは制限されていない。S4で`isRequestAllowed`を可変な集合に向ける
- Execの組み立て: `/bin/sh -c 'exec "$@"' masuda-exec [timeout [--foreground] -s KILL <秒>] [runuser -u <user> --] env K=V... <cmd>`。sandbox作成時のenvとリクエストのenvをマージして**常に**`env`で明示的に渡す（rootも同じ経路、runuserだけ挟まない）。プレースホルダ用のenvもここに足せば非rootユーザーへ届く。VM.createの`env`にも同じものを渡している
- timeoutは`-s KILL`。`-k`付きTERMでは、runuserがTERMで先に終わり、TERMを無視する孫がstdout/stderrのパイプを掴んだままexecが終わらなかった（Gondolinはパイプが閉じるまでExitedを返さない）。timed_outは「期限経過 かつ exit 137/124/SIGKILL」で判定。ホスト側にも期限+10秒の保険（exit_code -1・timed_out true）
- ゲストのPID 1はゾンビを刈らない（殺した`sleep`が`<defunct>`で残る）。実害は今のところ無い
- 契約テストは毎回C-S2でイメージを作るので、Gondolin資産が約390MBずつ溜まる（このセッションで`edffe672-...`・`f213e2e2-...`が増えた。images.jsonに記録済み）
- サービスの停止は`pkill -TERM -f '^node dist/cli.js -- serve'`（`pnpm start`経由でなく`node dist/cli.js -- serve`で起動した場合）
- 無関係なQEMU（PID 12244）とGondolin資産`3cd7a864...`・`c4dc6a9f...`は親セッションのもの。触っていない
- 残したもの: QEMUなし（12244以外）。dockerタグ`masuda-sandbox/image:x86_64-3f14a23ce3f7d022`（S2から継続）。`sandboxes.json`は空
## 契約への提案
なし
