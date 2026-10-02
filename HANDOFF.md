# HANDOFF
## 作業項目
S5（ファイル転送）完了。
- `src/files.ts`: `readGuestFile`・`writeGuestFile`
  - ReadFile: Execで`stat -c "%F|%s"`（`-L`なし。`vm.fs.stat`は`stat -L`でリンクを辿るので使わない）→ 通常ファイル以外・存在しないパスはNotFound、上限（`max_bytes`、0なら64MiB）超過はResourceExhausted → `vm.fs.readFileStream`（64KiBチャンク）。読む途中で上限を超えたら（stat後に伸びた）ResourceExhausted
  - WriteFile: rootのExecで準備（ownerの存在確認→無ければInvalidArgument、対象がディレクトリならFailedPrecondition、足りない親ディレクトリを作って新しく作った分を`chown -h owner:`、同じディレクトリに`mktemp -d .masuda-write.XXXXXXXX`（root、0700））→ `vm.fs.writeFile(<tmpdir>/f, AsyncIterable)` → `chmod <mode>`・`chown -h owner:`・`mv -f -T`・`rmdir`。失敗時は一時ディレクトリを`rm -rf`
  - mode 0→0644、0o7777超はInvalidArgument。owner空→default_user。pathは絶対パスのみ（`path.posix.normalize`、`/`やNULはInvalidArgument）
- `src/service.ts`: `readFile`・`writeFile`。先頭がheaderでない、2通目以降にheaderが来たらInvalidArgument
- `src/vm.ts`: `GuestVm`に`fs`を追加
## 完了した契約テスト
C-S1〜C-S5。`node dist/cli.js -- serve --socket $XDG_RUNTIME_DIR/masuda-sandbox-s5.sock`を起動し`MASUDA_SANDBOX_SOCKET=... pnpm test:contract`で5 passed / 2 failed（C-S5は約5秒。C-S6は403 Forbidden、C-S7は`seen`が空。いずれもS6・S7未実装で想定どおり）。`pnpm test`は11 passed
手動確認（一時テストで実施し削除済み）: 40MiBのランダムデータを書いて読み戻しsha256一致（書き約2.4秒、読み約2.6秒、220チャンク）。新しい親ディレクトリ3段がubuntu:ubuntu 755、ファイルは指定どおり600。一時ディレクトリは残らない。空ファイル（dataなし）は0バイトで書ける。エラー: ディレクトリ→FailedPrecondition、存在しないowner・相対パス・headerなし→InvalidArgument
## 未完と理由
- S6以降は範囲外
## 次の一手
`docs/work-orders.md`のS6（tcp_mapsとSSH）
## 注意点
- **Gondolinのファイル操作はExecと排他**。`server-ops.js`の`waitForExecIdle`が実行中のExecがすべて終わるまで10msごとに待ち、ファイル操作中に来たExecは`execQueue`で開始を待たされる。長時間のExec（timeoutなしで終わらないもの）があるとReadFile/WriteFileは返らない（ctxのsignalで中断はできる）。masudaはclaudeをtmuxで動かすのでExecは短い想定だが、常駐Execを使う設計にするなら問題になる。避けるならファイル転送をExecのstdin/stdoutで実装し直す
- ReadFileの種別判定と読み込みは別のゲスト操作。間にシンボリックリンクへ差し替えられると辿る（読み込みはroot）。ゲストのroot専用ファイルにホストの秘密は無い（秘密の値はゲストに入らない）ので許容した
- WriteFileの一時ディレクトリは親ディレクトリ（多くはゲストユーザーが書ける）に置くので、ゲストユーザーは一時ディレクトリ自体をrenameできる。中身はroot 0700で触れない
- 親ディレクトリの途中にシンボリックリンクがあれば辿る（契約が辿らないと言っているのは最終要素だけと解釈）
- `vm.fs.*`はGondolinのsandboxd経由でrootとして動く
- S6で`tcp_maps`を配線するとき: `tcp.hosts`宛はHTTP中継を通らないので`Egress`の判定外（S4からの引き継ぎ）
- 契約テストは毎回C-S2でイメージを作る。このセッションでGondolin資産`18056cd1-...`が増えた（images.jsonに記録済み。`~/.cache/gondolin/images/objects`は計4.5G）。`b0ac34bd-...`（17:52 JST作成）はこのセッションのものではない
- 無関係なQEMU（PID 12244）とGondolin資産`3cd7a864...`・`c4dc6a9f...`は親セッションのもの。触っていない
- 残したもの: QEMUなし（12244以外）。dockerタグ`masuda-sandbox/image:x86_64-3f14a23ce3f7d022`（S2から継続）と`masuda-sandbox-test:latest`（以前から）。`sandboxes.json`は空。サービスは停止済み
## 契約への提案
なし
