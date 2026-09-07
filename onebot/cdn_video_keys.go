package main

// CDN 视频上传钥匙持久化: cdnKey -> {aesKey, md5Key, videoId}
//
// 背景(2026-09-07): JS 侧 cdnVideoKeyCache 只在内存里, onebot 重启即丢;
// 同一视频(已在 CDN)重启后首次发送必撞秒传去重 —— cndOnComplete 响应不带
// aesKey, JS 侧 "cdnKey or aesKey 为空" 直接 abort, send_video 永不触发,
// HTTP 层表现为 send timeout(当天 15:42/15:45/16:29/16:32 四次)。
// 这里把每次成功拿到的钥匙落盘(onebot 工作目录 cdn_video_keys.json),
// 启动时经 rpc hydrateCdnVideoCache 回灌进 JS 缓存。
// 增长速率: 每个唯一视频一条, 定时视频一天一条, 无需清理。

import (
	"encoding/json"
	"os"
	"sync"
)

var cdnVideoKeysMu sync.Mutex

type CdnVideoKeys struct {
	AesKey  string `json:"aesKey"`
	Md5Key  string `json:"md5Key"`
	VideoId string `json:"videoId"`
}

// LoadCdnVideoKeys 读盘; 文件不存在/损坏都返回空 map 并降级(秒传首发失败一次, 不致命)
func LoadCdnVideoKeys() map[string]CdnVideoKeys {
	cdnVideoKeysMu.Lock()
	defer cdnVideoKeysMu.Unlock()
	data, err := os.ReadFile("./cdn_video_keys.json")
	if err != nil {
		return map[string]CdnVideoKeys{}
	}
	var m map[string]CdnVideoKeys
	if err := json.Unmarshal(data, &m); err != nil {
		Warn("cdn_video_keys.json 损坏, 忽略既有缓存", "err", err)
		return map[string]CdnVideoKeys{}
	}
	return m
}

// SaveCdnVideoKey upsert 一条钥匙并整表落盘(表很小, 全量重写最简单)
func SaveCdnVideoKey(cdnKey string, keys CdnVideoKeys) {
	cdnVideoKeysMu.Lock()
	defer cdnVideoKeysMu.Unlock()
	m := map[string]CdnVideoKeys{}
	if data, err := os.ReadFile("./cdn_video_keys.json"); err == nil {
		_ = json.Unmarshal(data, &m)
	}
	m[cdnKey] = keys
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return
	}
	if err := os.WriteFile("./cdn_video_keys.json", out, 0600); err != nil {
		Warn("cdn_video_keys.json 写入失败", "err", err)
	}
}
