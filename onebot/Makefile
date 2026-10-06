.PHONY: build
# frida-go v1.0.2 是 CGO 构建, 依赖仓库内 frida-devkit(frida-core 17.8.1 macos-arm64)
build:
	CGO_ENABLED=1 \
	CGO_CFLAGS="-I$(CURDIR)/../frida-devkit" \
	CGO_LDFLAGS="-L$(CURDIR)/../frida-devkit -lfrida-core -lm -lresolv" \
	go build -o onebot .
