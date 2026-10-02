# HANDOFF
## 作業項目
S10（実機1周で見つかった不足）完了。S8（SSH egress）は指示により後回しで、手を付けていない。実装コミット`26f4bd7`。
- **`disk_mib`**（`src/vm.ts`・`src/service.ts`・`src/sandboxes.ts`）: `CreateSandboxRequest.disk_mib`>0なら`VM.create`の`rootfs: { size: "<n>M" }`（GondolinではMはMiB、1024基準）。Gondolinはqcow2のoverlayを`qemu-img resize`で広げ、`start()`中にゲストで`resize2fs /dev/vda`を走らせる。resize2fsが無いと`start()`が`failed to resize rootfs inside guest (exit 127): rootfs.size requires resize2fs ...`で失敗するので、これを`FailedPrecondition`（`disk_mib needs resize2fs in the image (install e2fsprogs): ...`）に読み替える。起動前に判定する手段は無い（イメージを起動しないと分からない）ため起動時の失敗で判定し、CreateSandbox自体が失敗する（エントリは残さない）。Gondolinがresize2fsの終了コードを見ているので、`df`での事後確認は入れていない。0なら`rootfs`を渡さず従来どおり。`SandboxRecord.diskMib`に記録
- **Execの既定環境**（`src/exec.ts`の`serviceDefaultEnv`・`execBaseEnv`・`parseImageEnv`・`lookupHome`）: 優先順は「サービスの既定 < イメージのENV < CreateSandbox.env（+秘密のプレースホルダ） < Exec.env」
  - サービスの既定: `HOME`=ゲストの`getent passwd <user>`の6列目（無ければ`/etc/passwd`をawk）、`XDG_CACHE_HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`=`$HOME/.cache`・`.config`・`.local/share`、`PATH`=`$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`。ホームが引けない（ユーザーがいない）ときは`PATH`（システム部分のみ）だけで、存在しないユーザーのエラーはrunuserが出す
  - ホームはサンドボックスごと・ユーザーごとにキャッシュ（`Entry.homes`）。見つかったものだけキャッシュする（Execで後からuseraddしたユーザーのため）。ユーザーごとの初回Execで1回余分なvm.execが走る
  - イメージのENV: `BuildImage`で`docker build`直後に`docker image inspect --format '{{json .Config.Env}}' <id>`を取り、`images.json`の`env`（`"K=V"`の配列）に記録。再利用時（`image reused`）に既存レコードに`env`が無ければ埋める。`CreateSandbox`で`SandboxRecord.imageEnv`に写す。`env(1)`に渡せない名前は捨てる
- **読み取り専用ディレクトリを含むイメージのビルド**（`src/gondolin-build.ts`新規・`src/build.ts`）: 下の「結論」のとおりGondolin側の不具合。gondolin CLIの代わりに、`buildAssets(config, { workDir, outputDir })`+`importImageFromDirectory`を呼ぶだけの子プロセス`dist/gondolin-build.js`を使う（同期処理でイベントループを止めないため子プロセスのまま）。作業・出力ディレクトリは`/tmp/masuda-sandbox-build-XXXX/{work,out}`、子の`TMPDIR`もそこ。終了時（成功・失敗とも）に`chmod -R u+w`してから消す。出力の`Build ID: <id>`はCLIと同じ形式
- `runLines`に`env`オプションを足した（`src/proc.ts`）。`buf generate`で`src/gen/`を再生成（`diskMib`）
- 単体テスト: `test/unit/exec.test.ts`に既定環境6件（既定値・ホーム不明・優先順・Exec.envの上書き・Config.Envの解析・ホーム検索）。`pnpm test`は40 passed
### 読み取り専用ディレクトリの件の結論
- 再現: `FROM ubuntu:24.04`→`USER ubuntu`→`mkdir -p ~/go/pkg/mod/... && chmod -R a-w ~/go/pkg/mod/example.com`のイメージを、gondolin 0.12.0のCLI（`gondolin build --config`、`oci.image`にそのタグ）でビルドすると、`Build complete! Assets written to ...`の**後**に`Build failed: EACCES, Permission denied: /tmp/gondolin-build-XXXX`で失敗し、一時ディレクトリが残る（`chmod -R u+w`しないと消せない）
- 原因: `buildAssets()`（`host/src/build/index.ts`）が`finally`で`fs.rmSync(workDir, { recursive: true, force: true })`する。OCIのexportを展開した`workDir/rootfs`に所有者の書き込み権の無いディレクトリがあると、非rootのホストユーザーは中身を消せない。ビルド自体は成功しているが例外になり、CLIは`importImageFromDirectory`に進まない。upstreamのmain（scratchpadのcheckout `494cf18`）でも同じコード
- sandbox側の修正で解消を確認（下の手動確認）。upstreamへのIssue下書き:

