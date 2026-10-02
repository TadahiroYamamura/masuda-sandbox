# HANDOFF
## 作業項目
S11（応答無しで終わったHTTPリクエストの終端イベント）完了。実装コミット`9352400`。S8（SSH egress）は指示により手を付けていない。
- **検知の経路**: Gondolinのネットワークバックエンド（`vm.server.network`、`QemuNetworkBackend`、非公開）の`handleTcpConnect`・`handleTcpSend`・`handleTcpClose`・`abortTcpSession`をインスタンス上で包む（`src/netwatch.ts`の`watchConnections`、`bootVm`で`VM.create`直後・`start()`前に呼ぶ）。`handleTcpSend`の処理を`AsyncLocalStorage`の文脈（ゲストのTCP接続ごとのオブジェクト）で走らせ、`onRequest`/`onResponse`はそこから自分の接続を知る（`src/egress.ts`の`GuestConnections`）。TLS（MITM）でも文脈が`onRequest`まで伝わることを実機で確認した（TLSSocketが最初の`handleTcpSend`の中で作られるため）
- **終わらせ方**（`Egress`）: 接続ごとに「応答待ちのhop」を1つ持つ
  - `onResponse` → そのhopを実ステータスで終える
  - 接続が閉じた（ゲストが切った・Gondolinが502を返して閉じた・abort）→ 応答待ちのhopを`status: 0`で終える
  - 同じ接続で次の`onRequest`が来た → Gondolinがリダイレクトを追っている（3xxはフックに来ない）ので前のhopを`status: 0`で終える
  - 切断後にGondolinが呼ぶ`onResponse`は無視（既に終えたので二重に出さない）。切断後のリダイレクト追従は`HttpRequestBlockedError("guest closed the connection")`で止める（イベントは出さない）
  - 同じキーで接続が再度開いたら古い接続を閉じた扱いにする
  - 接続の文脈が無いとき（バックエンドを包めなかったとき）は従来どおりメソッド+URLのFIFOで対応付け
