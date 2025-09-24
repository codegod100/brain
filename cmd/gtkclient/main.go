package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gotk3/gotk3/glib"
	"github.com/gotk3/gotk3/gtk"
)

const (
	defaultControlURL  = "http://127.0.0.1:4455"
	defaultControlPort = 4455
	requestTimeout     = 6 * time.Second
	logLimit           = 500
)

type app struct {
	controlURL *url.URL

	statusLabel *gtk.Label

	commandEntry    *gtk.Entry
	playEntry       *gtk.Entry
	broadcastEntry  *gtk.Entry
	uploadNameEntry *gtk.Entry

	uploadFilePath string

	textBuffer *gtk.TextBuffer

	audioFlow        *gtk.FlowBox
	audioButtons     []*gtk.Button
	audioPlaceholder *gtk.Label

	socket *socketClient
}

type statusResponse struct {
	Host      string      `json:"host"`
	Connected bool        `json:"connected"`
	Timestamp string      `json:"timestamp"`
	Whoami    interface{} `json:"whoami"`
	AudioList interface{} `json:"audioList"`
}

type filesResponse struct {
	Files []string `json:"files"`
}

type commandResponse struct {
	Result interface{} `json:"result"`
}

type uploadResponse struct {
	Filename    string `json:"filename"`
	Size        int    `json:"size"`
	ContentType string `json:"contentType"`
}

type audioFile struct {
	Name     string
	Size     *int64
	Uploaded string
}

func main() {
	ctrl := os.Getenv("CLIENT_CONTROL_URL")
	if ctrl == "" {
		ctrl = defaultControlURL
	}
	parsed, err := url.Parse(ctrl)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid CLIENT_CONTROL_URL: %v\n", err)
		os.Exit(1)
	}

	if err := gtk.InitCheck(nil); err != nil {
		fmt.Fprintf(os.Stderr, "failed to init gtk: %v\n", err)
		os.Exit(1)
	}

	a := &app{
		controlURL: parsed,
	}

	if err := a.buildUI(); err != nil {
		fmt.Fprintf(os.Stderr, "ui error: %v\n", err)
		os.Exit(1)
	}

	a.logf("Control URL: %s", parsed.String())
	if err := a.connectSocket(); err != nil {
		a.logf("socket connect error: %v", err)
	} else {
		go a.fetchStatus()
	}

	gtk.Main()
}

