package main

import (
	"encoding/json"
	"fmt"
	"os"
	"text/template"
)

func main() {
	tplData, err := os.ReadFile("../script.js")
	if err != nil {
		panic(err)
	}
	jsonData, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var conf map[string]any
	if err := json.Unmarshal(jsonData, &conf); err != nil {
		panic(err)
	}
	tmpl, err := template.New("s").Parse(string(tplData))
	if err != nil {
		panic(err)
	}
	f, err := os.Create(os.Args[2])
	if err != nil {
		panic(err)
	}
	defer f.Close()
	if err := tmpl.Execute(f, conf); err != nil {
		fmt.Println("EXEC ERR:", err)
		os.Exit(1)
	}
	fmt.Println("rendered ok")
}
