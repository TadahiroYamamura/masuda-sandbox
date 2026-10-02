# HANDOFF
## 作業項目
S2（イメージ）完了。`src/build.ts`（`docker build --provenance=false --iidfile`→`docker tag masuda-sandbox/image:<arch>-<digest16桁>`→`gondolin build --config`（`oci.image`・`pullPolicy: never`・`rootfsMode: cow`）。build_idはCLI出力の`Build ID:`行から取る）、`src/proc.ts`（子プロセスの行を非同期に到着順でyieldする`runLines`。キャンセルで子をkill）、`src/images.ts`（`ImageStore`。`$XDG_DATA_HOME/masuda-sandbox/images.json`、未設定なら`~/.local/share/...`。書き込みは直列化＋rename。S3用に`get(buildId)`あり）、`src/service.ts`に`buildImage`/`listImages`
## 完了した契約テスト
C-S1・C-S2（`pnpm start -- serve --socket $XDG_RUNTIME_DIR/masuda-sandbox-s2.sock`を起動し、`MASUDA_SANDBOX_SOCKET=$XDG_RUNTIME_DIR/masuda-sandbox-s2.sock pnpm test:contract`で2 passed / 5 failed。C-S3以降はUnimplemented。キャッシュが温まっていればC-S2は10〜15秒、初回は約45秒）
## 未完と理由
- S3以降は範囲外
- 古いイメージの掃除（images.jsonの行・Gondolinの資産オブジェクト・dockerタグ）は未実装。契約にDeleteImageが無い
- `pnpm test`（単体テスト）はテストファイルが無いので失敗したまま
## 次の一手
`docs/work-orders.md`のS3（CreateSandbox/Exec/DestroySandbox）。build_idの解決は`ImageStore.get`、またはGondolinの`resolveImageSelector(buildId)`（image storeの`~/.cache/gondolin/images/objects/<build_id>`）
## 注意点
- Gondolinの`buildAssets()`/`importImageFromDirectory()`はexecFileSyncや同期fsコピーを使う。ライブラリ呼び出しにせず、CLI（`dist/bin/gondolin.js`を`process.execPath`で起動）を子プロセスで使っている
- Dockerはcontainerdイメージストア。既定のprovenance attestationが付くと完全キャッシュの再ビルドでもイメージIDが毎回変わる。`--provenance=false`で安定する
- Gondolinのbuild_idは同じOCIイメージからでもビルドごとに変わる（rootfsが再現可能でない）。1回約390MBの資産オブジェクトが`~/.cache/gondolin/images/objects/`に溜まる
- `pkill -f "...masuda-sandbox-s2.sock"`のようにシェルのコマンドラインにも現れる文字列で殺すと、そのシェル自身にも当たる。`pkill -TERM -f '^node dist/cli.js -- serve'`を使う
- このリポジトリと無関係なQEMU（PID 12244、親セッションのスパイク）が動いている。触っていない。`~/.cache/gondolin/images/objects/`の`3cd7a864...`・`c4dc6a9f...`もこのセッションのものではない
- 残したもの: dockerタグ`masuda-sandbox/image:x86_64-3f14a23ce3f7d022`、Gondolin資産`db75ce32-...`・`40601cce-...`（images.jsonに記録済み）
## 契約への提案
なし（将来的にイメージ削除のRPCがあると蓄積を掃除できる、という程度。S2の完了には不要）
