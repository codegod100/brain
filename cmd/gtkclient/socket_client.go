package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

type socketMessage struct {
	ID      string          `json:"id,omitempty"`
	Type    string          `json:"type"`
	OK      *bool           `json:"ok,omitempty"`
	Error   string          `json:"error,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
	Event   string          `json:"event,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type socketClient struct {
	conn         net.Conn
	writerMu     sync.Mutex
	pendingMu    sync.Mutex
	pending      map[string]chan socketMessage
	closed       chan struct{}
	eventHandler func(socketMessage)
	requestID    uint64
}

func newSocketClient(address string, handler func(socketMessage)) (*socketClient, error) {
	conn, err := net.Dial("tcp", address)
	if err != nil {
		return nil, err
	}
	client := &socketClient{
		conn:         conn,
		pending:      make(map[string]chan socketMessage),
		closed:       make(chan struct{}),
		eventHandler: handler,
	}
	go client.readLoop()
	return client, nil
}

func (c *socketClient) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

func (c *socketClient) readLoop() {
	scanner := bufio.NewScanner(c.conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var msg socketMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			fmt.Printf("socket decode error: %v\n", err)
			continue
		}
		if msg.ID != "" {
			c.deliverResponse(msg)
			continue
		}
		if msg.Type == "event" && c.eventHandler != nil {
			// run handler asynchronously to avoid blocking reader
			go c.eventHandler(msg)
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Printf("socket read error: %v\n", err)
	}
	c.closePendingWithError(fmt.Errorf("socket closed"))
	close(c.closed)
	if c.eventHandler != nil {
		errMsg := "socket closed"
		if err := scanner.Err(); err != nil {
			errMsg = err.Error()
		}
		go c.eventHandler(socketMessage{Type: "event", Event: "disconnect", Error: errMsg})
	}
}

func (c *socketClient) deliverResponse(msg socketMessage) {
	c.pendingMu.Lock()
	ch, ok := c.pending[msg.ID]
	if ok {
		delete(c.pending, msg.ID)
	}
	c.pendingMu.Unlock()
	if ok {
		ch <- msg
		close(ch)
	}
}

func (c *socketClient) closePendingWithError(err error) {
	c.pendingMu.Lock()
	defer c.pendingMu.Unlock()
	for id, ch := range c.pending {
		ok := false
		message := socketMessage{ID: id, Type: "error", Error: err.Error(), OK: &ok}
		ch <- message
		close(ch)
	}
	c.pending = make(map[string]chan socketMessage)
}

func (c *socketClient) request(action string, payload map[string]any) (*socketMessage, error) {
	if payload == nil {
		payload = make(map[string]any)
	}
	id := c.nextID()
	req := make(map[string]any, len(payload)+2)
	req["id"] = id
	req["type"] = action
	for k, v := range payload {
		req[k] = v
	}
	encoded, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	encoded = append(encoded, '\n')
	ch := make(chan socketMessage, 1)
	c.pendingMu.Lock()
	c.pending[id] = ch
	c.pendingMu.Unlock()
	c.writerMu.Lock()
	_, err = c.conn.Write(encoded)
	c.writerMu.Unlock()
	if err != nil {
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, err
	}
	select {
	case resp := <-ch:
		if resp.OK != nil && !*resp.OK {
			if resp.Error != "" {
				return nil, fmt.Errorf(resp.Error)
			}
			return nil, fmt.Errorf("socket request failed")
		}
		return &resp, nil
	case <-time.After(requestTimeout):
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, fmt.Errorf("socket request timeout")
	case <-c.closed:
		return nil, fmt.Errorf("socket connection closed")
	}
}

func (c *socketClient) nextID() string {
	value := atomic.AddUint64(&c.requestID, 1)
	return fmt.Sprintf("req-%d", value)
}
