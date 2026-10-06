# masuda-sandbox

[masuda](https://github.com/TadahiroYamamura/masuda)のサンドボックスサービス。[Gondolin](https://github.com/earendil-works/gondolin)でmicroVMを動かし、`proto/masuda/sandbox/v1/sandbox.proto`のConnect APIをUnixソケットで提供する常駐プロセス。

masudaから使うためのもので、単体で使う想定はない。masudaのリリースノートに、対応するmasuda-sandboxのバージョンが書いてある。

## 前提

- Node.js 22.19以上（npmを含む）
- QEMU
  - Linux（Debian/Ubuntu）: `sudo apt install qemu-system-x86 qemu-utils lz4`。`/dev/kvm`に読み書きできること
  - macOS（実験的）: `brew install qemu`
- Docker（ゲストイメージのビルドに使う）

## インストール

配布物はGitHub Releaseに添付したtarballだけで、npmレジストリには公開していない。

```sh
VERSION=0.1.0
BASE=https://github.com/TadahiroYamamura/masuda-sandbox/releases/download/v$VERSION
curl -fLO "$BASE/masuda-sandbox-$VERSION.tgz"
curl -fLO "$BASE/SHA256SUMS"
sha256sum -c SHA256SUMS   # macOS: shasum -a 256 -c SHA256SUMS
npm install -g "./masuda-sandbox-$VERSION.tgz"
masuda-sandbox --version
```

アンインストールは`npm uninstall -g masuda-sandbox`。

## 使い方

```sh
masuda-sandbox serve --socket "$XDG_RUNTIME_DIR/masuda-sandbox.sock"
```

ログはJSON Linesで、端末ではなく`$XDG_DATA_HOME/masuda-sandbox/logs/masuda-sandbox-serve.log`（未設定なら`~/.local/share/masuda-sandbox/logs/`）に書く。端末には起動したことと、ログの置き場所だけを出す。起動のたびに前のファイルを`.1`に回す（古いものは1つだけ残す）。端末に出したいときは`--log-file -`、別の場所に書くときは`--log-file <path>`。

ソケットには認証が無く、ファイルの権限（0600）が境界になる。ほかに`masuda-sandbox images prune [--dry-run]`で使われていないイメージを消せる。

## 開発

[`CLAUDE.md`](CLAUDE.md)を参照。リリース手順は[`docs/release.md`](docs/release.md)。