```
Title: `gondolin build` fails with EACCES when the OCI rootfs contains read-only directories

`buildAssets()` removes its temporary work directory with
`fs.rmSync(workDir, { recursive: true, force: true })`. When the OCI image
contains directories without the owner write bit (e.g. a Go module cache
created by a non-root `go mod download`, which is 0555), the extracted rootfs
under `workDir/rootfs` keeps those modes and a non-root host user cannot
delete their contents. The build has already succeeded at that point
("Build complete! Assets written to ..."), but the rmSync throws, so the CLI
reports a failure, never imports the assets, and leaves /tmp/gondolin-build-*
behind.

Steps to reproduce (Linux x86_64, Docker, gondolin 0.12.0, run as non-root):

    cat > Dockerfile <<'EOF'
    FROM ubuntu:24.04
    USER ubuntu
    RUN mkdir -p /home/ubuntu/go/pkg/mod/example.com/m@v1/sub \
     && echo hi > /home/ubuntu/go/pkg/mod/example.com/m@v1/sub/f.go \
     && chmod -R a-w /home/ubuntu/go/pkg/mod/example.com
    USER root
    EOF
    docker build -t ro-repro:latest .
    cat > build-config.json <<'EOF'
    {"arch":"x86_64","distro":"alpine",
     "oci":{"image":"ro-repro:latest","runtime":"docker","pullPolicy":"never"}}
    EOF
    gondolin build --config build-config.json

Actual:

    Build complete! Assets written to /tmp/gondolin-build-XXXX
    Build failed: EACCES, Permission denied: /tmp/gondolin-build-YYYY

and /tmp/gondolin-build-YYYY remains (removable only after `chmod -R u+w`).

Expected: the build succeeds and is imported; the work directory is removed.

Suggested fix: restore the owner write bit on directories (walk and
chmod u+w) before removing the work directory in buildAssets' finally (and
before alpine.ts rmSync's an existing rootfsDir). Exposing `--work-dir` on the
CLI would also let callers clean up themselves.
```