func (a *app) buildUI() error {
	win, err := gtk.WindowNew(gtk.WINDOW_TOPLEVEL)
	if err != nil {
		return err
	}
	win.SetTitle("Brain Hub (GTK)")
	win.SetDefaultSize(900, 600)
	win.Connect("destroy", func() {
		a.closeSocket()
		gtk.MainQuit()
	})

	vbox, err := gtk.BoxNew(gtk.ORIENTATION_VERTICAL, 8)
	if err != nil {
		return err
	}
	vbox.SetBorderWidth(12)
	win.Add(vbox)

	statusBox, _ := gtk.BoxNew(gtk.ORIENTATION_HORIZONTAL, 8)
	vbox.PackStart(statusBox, false, false, 0)

	a.statusLabel, _ = gtk.LabelNew("Status: pending...")
	statusBox.PackStart(a.statusLabel, true, true, 0)

	refreshBtn, _ := gtk.ButtonNewWithLabel("Refresh Status")
	refreshBtn.Connect("clicked", func() { go a.fetchStatus() })
	statusBox.PackEnd(refreshBtn, false, false, 0)

	filesBtn, _ := gtk.ButtonNewWithLabel("List Files")
	filesBtn.Connect("clicked", func() { go a.fetchFiles() })
	vbox.PackStart(filesBtn, false, false, 0)

	peersBtn, _ := gtk.ButtonNewWithLabel("Show Peers")
	peersBtn.Connect("clicked", func() {
		a.logf("peers command requested")
		go a.execCommand("peers")
	})
	vbox.PackStart(peersBtn, false, false, 0)

	commandBox, _ := gtk.BoxNew(gtk.ORIENTATION_HORIZONTAL, 6)
	vbox.PackStart(commandBox, false, false, 0)
	commandLabel, _ := gtk.LabelNew("Command:")
	commandBox.PackStart(commandLabel, false, false, 0)
	a.commandEntry, _ = gtk.EntryNew()
	a.commandEntry.SetPlaceholderText("e.g. audio list")
	commandBox.PackStart(a.commandEntry, true, true, 0)
	commandBtn, _ := gtk.ButtonNewWithLabel("Send")
	commandBtn.Connect("clicked", func() {
		text, _ := a.commandEntry.GetText()
		go a.execCommand(strings.TrimSpace(text))
	})
	commandBox.PackEnd(commandBtn, false, false, 0)

	playBox, _ := gtk.BoxNew(gtk.ORIENTATION_HORIZONTAL, 6)
	vbox.PackStart(playBox, false, false, 0)
	playLabel, _ := gtk.LabelNew("Play filename:")
	playBox.PackStart(playLabel, false, false, 0)
	a.playEntry, _ = gtk.EntryNew()
	playBox.PackStart(a.playEntry, true, true, 0)
	playBtn, _ := gtk.ButtonNewWithLabel("Play")
	playBtn.Connect("clicked", func() {
		name, _ := a.playEntry.GetText()
		go a.invokePlay(strings.TrimSpace(name))
	})
	playBox.PackEnd(playBtn, false, false, 0)

	broadcastBox, _ := gtk.BoxNew(gtk.ORIENTATION_HORIZONTAL, 6)
	vbox.PackStart(broadcastBox, false, false, 0)
	broadcastLabel, _ := gtk.LabelNew("Broadcast message:")
	broadcastBox.PackStart(broadcastLabel, false, false, 0)
	a.broadcastEntry, _ = gtk.EntryNew()
	broadcastBox.PackStart(a.broadcastEntry, true, true, 0)
	broadcastBtn, _ := gtk.ButtonNewWithLabel("Broadcast")
	broadcastBtn.Connect("clicked", func() {
		msg, _ := a.broadcastEntry.GetText()
		go a.invokeBroadcast(strings.TrimSpace(msg))
	})
	broadcastPlayBtn, _ := gtk.ButtonNewWithLabel("Broadcast Play")
	broadcastPlayBtn.Connect("clicked", func() {
		name, _ := a.playEntry.GetText()
		go a.invokeBroadcastPlay(strings.TrimSpace(name))
	})
	broadcastBox.PackEnd(broadcastPlayBtn, false, false, 0)
	broadcastBox.PackEnd(broadcastBtn, false, false, 0)

	uploadBox, _ := gtk.BoxNew(gtk.ORIENTATION_HORIZONTAL, 6)
	vbox.PackStart(uploadBox, false, false, 0)
	chooseBtn, _ := gtk.ButtonNewWithLabel("Choose File")
	chooseBtn.Connect("clicked", func() { go a.chooseUploadFile() })
	uploadBox.PackStart(chooseBtn, false, false, 0)
	remoteLabel, _ := gtk.LabelNew("Remote name:")
	uploadBox.PackStart(remoteLabel, false, false, 0)
	a.uploadNameEntry, _ = gtk.EntryNew()
	a.uploadNameEntry.SetPlaceholderText("leave blank to use file name")
	uploadBox.PackStart(a.uploadNameEntry, true, true, 0)
	uploadBtn, _ := gtk.ButtonNewWithLabel("Upload")
	uploadBtn.Connect("clicked", func() {
		path := a.uploadFilePath
		remote, _ := a.uploadNameEntry.GetText()
		go a.runUpload(path, remote)
	})
	uploadBox.PackEnd(uploadBtn, false, false, 0)

	audioFrame, _ := gtk.FrameNew("Remote Audio Files")
	audioFrame.SetShadowType(gtk.SHADOW_IN)
	audioFrame.SetLabelAlign(0, 0.5)
	vbox.PackStart(audioFrame, false, false, 0)

	audioScroll, _ := gtk.ScrolledWindowNew(nil, nil)
	audioScroll.SetPolicy(gtk.POLICY_AUTOMATIC, gtk.POLICY_AUTOMATIC)
	audioScroll.SetHExpand(true)
	audioFrame.Add(audioScroll)

	a.audioFlow, _ = gtk.FlowBoxNew()
	a.audioFlow.SetColumnSpacing(6)
	a.audioFlow.SetRowSpacing(6)
	a.audioFlow.SetMaxChildrenPerLine(3)
	a.audioFlow.SetSelectionMode(gtk.SELECTION_NONE)
	a.audioFlow.SetHomogeneous(false)
	a.audioFlow.SetActivateOnSingleClick(true)
	audioScroll.Add(a.audioFlow)
	if err := a.setAudioPlaceholder("Loading audio files..."); err != nil {
		a.logf("audio placeholder error: %v", err)
	}

	scroll, _ := gtk.ScrolledWindowNew(nil, nil)
	scroll.SetPolicy(gtk.POLICY_AUTOMATIC, gtk.POLICY_AUTOMATIC)
	scroll.SetVExpand(true)
	scroll.SetHExpand(true)
	vbox.PackStart(scroll, true, true, 0)

	textView, _ := gtk.TextViewNew()
	textView.SetEditable(false)
	textView.SetWrapMode(gtk.WRAP_WORD_CHAR)
	scroll.Add(textView)
	a.textBuffer, _ = textView.GetBuffer()

	win.ShowAll()
	return nil
}

