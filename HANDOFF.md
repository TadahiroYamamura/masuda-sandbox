# HANDOFF
## 作業項目
2026-10-14: #11（VMの中でカーネルのモジュールを読み込めない）。`cac186f`（`main`にpush済み、未タグ）。作業はmasudaのセッションが行った。

- `src/modules.ts`の`unpackKernelModules`を、`src/vm.ts`の`bootVm`で`vm.start()`の直後に呼ぶ。ゲストでrootとして`/lib/modules/$(uname -r)`の`.ko.gz`を展開し、`depmod -a`する
- depmodの無いイメージでは何もしない。`gzip -l`で展開後の大きさを測り、空きが足りなければ（展開後の大きさ＋64MiB未満）展開せずにログを出す
- 失敗しても起動は止めず、ログ（`unpacking kernel modules failed`）に出す
- エージェントのVMも`RunJob`の特権VMも、同じ`registry.create`→`bootVm`を通る

ユーザーの判断（10-14）: 案A'。
- `init.rootfsInitExtra`に書く案Aは試して失敗した。Gondolinがディスクを`disk_mib`へ拡げる（`resize2fs`）のは`start()`の中で、rootfsInitExtraより後。そのため空きが常に足りなかった
- ビルドの時点で展開する案は、Gondolinの内部に頼り、版上げで黙って元に戻るので取らない
  - 展開済みのモジュールをイメージに先に置く
  - `mke2fs`を包む
  - `rootfs.ext4`を書き換える
- 代わりに、VMごとに1〜2秒と約110MBのディスクを使う
## 完了した契約テスト
- 単体テスト154件が緑。`test/unit/modules.test.ts`の5件は、偽の`depmod`・`df`を使い、次を確かめる
  - 展開する
  - 空きが1KiB足りなければ展開しない
  - depmodが無ければ何もしない
  - 展開済みなら何もしない
  - 呼び出しの形
- 判定の分岐を壊すと、すべてテストが落ちることを確かめた
- 実VM（開発版のサービス、一時のプローブ）で確かめたこと：
  - kmodの入ったイメージ・`disk_mib` 2048：889個を展開し、`modprobe -a overlay bridge veth br_netfilter nf_tables nf_nat nf_conntrack xt_MASQUERADE nft_chain_nat nft_compat`が通る。`CreateSandbox`が約1.5〜2秒延びる
  - 既定のディスク：展開せず、`kernel modules left compressed: 112221KiB needed, 72412KiB free`をログに出す
  - kmodの無いイメージ：何もしない
- 契約テスト（C-S*）は回していない。v0.5.0のリリース前に回す
## 未完と理由
- #11は閉じていない。dockerdを特権VMで動かす1周（masuda経由）を、v0.5.0を出した後にハーネスで確かめてから閉じる
- 展開したときのログに`depmod: ERROR: fstatat(3, vmlinuz): No such file or directory`が1行入る（害は無い）
- #8の保険`8670a19`（`fix/destroy-with-ssh`）はmainに入っていない（判断待ち）
- DeleteImageの「使用中か」の確認と削除の間に、同じイメージでCreateSandbox・RunJobが始まると起動に失敗しうる（直していない）
## 次の一手
1. v0.5.0のリリース（masudaのSkill `release`）。その前に契約テストを実VMで回す
2. リリース後、ハーネスで#11を確かめて閉じる
## 注意点
- 契約テストは専用のソケット（例 `$XDG_RUNTIME_DIR/masuda-sandbox-<名前>.sock`）で立てたサービスに対して回す。回す前にハーネス（masudaの`masuda list --all`）に走行中のワークスペースが無いことを確かめ、終わったら自分のサービスのPIDをkillして`pgrep -af qemu-system`を見る
- `pnpm test`は`pnpm build`済みのdistを前提にする（`test/unit/dist.test.ts`）
- `masuda-sandbox`を入れ直すと、ハーネスに手で当てたgondolinのTCPの修正（masudaの`~/work/gondolin-notes/harness-hotfix/`）が消える。入れ直したら当て直す
- 上流（Gondolin）への投稿は、ユーザーがWebの画面から個人のアカウント（TadahiroYamamura）で行う。この端末の`gh`は社用のアカウントで、`scripts/gh.sh`のトークンは自分のリポジトリだけ
## 契約への提案
- なし