- `inflight_http_requests`は開始済み・未終了（`open`）の数。10分の規則は保険として残した
- バックエンドの形が違えば（Gondolinの更新でメソッド名が変わった等）`watchConnections`は`warn`ログを出して`false`を返し、S10までの挙動に戻る
### 調べた候補と結論（gondolin 0.12.0、`dist/src/qemu/http.js`・`net.js`）
- `onResponse`が呼ばれない経路: 上流のfetch失敗（接続・TLS）、fetch前の失敗（DNS解決失敗は`ensureIpAllowed`で投げる）、`onRequest`後の`isRequestAllowed`拒否や秘密の置換での拒否、応答本文の上限超過・読み取り失敗、リダイレクトの途中hop。いずれもGondolinが自分で502等を返して接続を閉じる
- **ゲストが切った場合は`onResponse`が後から来る**: `handleTcpClose`は`session.http.closed=true`にするだけで上流のfetchを止めない。`curl -m 1 https://httpbin.org/delay/10`で、S11前は約10.7秒後に`status: 200`の`httpFinished`が出ていた（上流が終わらなければ10分の規則まで残る）
- `request.signal`: `onRequest`に渡るRequestは`new Request(url, {...})`でsignal無し。使えない
- `fetch`オプションの差し替え: 差し替えるとGondolinは内部IP遮断（`blockInternalRanges`）用のdispatcherを渡さなくなる。しかもゲストの切断ではfetchは中断されないので切断は検知できない。不採用
- `debug: ["net"]`のログ: `http bridge fetch failed METHOD URL`は出るが、DNS失敗・上限超過・本文の失敗はURL無しかログ無し、ゲストの切断はログ無し。不採用
- 結論として、ゲストの切断を知る手段はバックエンドの非公開メソッドしかなかった
### 手動確認（scratchpadのスクリプト、リポジトリには残していない）
許可ホストに`httpbin.org`等を入れたサンドボックス（contract:test `b6839a0d-...`）でExecし、`WatchEvents`を見た。
- `curl -sS -m 1 https://httpbin.org/delay/10` → `httpStarted{requestId:1, GET httpbin.org /delay/10}`の約1秒後に`httpFinished{requestId:1, status:0, durationMs:981}`。直後の`GetSandbox`で`inflightHttpRequests: 0`。10秒後に上流の応答が来ても2つ目の`httpFinished`は出ない
- `http://`（平文）の同じ`curl -m 1` → `status:0, durationMs:1000`
- `https://nonexistent.invalid/`（DNS失敗、ゲストは502）→ `status:0, durationMs:47`
- `https://expired.badssl.com/`（上流のTLS失敗、ゲストは502）→ `status:0, durationMs:638`
- `curl -L https://httpbin.org/redirect/2` → `/redirect/2`と`/relative-redirect/1`が`status:0`、`/get`が`status:200`
- `http://httpbin.org/status/418` → `status:418`（通常経路は従来どおり）
- 全ケースの後で`inflightHttpRequests: 0`
## 完了した契約テスト
C-S1〜C-S7すべて緑（S8は未着手）。`node dist/cli.js serve --socket $XDG_RUNTIME_DIR/masuda-sandbox-s11.sock`に対し`pnpm test:contract`を2回連続で7 passed（約27秒・約28秒）。`pnpm test`は50 passed（`test/unit/egress.test.ts`に終端8件、`test/unit/netwatch.test.ts`新規2件）
## 未完と理由
- なし（S11の範囲）。S8は範囲外（指示により後回し）
## 次の一手
1. masuda側: `serve/activity.go`の`inflightStale`（2分の打ち切り）は不要になる。残しても害は無い
2. **気づいたこと（S11の範囲外、未対応）**: Gondolinは`httpHooks.onResponse`があると応答を**ストリームせず全部バッファしてから**ゲストへ返す（`http.js`の`canStream = Boolean(responseBodyStream) && !backend.options.httpHooks?.onResponse`）。このサービスは`httpFinished`のために常に`onResponse`を渡しているので、`POST /v1/messages`のSSEも最後まで溜めてから一度に届く。M8で「応答前に切られた」のは、クライアントが最初のバイトを待ちきれずに切った可能性がある。`onResponse`をやめて終了を接続の終わり（今回の`GuestConnections`）とnetのdebugログ`http bridge response <status>`で取る形にすればストリームが戻るはず。監督の判断で作業項目にしてほしい
3. `docs/work-orders.md`のS8（SSH egress）
## 注意点
- `src/netwatch.ts`はGondolinの非公開メソッドに依存する。Gondolinを上げたら`curl -m 1`の手動確認をやり直す。起動ログに`gondolin network backend not recognized`が出たら壊れている
- リダイレクトの途中hopの`httpFinished`は`status: 0`（3xxのコードはフックに来ないので分からない）
- `duration_ms`は`onRequest`（このサービスが`httpStarted`を出した時点）から終わりを検知した時点まで。ゲストが切った場合はゲストのTCP切断がGondolinに届いた時点
- `pkill -f`で止めない。`pgrep -f '^node dist/cli.js'`でPIDを取ってkill。`dist/`を作り直したらサービス再起動
- 残したもの: QEMUなし（親セッションのPID 12244以外）。サービスは停止済み。`sandboxes.json`は空。Dockerイメージは作っていない。Gondolin資産は増やしていない（既存のもの）。`/tmp`に`gondolin-build-*`・`masuda-sandbox-build-*`なし
## 契約への提案
- `HttpRequestFinished.status`のコメントに「Gondolinが追ったリダイレクトの途中hopも0」と足すかを監督が判断してほしい（今のコメントの例示には無いが、ゲストに応答が届かないhopという意味では同じ）
- `ExecRequest.env`のコメントは「PATHが`$HOME/.local/bin`を含む」と読めるが、S10の実装ではイメージのENVが`PATH`を持つと（Docker公式のubuntu等は必ず持つ）`$HOME/.local/bin`は入らない（S10のHANDOFFの注意点のとおり）。コメントか実装のどちらに合わせるか判断してほしい