func (a *app) logf(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	ts := time.Now().Format("15:04:05")
	glib.IdleAdd(func() bool {
		if a.textBuffer == nil {
			return false
		}
		iter := a.textBuffer.GetEndIter()
		a.textBuffer.Insert(iter, fmt.Sprintf("[%s] %s\n", ts, msg))
		if a.textBuffer.GetLineCount() > logLimit {
			start := a.textBuffer.GetStartIter()
			next := start
			next.ForwardLine()
			a.textBuffer.Delete(start, next)
		}
		return false
	})
}

func (a *app) fetchStatus() {
	var res statusResponse
	if err := a.socketRequest("status", nil, &res); err != nil {
		a.logf("status error: %v", err)
		return
	}
	files, audioErr := parseAudioList(res.AudioList)
	glib.IdleAdd(func() bool {
		if a.statusLabel != nil {
			a.statusLabel.SetText(fmt.Sprintf("Status: %s (connected=%v)", res.Host, res.Connected))
		}
		a.logf("status ok: host=%s connected=%v", res.Host, res.Connected)
		a.refreshAudioButtons(files, audioErr)
		switch {
		case audioErr != "":
			a.logf("audio list error: %s", audioErr)
		case len(files) == 0:
			a.logf("audio list empty")
		default:
			preview := make([]string, len(files))
			for i, file := range files {
				preview[i] = file.Name
			}
			if len(preview) > 6 {
				preview = preview[:6]
			}
			a.logf("audio list (%d): %s", len(files), strings.Join(preview, ", "))
		}
		return false
	})
}

func (a *app) fetchFiles() {
	var res filesResponse
	if err := a.socketRequest("files", nil, &res); err != nil {
		a.logf("files error: %v", err)
		return
	}
	preview := res.Files
	if len(preview) > 12 {
		preview = preview[:12]
	}
	a.logf("files (%d): %s", len(res.Files), strings.Join(preview, ", "))
}

func (a *app) execCommand(command string) {
	if command == "" {
		a.logf("command empty")
		return
	}
	var res commandResponse
	if err := a.socketRequest("command", map[string]any{"command": command}, &res); err != nil {
		a.logf("command error: %v", err)
		return
	}
	enc, _ := json.Marshal(res.Result)
	a.logf("command result: %s", enc)
}

func (a *app) invokePlay(filename string) {
	if filename == "" {
		a.logf("play filename missing")
		return
	}
	if err := a.socketRequest("play", map[string]any{"filename": filename}, nil); err != nil {
		a.logf("play error: %v", err)
		return
	}
	a.logf("play invoked: %s", filename)
}

func (a *app) invokeBroadcast(message string) {
	if message == "" {
		a.logf("broadcast message missing")
		return
	}
	if err := a.socketRequest("broadcast", map[string]any{"message": message}, nil); err != nil {
		a.logf("broadcast error: %v", err)
		return
	}
	a.logf("broadcast sent")
}

func (a *app) invokeBroadcastPlay(filename string) {
	if filename == "" {
		a.logf("broadcast play filename missing")
		return
	}
	if err := a.socketRequest("broadcast-play", map[string]any{"filename": filename}, nil); err != nil {
		a.logf("broadcast play error: %v", err)
		return
	}
	a.logf("broadcast play sent: %s", filename)
}

