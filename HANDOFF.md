# HANDOFF
## 作業項目
S6（tcp_mapsとSSH）完了。
- `src/tcpmaps.ts`: `validateTcpMaps`（hostは小文字化・末尾ドット除去、IPやワイルドカード・`:`入りは不可、port 0〜65535、upstreamは`host:port`必須（IPv6は`[::1]:p`）、ホストが`127.0.0.0/8`・`localhost`・`::1`以外ならInvalidArgument、`host`/`host:port`の重複もInvalidArgument）と`toTcpHosts`。`service.ts`の`toRecord`で検証
- `src/vm.ts`: `VM.create`に`tcp: { hosts }`（tcp_mapsが空なら渡さない）。`GuestVm`に`enableSsh`を追加
- `src/ssh.ts`: `GuestSsh`（サンドボックスごとに1つ、呼び出しは直列化）
  - enable(user): 前のアクセスを`close()` → rootのExecでユーザー存在確認（無ければInvalidArgument）、sshdを許可しているユーザーが変わるときだけ`/run/sshd.pid`のsshdを止める → `vm.enableSsh({user, listenHost:"127.0.0.1", listenPort:0})` → `identityFile`を読んで`private_key_pem`、`ssh_argv`は`access.command`と同じ引数（`-i`はGondolinが書いた`/tmp/gondolin-ssh-*/id_ed25519`）
  - disable(user): 現在のアクセスのユーザーと一致すれば`close()`。一致しない・アクセスなしは何もせず成功
  - close(): Destroy/shutdown時に`vm.close()`の前に呼ぶ。実行中のenableが後から作ったアクセスも閉じる
- `src/sandboxes.ts`: `enableSsh`/`disableSsh`（userが空ならdefault_user。DisableSshは存在しないidでNotFound、STOPPEDでも成功）
- `test/unit/tcpmaps.test.ts`を追加
- `ssh_egress`は従来どおり保存のみ（S8）
## 完了した契約テスト
C-S1〜C-S6。`node dist/cli.js serve --socket $XDG_RUNTIME_DIR/masuda-sandbox-s6.sock`を起動し`MASUDA_SANDBOX_SOCKET=... pnpm test:contract`で6 passed / 1 failed（C-S6は約5.5秒。C-S7は`expected [] to include 'httpStarted'`でS7未実装により想定どおり）。`pnpm test`は27 passed
手動確認（scratchpadのスクリプト、リポジトリには残していない）: 非ループバックupstream・ポートなしupstream・存在しないユーザーはInvalidArgument。再EnableSshで鍵が変わり、古い鍵はPermission denied、古いポートは閉じ、古い鍵ファイルは消える。古いアクセス経由の確立済みセッションは再EnableSsh後も生きて完走。ubuntu→root→ubuntuの切り替えでそれぞれログインできる。別ユーザーへのDisableSshは何もしない。DisableSsh後とDestroy後はポートが閉じ鍵ファイルも消える。Destroy後のEnable/DisableはNotFound
## 未完と理由
- S7以降は範囲外
## 次の一手
`docs/work-orders.md`のS7（観測）
## 注意点
- **GondolinのsshdはゲストPID 1（sandboxd）が回収しない**。killするとゾンビになり`kill -0`は成功し続ける。`ssh.ts`は`/proc/<pid>/stat`の状態Zを終了とみなしている。ゲスト内で子プロセスを止めて待つ処理を書くときは同じ罠がある
- Gondolinは1VMにつきSSHアクセスを1つしか持たず、2回目の`vm.enableSsh`はユーザーに関係なく前のアクセスを返す。別ユーザーを同時に有効にはできない（契約上は「同じユーザーへの再呼び出しでローテーション」のみ要求）
- `vm.enableSsh`は内部で`execFileSync("ssh-keygen")`を使う（短時間なので許容。ssh自体を同期で待つわけではない）
- アクセスを閉じても確立済みのSSHセッションは切れない（フォワーダが新規接続を止めるだけ）。ゲストのsshdも動き続け、authorized_keysには最後の鍵が残る（秘密鍵はホストのみ）
- user="root"も受け付ける。制限するなら契約側の判断
- `tcp.hosts`宛の通信はHTTP中継を通らないので`Egress`の判定外・イベントも出ない（S7でWatchEventsに出したくなっても出せない）。ゲートウェイIP直叩き（192.168.127.1）はGondolinが拒否する
- サービスを`pkill -f '...cli.js serve...'`で止めようとすると自分のbashコマンドにも一致して殺される。`pgrep -f '^node dist/cli.js serve'`でPIDを取ってkillする
- `dist/`を作り直したらサービスの再起動が必要（古いコードのまま動いていて手動確認で一度混乱した）
- 契約テストは毎回C-S2でイメージを作る。このセッションでGondolin資産`23615b4f-...`・`42e68cee-...`が増えた（images.jsonに記録済み。`~/.cache/gondolin/images/objects`は計5.6G）
- 無関係なQEMU（PID 12244）とGondolin資産`3cd7a864...`・`c4dc6a9f...`は親セッションのもの。触っていない
- 残したもの: QEMUなし（12244以外）。`/tmp/gondolin-ssh-*`なし。dockerタグ`masuda-sandbox/image:x86_64-3f14a23ce3f7d022`（S2から継続）と`masuda-sandbox-test:latest`（以前から）。`sandboxes.json`は空。サービスは停止済み
## 契約への提案
なし