### 手動確認（scratchpadのスクリプト、リポジトリには残していない）
- **disk_mib**（contract:testイメージ `b6839a0d-...`）: `disk_mib: 0`で`df -h /`が`/dev/vda 289M 203M 80M 72%`、`disk_mib: 8192`で`/dev/vda 7.6G 203M 7.4G 3%`。8192の方で`$HOME`に2GiBを書けて`2.2G used / 5.4G avail`
- **resize2fsなし**: `rm -f /usr/sbin/resize2fs`したイメージで`disk_mib: 4096`→`code=9 [failed_precondition] disk_mib needs resize2fs in the image (install e2fsprogs): failed to resize rootfs inside guest (exit 127): ...`。sandboxes.jsonに残らない
- **環境変数**（contract:test、ubuntuで実行）: `HOME=/home/ubuntu`、`XDG_CACHE_HOME=/home/ubuntu/.cache`（`mkdir -p $XDG_CACHE_HOME/x`成功）、`XDG_CONFIG_HOME=/home/ubuntu/.config`、`XDG_DATA_HOME=/home/ubuntu/.local/share`。rootでは`HOME=/root`・`/root/.cache`等。PATHはubuntuイメージ自身の`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`（イメージのENVが勝つので`$HOME/.local/bin`は入らない。指示の優先順どおり）
- **イメージのENV**: `ENV FOO=from-image PATH=/opt/tool/bin:...`のイメージで`PATH=/opt/tool/bin:...`が見え、`CreateSandbox.env{FOO:from-create}`で`FOO=from-create`、さらに`Exec.env{FOO:from-exec}`で`from-exec`。images.jsonには`["PATH=/opt/tool/bin:...","FOO=from-image"]`が記録された
- **読み取り専用ディレクトリ**: 上と同じイメージ（`~/go/pkg/mod/example.com`が0555）が`BuildImage`で約11.9秒で`built`。ゲスト内でも`dr-xr-xr-x ubuntu ubuntu`のまま。`/tmp`に`gondolin-build-*`・`masuda-sandbox-build-*`は残らない
## 完了した契約テスト
C-S1〜C-S7すべて緑（S8は未着手）。`node dist/cli.js serve --socket $XDG_RUNTIME_DIR/masuda-sandbox-s10.sock`に対し`pnpm test:contract`を2回連続で7 passed（約33秒・約30秒）。C-S2は約0.7秒で`image reused`（`b6839a0d-...`、このとき`env`が埋まった）。`pnpm test`は40 passed
## 未完と理由
- なし（S10の範囲）。S8は範囲外（指示により後回し）
## 次の一手
1. masuda側: `guest.BaseEnv`による`Exec.env`での回避は不要になった（残しても上書きになるだけ）。ディスクは`disk_mib`で指定でき、`GOCACHE=/tmp/go-cache`への逃がしも不要になる。使うイメージにresize2fs（e2fsprogs）が要る（ubuntu:24.04には入っている）
2. 既存のmasuda用イメージ（`5d40da65-...`・`e9d1cfc3-...`・`411234b3-...`）のレコードには`env`が無い。同じDockerfileで`BuildImage`し直せば（再利用で一瞬）埋まる。埋まるまでイメージのENVは引き継がれない
3. upstreamへのIssue（上の下書き）を出すかはユーザー判断。直ったら`src/gondolin-build.ts`をやめてCLIに戻せる
4. `docs/work-orders.md`のS8（SSH egress）
## 注意点
- イメージのENVが`PATH`を持つと、サービス既定の`$HOME/.local/bin`は入らない（Docker公式のubuntu等は必ずPATHを持つ）。`shell`での実行は`/bin/sh -lc`なので、Ubuntuの`~/.profile`が`~/.local/bin`があれば足す
- Gondolinのinitが入れる`UV_CACHE_DIR=/tmp/.cache/uv`（root所有）と`TMPDIR=/tmp`はExecに継承される（上書きしていない。指示の範囲外）。非rootでuvを使うと同じ問題が出るはず
- `/bin/sh -lc`のログインシェルが`/etc/profile`でPATHを書き換えるディストリビューション（Debian系）では、既定・イメージのPATHが効かない
- `disk_mib`はqcow2のoverlayを広げるだけで、ホストの実使用量は書いた分だけ。`qemu-img resize`はGondolin内で`execFileSync`（同期）だが短時間
- BuildImageごとに`docker image inspect`が1回増えた
- `pkill -f`で止めない。`pgrep -f '^node dist/cli.js'`でPIDを取ってkill。`dist/`を作り直したらサービス再起動
- 残したもの: QEMUなし（親セッションのPID 12244以外）。サービスは停止済み。`sandboxes.json`は空。手動確認で作ったイメージ（`c222aa53-...`のレコード・資産、dockerタグ`masuda-sandbox/image:x86_64-ff1e4bca...`・`masuda-sandbox-s10/rodir`）は削除済み。Gondolin資産は4つ（既存のもの）。`images.json`の`contract:test`のレコードに`env`が入った
## 契約への提案
なし。ただし既定環境の内容（上の優先順と変数）は契約に書かれていない。masudaが依存するなら`ExecRequest.env`のコメントに書くかを監督が判断してほしい