func (a *app) chooseUploadFile() {
	dialog, err := gtk.FileChooserDialogNewWith2Buttons(
		"Select file to upload",
		nil,
		gtk.FILE_CHOOSER_ACTION_OPEN,
		"Cancel", gtk.RESPONSE_CANCEL,
		"Select", gtk.RESPONSE_ACCEPT,
	)
	if err != nil {
		a.logf("upload dialog error: %v", err)
		return
	}
	defer dialog.Destroy()

	if response := dialog.Run(); response == gtk.RESPONSE_ACCEPT {
		path := dialog.GetFilename()
		glib.IdleAdd(func() bool {
			a.uploadFilePath = path
			a.uploadNameEntry.SetText(filepath.Base(path))
			a.logf("upload selected: %s", path)
			return false
		})
	}
}

func (a *app) runUpload(path, remote string) {
	if path == "" {
		a.logf("no upload file selected")
		return
	}
	remote = strings.TrimSpace(remote)
	if remote == "" {
		remote = filepath.Base(path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		a.logf("read error: %v", err)
		return
	}
	var res uploadResponse
	if err := a.socketRequest("upload", map[string]any{
		"filename":    remote,
		"base64":      base64.StdEncoding.EncodeToString(data),
		"contentType": detectContentType(remote),
	}, &res); err != nil {
		a.logf("upload error: %v", err)
		return
	}
	a.logf("upload complete: %s (%d bytes)", res.Filename, res.Size)
	go a.fetchStatus()
}

func (a *app) connectSocket() error {
	addr, err := a.socketAddress()
	if err != nil {
		return err
	}
	client, err := newSocketClient(addr, a.handleSocketEvent)
	if err != nil {
		return err
	}
	a.socket = client
	a.logf("socket connected: %s", addr)
	return nil
}

func (a *app) closeSocket() {
	if a.socket != nil {
		_ = a.socket.Close()
		a.socket = nil
	}
}

func (a *app) socketAddress() (string, error) {
	host := a.controlURL.Hostname()
	if host == "" {
		host = "127.0.0.1"
	}
	if portStr := os.Getenv("CLIENT_SOCKET_PORT"); portStr != "" {
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return "", fmt.Errorf("invalid CLIENT_SOCKET_PORT: %w", err)
		}
		return net.JoinHostPort(host, strconv.Itoa(port)), nil
	}
	portStr := a.controlURL.Port()
	port := defaultControlPort
	if portStr != "" {
		p, err := strconv.Atoi(portStr)
		if err != nil {
			return "", fmt.Errorf("invalid control port: %w", err)
		}
		port = p
	}
	return net.JoinHostPort(host, strconv.Itoa(port+1)), nil
}

func (a *app) socketRequest(action string, payload map[string]any, out interface{}) error {
	if a.socket == nil {
		return fmt.Errorf("socket not connected")
	}
	resp, err := a.socket.request(action, payload)
	if err != nil {
		return err
	}
	if out != nil && len(resp.Data) > 0 {
		if err := json.Unmarshal(resp.Data, out); err != nil {
			return err
		}
	}
	return nil
}

