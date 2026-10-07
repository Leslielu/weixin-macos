// cmodtest: 本地 CModule 编译验证器 — attach 到 sleep 进程编译 rigcapture 的 C 源,
// 不碰微信。用法: go run cmodtest/main.go
package main

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	frida "github.com/frida/frida-go/frida"
)

func main() {
	// 1. 从 rigcapture.js 提取 RIG_PROBE_C 数组拼成 C 源
	js, err := os.ReadFile("rigcapture.js")
	if err != nil {
		fmt.Println("read rigcapture.js:", err)
		os.Exit(1)
	}
	src := string(js)
	start := strings.Index(src, "var RIG_PROBE_C = [")
	end := strings.Index(src, "].join(\"\\n\");")
	if start < 0 || end < 0 {
		fmt.Println("RIG_PROBE_C not found")
		os.Exit(1)
	}
	arrSrc := src[start:end]
	re := regexp.MustCompile(`"((?:[^"\\]|\\.)*)",`)
	var lines []string
	for _, m := range re.FindAllStringSubmatch(arrSrc, -1) {
		line := strings.ReplaceAll(m[1], `\"`, `"`)
		line = strings.ReplaceAll(line, `\\`, `\`)
		lines = append(lines, line)
	}
	cSource := strings.Join(lines, "\n")
	fmt.Printf("extracted C source: %d lines, %d bytes\n", len(lines), len(cSource))

	// 2. frida spawn sleep (frida 拉起的进程有 task port, 避免 task_for_pid 拒绝)
	mgr := frida.NewDeviceManager()
	device, err := mgr.DeviceByType(frida.DeviceTypeLocal)
	if err != nil {
		fmt.Println("local device:", err)
		os.Exit(1)
	}
	pid, err := device.Spawn("/tmp/dummy_target", nil)
	if err != nil {
		fmt.Println("spawn:", err)
		os.Exit(1)
	}
	session, err := device.Attach(pid, nil)
	if err != nil {
		fmt.Println("attach:", err)
		os.Exit(1)
	}
	if err := device.Resume(pid); err != nil {
		fmt.Println("resume:", err)
		os.Exit(1)
	}

	// 3. 编译 CModule 并调用一个 export 验证
	scriptSrc := `
function step(n, fn) { try { fn(); console.log("step " + n + " ok"); } catch (e) { console.log("step " + n + " FAIL: " + e); } }
var cm = null, f = null, T = null, ring = null, head = null, data = null, dst = null;
step(1, function(){ cm = new CModule(SRC_PLACEHOLDER); });
step(2, function(){ f = new NativeFunction(cm.rs3, 'uint64', ['pointer', 'pointer', 'pointer', 'uint64', 'uint64']); });
step(3, function(){ T = Memory.alloc(0x80); ring = Memory.alloc(64 * 48); head = Memory.alloc(8); data = Memory.alloc(16); dst = Memory.alloc(64); });
step(4, function(){ data.writeByteArray([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]); });
step(5, function(){ T.add(0x40).writePointer(ring); T.add(0x48).writePointer(head); head.writeU64(uint64(0)); T.add(0x50).writeU64(uint64(1)); T.add(0x58).writePointer(data); T.add(0x60).writeU64(uint64(16)); T.add(0x68).writeU64(uint64(0)); });
step(6, function(){ var dst2 = Memory.alloc(8); var rv = f(T, dst, dst2, uint64(0), uint64(0)); console.log("rv=" + rv + " writtenLen=" + dst2.readU64()); });
step(7, function(){ console.log("dst=" + Array.from(new Uint8Array(dst.readByteArray(8))).join(",") + " head=" + head.readU64()); });
step(8, function(){ var g = new NativeFunction(cm.rdtor, 'void', ['pointer']); g(T); console.log("rdtor ok, head=" + head.readU64()); });
`
	scriptSrc = strings.ReplaceAll(scriptSrc, "SRC_PLACEHOLDER", fmt.Sprintf("%q", cSource))

	script, err := session.CreateScript(scriptSrc)
	if err != nil {
		fmt.Println("COMPILE/CREATE FAIL:", err)
		os.Exit(1)
	}
	script.On("message", func(msg string) {
		fmt.Println("JS:", msg)
	})
	if err := script.Load(); err != nil {
		fmt.Println("LOAD FAIL:", err)
		os.Exit(1)
	}
	time.Sleep(1 * time.Second)
	fmt.Println("CMODULE TEST OK")
}
