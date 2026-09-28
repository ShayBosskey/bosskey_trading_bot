# whisper.cpp compiled ON the Pi for the Pi's own CPU.
#
# The upstream ghcr.io/ggml-org/whisper.cpp:main-arm64 image is built on
# ARMv8.2+ CI runners and dies with SIGILL (exit 132) on a Pi 4's Cortex-A72
# (ARMv8.0). GGML_NATIVE=ON makes the compiler target whatever CPU runs the
# build - so build this on the Pi itself.
ARG WHISPER_REF=v1.9.4

FROM debian:bookworm-slim AS build
ARG WHISPER_REF
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${WHISPER_REF}" https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DBUILD_SHARED_LIBS=OFF \
          -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_SDL2=OFF \
 && cmake --build build -j"$(nproc)" --target whisper-server

FROM debian:bookworm-slim
# ffmpeg: needed by whisper-server --convert. curl: model download script.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates libgomp1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/build/bin/whisper-server /usr/local/bin/whisper-server
COPY --from=build /src/models/download-ggml-model.sh /app/models/download-ggml-model.sh
# Same entrypoint as the upstream image, so docker-compose.yml's command is unchanged.
ENTRYPOINT ["bash", "-c"]