func (a *app) handleSocketEvent(msg socketMessage) {
	switch msg.Event {
	case "hello":
		if len(msg.Payload) > 0 {
			var info map[string]interface{}
			if err := json.Unmarshal(msg.Payload, &info); err == nil {
				h, _ := info["host"].(string)
				ts, _ := info["connectedAt"].(string)
				if h != "" {
					a.logf("socket hello from %s (since %s)", h, ts)
				} else {
					a.logf("socket hello: %s", strings.TrimSpace(string(msg.Payload)))
				}
			} else {
				a.logf("socket hello: %s", strings.TrimSpace(string(msg.Payload)))
			}
		} else {
			a.logf("socket hello")
		}
	case "status":
		if len(msg.Payload) == 0 {
			return
		}
		var status statusResponse
		if err := json.Unmarshal(msg.Payload, &status); err != nil {
			a.logf("socket status parse error: %v", err)
			return
		}
		files, audioErr := parseAudioList(status.AudioList)
		glib.IdleAdd(func() bool {
			if a.statusLabel != nil {
				a.statusLabel.SetText(fmt.Sprintf("Status: %s (connected=%v)", status.Host, status.Connected))
			}
			a.refreshAudioButtons(files, audioErr)
			return false
		})
		if len(files) > 0 {
			preview := make([]string, len(files))
			for i, f := range files {
				preview[i] = f.Name
			}
			if len(preview) > 6 {
				preview = preview[:6]
			}
			a.logf("socket status update: host=%s connected=%v files=%d (%s)", status.Host, status.Connected, len(files), strings.Join(preview, ", "))
		} else {
			a.logf("socket status update: host=%s connected=%v files=0", status.Host, status.Connected)
		}
	case "hub-message":
		if len(msg.Payload) == 0 {
			a.logf("hub message (empty)")
			return
		}
		var payload interface{}
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			a.logf("hub message decode error: %v", err)
			return
		}
		encoded, _ := json.Marshal(payload)
		a.logf("hub message: %s", encoded)
	case "broadcast-play":
		if len(msg.Payload) == 0 {
			a.logf("broadcast-play event (no payload)")
			return
		}
		var data struct {
			Filename  string `json:"filename"`
			From      string `json:"from"`
			Timestamp string `json:"timestamp"`
			Self      bool   `json:"self"`
		}
		if err := json.Unmarshal(msg.Payload, &data); err != nil {
			a.logf("broadcast-play parse error: %v", err)
			return
		}
		label := data.From
		if label == "" {
			label = "unknown"
		}
		if data.Self {
			a.logf("broadcast play acknowledged: %s (self)", data.Filename)
		} else {
			a.logf("broadcast play from %s: %s", label, data.Filename)
		}
	case "log":
		if len(msg.Payload) == 0 {
			a.logf("log event received")
			return
		}
		a.logf("log event: %s", strings.TrimSpace(string(msg.Payload)))
	case "error":
		if msg.Error != "" {
			a.logf("socket error event: %s", msg.Error)
		} else {
			a.logf("socket error event")
		}
	case "disconnect":
		if msg.Error != "" {
			a.logf("socket disconnected: %s", msg.Error)
		} else {
			a.logf("socket disconnected")
		}
	default:
		a.logf("socket event %s", msg.Event)
	}
}

func (a *app) refreshAudioButtons(files []audioFile, errMsg string) {
	if a.audioFlow == nil {
		return
	}
	a.clearAudioButtons()
	if errMsg != "" {
		if err := a.setAudioPlaceholder(fmt.Sprintf("Audio error: %s", errMsg)); err != nil {
			a.logf("audio placeholder error: %v", err)
		}
		return
	}
	if len(files) == 0 {
		if err := a.setAudioPlaceholder("No audio files found"); err != nil {
			a.logf("audio placeholder error: %v", err)
		}
		return
	}
	for _, f := range files {
		label := formatAudioButtonLabel(f)
		btn, err := gtk.ButtonNewWithLabel(label)
		if err != nil {
			a.logf("audio button create error: %v", err)
			continue
		}
		btn.SetTooltipText(fmt.Sprintf("Broadcast play %s", f.Name))
		filename := f.Name
		btn.SetHExpand(false)
		btn.SetVExpand(false)
		btn.SetHAlign(gtk.ALIGN_FILL)
		btn.SetVAlign(gtk.ALIGN_CENTER)
		btn.SetMarginStart(4)
		btn.SetMarginEnd(4)
		btn.SetMarginTop(2)
		btn.SetMarginBottom(2)
		btn.SetSizeRequest(220, 36)
		btn.Connect("clicked", func() {
			a.logf("broadcast play requested: %s", filename)
			go a.invokeBroadcastPlay(filename)
		})
		a.audioFlow.Add(btn)
		btn.ShowAll()
		a.audioButtons = append(a.audioButtons, btn)
	}
	a.audioFlow.ShowAll()
}

func (a *app) clearAudioButtons() {
	if a.audioFlow == nil {
		return
	}
	for _, btn := range a.audioButtons {
		a.audioFlow.Remove(btn)
		btn.Destroy()
	}
	a.audioButtons = nil
	if a.audioPlaceholder != nil {
		a.audioFlow.Remove(a.audioPlaceholder)
		a.audioPlaceholder.Destroy()
		a.audioPlaceholder = nil
	}
}

func (a *app) setAudioPlaceholder(message string) error {
	if a.audioFlow == nil {
		return nil
	}
	if a.audioPlaceholder != nil {
		a.audioFlow.Remove(a.audioPlaceholder)
		a.audioPlaceholder.Destroy()
		a.audioPlaceholder = nil
	}
	label, err := gtk.LabelNew(message)
	if err != nil {
		return err
	}
	label.SetXAlign(0)
	label.SetSelectable(false)
	label.SetMarginStart(4)
	label.SetMarginEnd(4)
	label.SetMarginTop(4)
	label.SetMarginBottom(4)
	a.audioFlow.Add(label)
	label.ShowAll()
	a.audioPlaceholder = label
	return nil
}

