package main

import (
	"fmt"
	"os"

	"github.com/wdvxdr1123/go-silk"
)

func main() {
	pcm, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	out, err := silk.EncodePcmBuffToSilk(pcm, 16000, 16000, true)
	if err != nil {
		panic(err)
	}
	fmt.Printf("pcm=%d bytes silk=%d bytes header=%q\n", len(pcm), len(out), out[:10])
	os.WriteFile(os.Args[2], out, 0644)

	// 自解码回 PCM，量平均幅度
	dec, err := silk.DecodeSilkBuffToPcm(out, 16000)
	if err != nil {
		fmt.Println("self-decode err:", err)
		return
	}
	var sum, peak int16
	for i := 0; i+1 < len(dec); i += 2 {
		s := int16(dec[i]) | int16(dec[i+1])<<8
		if s < 0 {
			if -s > peak {
				peak = -s
			}
		} else if s > peak {
			peak = s
		}
		sum += s / int16(len(dec)/2)
	}
	fmt.Printf("self-decode: %d bytes pcm, peak=%d, avg=%d (32767=满幅)\n", len(dec), peak, sum)
}
