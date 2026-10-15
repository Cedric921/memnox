# What CI's Ubuntu job has: Node, pnpm through corepack, Rust for the Noise addon, and a user
# who is not root, since a test that checks a file is unreadable passes for root whatever it says.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm
RUN corepack enable
USER node
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH=/home/node/.cargo/bin:$PATH
WORKDIR /home/node