func parseAudioList(raw interface{}) ([]audioFile, string) {
	if raw == nil {
		return nil, ""
	}
	switch val := raw.(type) {
	case map[string]interface{}:
		if errText, ok := val["error"].(string); ok && errText != "" {
			return nil, errText
		}
		if result, ok := val["result"]; ok {
			return parseAudioList(result)
		}
		if filesVal, ok := val["files"]; ok {
			return parseAudioList(filesVal)
		}
		if name, ok := val["name"].(string); ok && name != "" {
			file := audioFile{Name: name}
			if sizePtr := parseAudioSize(val["size"]); sizePtr != nil {
				file.Size = sizePtr
			}
			if uploaded, ok := val["uploaded"].(string); ok {
				file.Uploaded = uploaded
			}
			return []audioFile{file}, ""
		}
		if key, ok := val["key"].(string); ok && key != "" {
			file := audioFile{Name: key}
			if sizePtr := parseAudioSize(val["size"]); sizePtr != nil {
				file.Size = sizePtr
			}
			if uploaded, ok := val["uploaded"].(string); ok {
				file.Uploaded = uploaded
			}
			return []audioFile{file}, ""
		}
		return nil, ""
	case []interface{}:
		files := make([]audioFile, 0, len(val))
		for _, item := range val {
			switch entry := item.(type) {
			case string:
				if entry != "" {
					files = append(files, audioFile{Name: entry})
				}
			case map[string]interface{}:
				name, _ := entry["name"].(string)
				if name == "" {
					name, _ = entry["key"].(string)
				}
				if name == "" {
					continue
				}
				file := audioFile{Name: name}
				if sizePtr := parseAudioSize(entry["size"]); sizePtr != nil {
					file.Size = sizePtr
				}
				if uploaded, ok := entry["uploaded"].(string); ok {
					file.Uploaded = uploaded
				}
				files = append(files, file)
			}
		}
		return files, ""
	default:
		return nil, ""
	}
}

func parseAudioSize(value interface{}) *int64 {
	switch n := value.(type) {
	case float64:
		size := int64(n)
		return &size
	case float32:
		size := int64(n)
		return &size
	case int:
		size := int64(n)
		return &size
	case int64:
		size := n
		return &size
	case int32:
		size := int64(n)
		return &size
	case uint64:
		size := int64(n)
		return &size
	case uint32:
		size := int64(n)
		return &size
	case json.Number:
		if parsed, err := n.Int64(); err == nil {
			return &parsed
		}
	}
	return nil
}

func formatAudioButtonLabel(file audioFile) string {
	parts := []string{file.Name}
	if file.Size != nil && *file.Size > 0 {
		parts = append(parts, fmt.Sprintf("(%s)", formatBytes(*file.Size)))
	}
	if file.Uploaded != "" {
		if ts, err := time.Parse(time.RFC3339, file.Uploaded); err == nil {
			parts = append(parts, fmt.Sprintf("@ %s", ts.Local().Format("2006-01-02")))
		} else {
			parts = append(parts, fmt.Sprintf("@ %s", file.Uploaded))
		}
	}
	return strings.Join(parts, " ")
}

func formatBytes(size int64) string {
	if size <= 0 {
		return "0 B"
	}
	units := []string{"B", "KB", "MB", "GB", "TB"}
	value := float64(size)
	unit := 0
	for value >= 1024 && unit < len(units)-1 {
		value /= 1024
		unit++
	}
	precision := 0
	if value < 10 && unit > 0 {
		precision = 1
	}
	return fmt.Sprintf("%.*f %s", precision, value, units[unit])
}

func detectContentType(name string) string {
	lower := strings.ToLower(name)
	switch {
	case strings.HasSuffix(lower, ".mp3"):
		return "audio/mpeg"
	case strings.HasSuffix(lower, ".wav"):
		return "audio/wav"
	case strings.HasSuffix(lower, ".ogg"):
		return "audio/ogg"
	case strings.HasSuffix(lower, ".flac"):
		return "audio/flac"
	case strings.HasSuffix(lower, ".m4a"):
		return "audio/mp4"
	default:
		return "application/octet-stream"
	}
}
