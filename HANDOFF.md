# HANDOFF
## 作業項目
S12（レスポンスのストリーミングを取り戻す＋PATHの約束）完了。実装コミット`42cfd28`。S8（SSH egress）は指示により手を付けていない。
- **ストリーミング**: `createHttpHooks`に`onResponse`を渡すのをやめた（`Egress.httpHooks.onResponse`は`undefined`）。Gondolinは`canStream = Boolean(body) && !httpHooks.onResponse`で応答をストリームする
- **statusの読み方**（`src/netwatch.ts`の`watchResponses`、`src/egress.ts`の`GuestConnections`）: ゲストへ書かれる**平文**の応答ヘッドのステータス行を読む
  - 平文HTTP: Gondolinは`backend.stack.handleTcpData({key,data})`へ直接書く。このメソッドをstackインスタンス上で包み、`tcpSessions.get(key).protocol === "http"`のときだけ読む（TLSの暗号文も同じ口を通るため）。stackは`resetStack()`で作り直されるので、`handleTcpConnect`のたびに現在のstackを未包装なら包む（WeakSet）
  - HTTPS（MITM）: Gondolinは平文を`session.tls.socket.write(chunk)`（サーバー側`tls.TLSSocket`）へ書く。`ensureTlsSession`を包み、作られた直後のTLSSocketの`write`をインスタンス上で包む。書き込み先は作成時点の接続オブジェクトに束縛（`GuestConnections.sink`）し、キーが再利用されても遅れた書き込みを新しい接続のものと取り違えない
  - **上流の応答かどうかの判定**: バイト列だけでは上流の502と、上流fetch失敗時にGondolinが自分で書く`respondWithError`の502を区別できない（S11の契約では後者は0）。Gondolinが最終応答を得たときに出すnetのdebugログ`http bridge response <status> ...`（リダイレクトのhopでは出ない）を`Egress.onDebug`で受け、接続のAsyncLocalStorage文脈（S11）からそのhopに「上流が応答した」印を付ける。印の後に書かれた最初の最終応答ヘッド（1xxは読み飛ばす）のステータスを採る。印が無いhopは0
  - 完了はS11どおり接続のクローズ（`handleTcpClose`/`abortTcpSession`）で、`duration_ms`もそこで確定。次のhopの`onRequest`（リダイレクト）では前のhopを0で終える（従来どおり）
  - 劣化: `tcpSessions`/`ensureTlsSession`/`stack.handleTcpData`が無ければ警告して、接続のクローズで`status: 0`。接続追跡の4メソッドごと無ければ（`watchConnections`が`false`）、`vm.ts`が`Egress.useResponseHook()`で`onResponse`を付け直してS11前のメソッド+URLの対応付けに戻す（この場合はストリームしない）。「ステータス不明で0」に落とせるのは接続追跡が生きているときだけで、それも無いと終わりを知る手段が`onResponse`しか無いため
- **PATH**: `execBaseEnv`で、サービス既定・イメージENV・CreateSandbox.envを重ねた結果のPATHの先頭に`$HOME/.local/bin`を足す（既に先頭なら足さない、空なら`$HOME/.local/bin`だけ、HOME不明なら足さない）。Exec.envのPATHは従来どおりそのまま上書き（契約の「Overrides, applied last」）
### 実機確認（scratchpadのスクリプト、リポジトリには残していない）
許可ホストに`httpbin.org`等を入れたサンドボックス（contract:test）でExecし、`WatchEvents`を見た。
- `curl -sN -w '\nstarttransfer=%{time_starttransfer} total=%{time_total}\n' 'https://httpbin.org/drip?duration=5&numbytes=5'` → `starttransfer=0.848607 total=4.848824`。`*`が約1秒おきに1つずつExecのstdoutに届いた。`httpFinished{status:200, durationMs:4829}`は最後のバイトの後
- `curl -sN https://httpbin.org/stream/3` も逐次届く
- `curl -sS -m 1 https://httpbin.org/delay/10` → curl rc=28、`httpFinished{status:0, durationMs:985}`。上流の応答後も2つ目は出ない
- `https://httpbin.org/status/418` → 418、`http://httpbin.org/status/418`（平文）→ 418
- `curl -L https://httpbin.org/redirect/2` → `/redirect/2`と`/relative-redirect/1`が`status:0`、`/get`が`status:200`
- `https://nonexistent.invalid/`（ゲストは502）→ `status:0`、`https://expired.badssl.com/`（ゲストは502）→ `status:0`
- すべての後で`inflightHttpRequests: 0`。ゲストの`echo $PATH`（ubuntu）→ `/home/ubuntu/.local/bin:/usr/local/sbin:...`
## 完了した契約テスト
C-S1〜C-S7すべて緑（S8は未着手）。`node dist/cli.js serve --socket $XDG_RUNTIME_DIR/masuda-sandbox-s12.sock`に対し`pnpm test:contract`を2回（手動確認の前後）、いずれも7 passed（約30秒・約26秒）。`pnpm test`は55 passed（egress 16件、netwatch 4件、exec 12件ほか）
## 未完と理由
- なし（S12の範囲）。S8は範囲外（指示により後回し）
## 次の一手
1. masuda側でM8相当（Claude Codeの`POST /v1/messages`のSSE）を再確認する。S11で疑った「最初のバイトを待ちきれず切った」はこれで解消しているはず
2. masuda側: `serve/activity.go`の`inflightStale`（2分の打ち切り）は不要（S11から変わらず）
3. `docs/work-orders.md`のS8（SSH egress）
## 注意点
- `src/netwatch.ts`はGondolin 0.12.0の非公開メソッド（`handleTcpConnect`・`handleTcpSend`・`handleTcpClose`・`abortTcpSession`・`ensureTlsSession`・`tcpSessions`・`stack.handleTcpData`）とnetのdebugログ文言`http bridge response `に依存する。Gondolinを上げたら上の手動確認（特に/drip・/status/418・`-m 1`）をやり直す。起動ログに`gondolin network backend not recognized`／`gondolin network stack not recognized`が出たら壊れている。debugログ文言だけ変わった場合は警告が出ず全statusが0になる
- `vm.ts`の`debug: ["net"]`は今やstatusの判定にも必要。外さない
- `onResponse`はもう渡していないので、応答本文はGondolinの`maxHttpResponseBodyBytes`上限にもかからない（ストリーム経路は上限を見ない）
- `pkill -f`で止めない。`pgrep -f '^node dist/cli.js'`でPIDを取ってkill。`dist/`を作り直したらサービス再起動
- 残したもの: QEMUなし（親セッションのPID 12244以外）。サービスは停止済み。`sandboxes.json`は空。Dockerイメージは作っていない。Gondolin資産は増やしていない。`/tmp`に`gondolin-build-*`・`masuda-sandbox-build-*`なし
## 契約への提案
- なし
