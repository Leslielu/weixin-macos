// voipprobe — VoIP 通话链路动态探针 runner
// 连接 frida-gadget (默认 127.0.0.1:27042), 加载探针脚本, 原样打印脚本消息。
// 用法: voipprobe -addr 127.0.0.1:27042 -script ../../tools/voip/probe.js
package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/frida/frida-go/frida"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:27042", "gadget 地址")
	scriptPath := flag.String("script", "probe.js", "探针脚本路径")
	flag.Parse()

	code, err := os.ReadFile(*scriptPath)
	if err != nil {
		fmt.Println("读脚本失败:", err)
		os.Exit(1)
	}

	mgr := frida.NewDeviceManager()
	dev, err := mgr.AddRemoteDevice(*addr, frida.NewRemoteDeviceOptions())
	if err != nil {
		fmt.Println("连接 gadget 失败:", err)
		os.Exit(1)
	}
	session, err := dev.Attach("Gadget", nil)
	if err != nil {
		fmt.Println("attach 失败:", err)
		os.Exit(1)
	}
	session.On("detached", func(reason frida.SessionDetachReason, crash *frida.Crash) {
		fmt.Printf("[!] session detached: %s crash=%v\n", reason, crash)
		os.Exit(2)
	})

	script, err := session.CreateScript(string(code))
	if err != nil {
		fmt.Println("创建脚本失败:", err)
		os.Exit(1)
	}
	script.On("message", func(rawMsg string) {
		fmt.Printf("%s %s\n", time.Now().Format("15:04:05.000"), rawMsg)
	})
	if err := script.Load(); err != nil {
		fmt.Println("脚本加载失败:", err)
		os.Exit(1)
	}
	fmt.Println("[*] 探针已加载, Ctrl-C 退出")

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	script.Clean()
	session.Clean()
	dev.Clean()
}
