# HANDOFF
## 作業項目
S4（方針と秘密）完了。
- `src/egress.ts`: `Egress`。サンドボックス1つ分のプレースホルダ・可変な`Policy`・Gondolinへ渡す`httpHooks`を持つ
  - プレースホルダは`makePlaceholderFunc`（BASE62）。prefix/lengthの指定が片方でもあればそれ（lengthの既定40）、無ければ`masuda_secret_`+40文字。重なり・値への包含・8文字未満はInvalidArgument
  - `createHttpHooks({allowedHosts: undefined, secrets: HEADERを持つ秘密だけ, isRequestAllowed, onRequest, onResponse})`。ヘッダ置換（Basic認証内も）はGondolinの既定
  - 自前`onRequest`: 許可ホスト判定 → ヘッダ/URL/ボディに無効な秘密のプレースホルダがあれば`secret-not-enabled` → BODY秘密をボディ内で置換（latin1で往復、content-lengthを落として新しい`Request`）→ `httpStarted`を記録
  - `isRequestAllowed`: ホストだけ再判定（リダイレクトのホップやフック後の確認）
  - `setPolicy`: ポリシー差し替え + 無効な秘密はGondolinの`secretManager.updateSecret(name,{hosts: []})`で置換不能にする
  - `onDebug`: Gondolinの"net"デバッグログから`tcp|udp blocked ... -> <ip:port>`を拾い`protocol`で記録（同じ宛先は5秒で重複除去）
- `src/events.ts`: `EventQueue`（seq付き、直近1000件、`after(seq)`）。S7の配信はここから読む
- `src/sandboxes.ts`: `Entry`に`egress`と`events`。`create`でEgressを作ってから起動。`setPolicy`（存在しなければNotFound、STOPPED復元分は名前だけで検証して記録を更新）。`running()`が`env`（record.env + プレースホルダ）を返し、Execはこれを使う。`snapshot`がplaceholdersを返す
- `src/vm.ts`: `bootVm(rec, imageDir, env, {httpHooks, onDebug})`。`sandbox.debug: ["net"]`と`debugLog`
- `src/service.ts`: `setPolicy`
- 単体テスト`test/unit/egress.test.ts`（VMなしでフックを直接呼ぶ。6件）
## 完了した契約テスト
C-S1・C-S2・C-S3・C-S4。`node dist/cli.js -- serve --socket $XDG_RUNTIME_DIR/masuda-sandbox-s4.sock`を起動し`MASUDA_SANDBOX_SOCKET=... pnpm test:contract`で4 passed / 3 failed（C-S4は約7秒。C-S5はWriteFile未実装、C-S6はtcp_maps未配線で今は403（空のpolicyで拒否されるため。S3時点は502）、C-S7はWatchEvents未実装。いずれも想定どおり）。`pnpm test`は11 passed
手動確認: 実VMで`httpStarted`/`httpFinished`（status・duration付き）/`httpDenied host-not-allowed`/`protocol`（ssh宛の22番、UDP 123番）がキューに入ること
## 未完と理由
- S5以降は範囲外
- 未知プロトコル（例: 25番へ平文）とCONNECTの拒否はイベントにならない。Gondolinは`network-stack`の内部イベント`tcp-deny`にしか出さず、公開APIから届かない
- `last_http_activity`・`inflight_http_requests`はS7（work-ordersでS7の項目）
## 次の一手
`docs/work-orders.md`のS5（ファイル転送）
## 注意点
- 自前の`onRequest`があるとGondolinは`isRequestAllowed`をフック適用**後**に呼ぶ（`ON_REQUEST_EARLY_POLICY_SAFE`がfalseになる）。プレースホルダの検査は`onRequest`でしかできない
- Gondolinは`onRequest`をリダイレクトの各ホップで呼ぶが、`onResponse`は最終ホップで1回だけ。`httpFinished`はmethod+URLのFIFOで対応付け、来なかったものは10分で忘れる
- 秘密が1つでもあると、ボディ付きリクエストは全体を読んでから中継する
- 有効な秘密でも、そのSecretDecl.hostsに合わない宛先へプレースホルダを置換位置（HEADER秘密ならヘッダ、BODY秘密ならボディ）で送ると`secret-not-enabled`で拒否。置換位置でない場所（HEADERだけの秘密がボディにある等）はプレースホルダのまま通す
- `CreateSandboxRequest.env`と秘密名が衝突するとInvalidArgument
- `sandbox.debug: ["net"]`はパケットごとにデバッグ文字列を作る。性能が問題になったら外す（`protocol`イベントを失う）
- S6で`tcp_maps`を配線するとき: `tcp.hosts`宛はHTTP中継を通らないので`Egress`の判定外。C-S6の`curl http://masuda.internal:<port>`が今403なのは、tcp.hostsが無くHTTP中継に入って許可ホストに無いため
- 契約テストは毎回C-S2でイメージを作る。このセッションでGondolin資産`c279c701-...`が増えた（images.jsonに記録済み。`~/.cache/gondolin/images/objects`は計3.7G）
- 無関係なQEMU（PID 12244）とGondolin資産`3cd7a864...`・`c4dc6a9f...`は親セッションのもの。触っていない
- 残したもの: QEMUなし（12244以外）。dockerタグ`masuda-sandbox/image:x86_64-3f14a23ce3f7d022`（S2から継続）と`masuda-sandbox-test:latest`（このセッション以前からある）。`sandboxes.json`は空。サービスは停止済み
## 契約への提案
なし
