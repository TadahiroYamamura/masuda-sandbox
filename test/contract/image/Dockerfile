# Guest used by the contract tests: the smallest Ubuntu that has what the
# tests exercise (curl for egress, tmux + sshd for attach, a non-root user).
FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tmux openssh-server procps coreutils \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /masuda /workspace && chown ubuntu:ubuntu /masuda /workspace
