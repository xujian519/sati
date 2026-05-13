FROM wildclawbench-claudecode-ubuntu:v0.2-patched

COPY bun /usr/local/bin/bun
RUN chmod +x /usr/local/bin/bun && bun --version

RUN apt-get update -qq && apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*
