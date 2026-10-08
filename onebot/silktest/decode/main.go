package main

import (
	"fmt"
	"math"
	"os"

	"github.com/wdvxdr1123/go-silk"
)

// 解码 silk → wav + 语音/噪音统计判定
func main() {
	silkBytes, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	pcm, err := silk.DecodeSilkBuffToPcm(silkBytes, 16000)
	if err != nil {
		fmt.Println("DECODE FAIL:", err)
		os.Exit(1)
	}
	n := len(pcm) / 2
	samples := make([]int, n)
	for i := 0; i < n; i++ {
		samples[i] = int(int16(pcm[2*i]) | int16(pcm[2*i+1])<<8)
	}
	// 分帧统计: 100ms 帧 RMS + 过零率
	frame := 1600
	var frames []float64
	var zcrs []float64
	for i := 0; i+frame <= n; i += frame {
		var sumSq float64
		zc := 0
		for j := 0; j < frame; j++ {
			s := samples[i+j]
			sumSq += float64(s) * float64(s)
			if j > 0 && (samples[i+j-1] < 0) != (s < 0) {
				zc++
			}
		}
		rms := math.Sqrt(sumSq / float64(frame))
		frames = append(frames, rms)
		zcrs = append(zcrs, float64(zc)/float64(frame))
	}
	var maxR, minR, sumR, sumZ float64
	for i, r := range frames {
		if i == 0 || r > maxR {
			maxR = r
		}
		if i == 0 || r < minR {
			minR = r
		}
		sumR += r
		sumZ += zcrs[i]
	}
	cnt := float64(len(frames))
	fmt.Printf("decoded %d samples (%.1fs @16k)\n", n, float64(n)/16000)
	fmt.Printf("RMS: min=%.0f max=%.0f avg=%.0f 动态范围=%.1f\n", minR, maxR, sumR/cnt, maxR/(minR+1))
	fmt.Printf("过零率 avg=%.3f\n", sumZ/cnt)
	// 语音: 动态范围大(静音段/有声段), 过零率中等; 白噪: RMS 平坦, 过零率≈0.5+
	if maxR/(minR+1) > 4 && sumZ/cnt < 0.35 {
		fmt.Println("判定: 语音(有动态结构)")
	} else {
		fmt.Println("判定: 疑似噪音(RMS平坦或过密过零)")
	}
	// 写 wav
	wav := make([]byte, 44+len(pcm))
	copy(wav[0:], "RIFF")
	sz := uint32(36 + len(pcm))
	wav[4], wav[5], wav[6], wav[7] = byte(sz), byte(sz>>8), byte(sz>>16), byte(sz>>24)
	copy(wav[8:], "WAVEfmt ")
	sz2 := uint32(16)
	wav[16], wav[17], wav[18], wav[19] = byte(sz2), byte(sz2>>8), 0, 0
	wav[20], wav[21] = 1, 0 // PCM
	wav[22], wav[23] = 1, 0 // mono
	sr := uint32(16000)
	wav[24], wav[25], wav[26], wav[27] = byte(sr), byte(sr>>8), byte(sr>>16), byte(sr>>24)
	wav[28], wav[29], wav[30], wav[31] = byte(sr), byte(sr>>8), byte(sr>>16), byte(sr>>24)
	wav[32], wav[33] = 2, 0
	wav[34], wav[35] = 16, 0
	copy(wav[36:], "data")
	dsz := uint32(len(pcm))
	wav[40], wav[41], wav[42], wav[43] = byte(dsz), byte(dsz>>8), byte(dsz>>16), byte(dsz>>24)
	copy(wav[44:], pcm)
	os.WriteFile(os.Args[2], wav, 0644)
	fmt.Println("wav written:", os.Args[2])
}
