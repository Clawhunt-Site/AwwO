package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/http"
	"net/http/httptest"
	"net/mail"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// feedbackApp is an App without a database whose reports are captured instead of sent, with an inbox to send them to.
func feedbackApp(t *testing.T) (*App, *httptest.Server, *[][]byte, *sync.Mutex) {
	t.Helper()
	cfg := testConfig()
	cfg.SupportEmail, cfg.SMTPFrom = "support@clawhunt.store", "support@clawhunt.store"
	a := New(nil, cfg)
	var mu sync.Mutex
	sent := [][]byte{}
	a.sendFeedback = func(_ context.Context, from, to string, message []byte) error {
		if from != "support@clawhunt.store" || to != "support@clawhunt.store" {
			t.Errorf("envelope %q -> %q", from, to)
		}
		mu.Lock()
		defer mu.Unlock()
		sent = append(sent, append([]byte(nil), message...))
		return nil
	}
	server := httptest.NewServer(a.Handler())
	t.Cleanup(server.Close)
	return a, server, &sent, &mu
}

func postFeedback(t *testing.T, server *httptest.Server, path string, body any, headers map[string]string) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	r, _ := http.NewRequest("POST", server.URL+"/api/v1"+path, bytes.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "http://localhost:5189")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func feedbackRequest() map[string]any {
	return map[string]any{
		"messages": []map[string]string{
			{"role": "user", "text": "点运行以后画布一直转圈\r\nSubject: injected"},
			{"role": "assistant", "text": "是哪张画布？"},
			{"role": "user", "text": "电商落地页那张，刷新也没用"},
		},
		"report": map[string]any{"title": "运行后一直转圈\r\nBcc: someone@example.com", "category": "bug", "severity": "high", "summary": "点运行后画布一直转圈。",
			"steps": []string{"打开画布", "点运行"}, "expected": "开始运行", "actual": "一直转圈"},
		"locale": "zh",
		"context": map[string]any{"url": "https://awwo.clawhunt.store/?tenant=t_1&canvas=c-2&invite=SECRET&reset=TOKEN#x", "title": "AwwO",
			"userAgent": "Mozilla/5.0 (Test)", "viewport": "1440×900@2", "language": "zh-CN", "timezone": "Asia/Shanghai", "webBuild": "0.9.0 · saas-abc.js",
			"uiMode": "simple", "errors": []string{"TypeError: x is undefined"}, "requests": []string{"PUT /tenants/t_1/canvases/c-2 → 409 canvas_reload_required"}},
	}
}

type parsedMail struct {
	header      mail.Header
	subject     string
	text        string
	attachments map[string][]byte
}

func parseFeedbackMail(t *testing.T, raw []byte) parsedMail {
	t.Helper()
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("not a mail: %v", err)
	}
	subject, err := new(mime.WordDecoder).DecodeHeader(msg.Header.Get("Subject"))
	if err != nil {
		t.Fatal(err)
	}
	out := parsedMail{header: msg.Header, subject: subject, attachments: map[string][]byte{}}
	media, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil {
		t.Fatal(err)
	}
	if media == "text/plain" {
		// mail.ReadMessage leaves the transfer encoding to the reader: decode it as a client would.
		if msg.Header.Get("Content-Transfer-Encoding") != "quoted-printable" {
			t.Fatalf("transfer encoding %q", msg.Header.Get("Content-Transfer-Encoding"))
		}
		body, err := io.ReadAll(quotedprintable.NewReader(msg.Body))
		if err != nil {
			t.Fatal(err)
		}
		out.text = strings.ReplaceAll(string(body), "\r\n", "\n")
		return out
	}
	if media != "multipart/mixed" {
		t.Fatalf("content type %q", media)
	}
	reader := multipart.NewReader(msg.Body, params["boundary"])
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(part)
		if name := part.FileName(); name != "" {
			data, err := base64.StdEncoding.DecodeString(strings.NewReplacer("\r", "", "\n", "").Replace(string(body)))
			if err != nil {
				t.Fatal(err)
			}
			out.attachments[name] = data
			continue
		}
		// The multipart reader decodes a quoted-printable part itself.
		out.text = strings.ReplaceAll(string(body), "\r\n", "\n")
	}
	return out
}

func TestFeedbackInboxIsProductionsOwnUnlessNamed(t *testing.T) {
	for _, c := range []struct {
		env, value, want string
		fails            bool
	}{
		{"production", "", defaultSupportEmail, false},
		{"staging", "", "", false},
		{"development", "", "", false},
		{"staging", "qa@clawhunt.store", "qa@clawhunt.store", false},
		{"production", "off", "", false},
		{"production", "Support <support@clawhunt.store>", "", true},
		{"production", "not an address", "", true},
	} {
		t.Setenv("AWWO_SUPPORT_EMAIL", c.value)
		cfg := Config{Env: c.env}
		err := cfg.feedbackFromEnv()
		if (err != nil) != c.fails || cfg.SupportEmail != c.want {
			t.Errorf("%s %q: %q %v", c.env, c.value, cfg.SupportEmail, err)
		}
	}
	t.Setenv("AWWO_SUPPORT_EMAIL", "")
	t.Setenv("AWWO_FEEDBACK_MODEL", "bad model")
	if err := (&Config{}).feedbackFromEnv(); err == nil {
		t.Error("a model id with a space was taken")
	}
	t.Setenv("AWWO_FEEDBACK_MODEL", "bedrock.claude-haiku-4-5")
	if cfg := (Config{}); cfg.feedbackFromEnv() != nil || cfg.FeedbackModel != "bedrock.claude-haiku-4-5" {
		t.Error("the feedback model was not read")
	}
}

func TestFeedbackReplyIsReadAsItsJSONOrAsWords(t *testing.T) {
	ready := `<think>let me see</think>` + "```json\n" + `{"reply":"好的，我整理好了，请检查后发送。","ready":true,"report":{"title":"运行后一直转圈","category":"BUG","severity":"urgent","summary":"一直转圈","steps":["打开画布","","点运行"],"expected":"开始运行","actual":"转圈"}}` + "\n```"
	got, ok := parseFeedbackReply(ready)
	if !ok || !got.Ready || got.Report == nil || got.Report.Category != "bug" || got.Report.Severity != "medium" || len(got.Report.Steps) != 2 || got.Reply != "好的，我整理好了，请检查后发送。" {
		t.Fatalf("ready answer: %+v %v", got, ok)
	}
	if got, ok := parseFeedbackReply(`{"reply":"哪张画布？","ready":false}`); !ok || got.Ready || got.Report != nil || got.Reply != "哪张画布？" {
		t.Fatalf("question: %+v %v", got, ok)
	}
	// Ready without a report with a title is a question still.
	if got, ok := parseFeedbackReply(`{"reply":"好","ready":true,"report":{"title":"  "}}`); !ok || got.Ready || got.Report != nil {
		t.Fatalf("report without a title: %+v %v", got, ok)
	}
	if got, ok := parseFeedbackReply("Which canvas was it?"); !ok || got.Reply != "Which canvas was it?" || got.Ready {
		t.Fatalf("plain words: %+v %v", got, ok)
	}
	for _, text := range []string{`{"reply":"cut off at the tok`, `Sure: {"reply":"half`, `<think>still thinking`, "", `{"ready":true}`,
		`{"reply":"cut off with a "quote`, `{"title":"a report alone","category":"bug"}`} {
		if got, ok := parseFeedbackReply(text); ok {
			t.Errorf("%q read as %+v", text, got)
		}
	}
}

// Haiku in production (2026-11-10) quoted a Chinese word with plain double quotes inside its JSON, and the answer was
// refused as unreadable: such quotes, raw line breaks, words around the object and a field of another type are read.
func TestFeedbackReplyIsReadAsAModelWritesIt(t *testing.T) {
	quoted := `{"reply":"明白了，我会把它整理成一份"测试"报告。","ready":true,"report":{"title":"反馈助手"自检"","category":"other","severity":"low","summary":"确认"测试"报告能送到。","steps":["打开主页","点"反馈""],"expected":"","actual":""}}`
	got, ok := parseFeedbackReply(quoted)
	if !ok || got.Reply != `明白了，我会把它整理成一份"测试"报告。` || !got.Ready || got.Report == nil || got.Report.Title != `反馈助手"自检"` ||
		got.Report.Summary != `确认"测试"报告能送到。` || len(got.Report.Steps) != 2 || got.Report.Steps[1] != `点"反馈"` {
		t.Fatalf("plain quotes inside the texts: %+v %v", got, ok)
	}
	if got, ok := parseFeedbackReply("{\"reply\":\"第一行\n第二行\",\"ready\":false}"); !ok || got.Reply != "第一行\n第二行" || got.Ready {
		t.Fatalf("a raw line break: %+v %v", got, ok)
	}
	around := `好的 {先说一句} 这是回答：` + "```json\n" + `{"reply":"收到","ready":false}` + "\n```\n请查看上方摘要 {以上}"
	if got, ok := parseFeedbackReply(around); !ok || got.Reply != "收到" || got.Ready {
		t.Fatalf("words and braces around the answer: %+v %v", got, ok)
	}
	loose := `{"reply":"好","ready":"true","report":{"title":"按钮没反应","category":"bug","severity":"high","summary":3,"steps":"打开画布\n\n点按钮","expected":["x"],"actual":null}}`
	got, ok = parseFeedbackReply(loose)
	if !ok || !got.Ready || got.Report == nil || got.Report.Title != "按钮没反应" || got.Report.Summary != "" || got.Report.Expected != "" ||
		len(got.Report.Steps) != 2 || got.Report.Steps[0] != "打开画布" || got.Report.Steps[1] != "点按钮" {
		t.Fatalf("fields of other types: %+v %v", got, ok)
	}
	// JSON written correctly reads the same through the repair: an escaped quote and a backslash stay what they were.
	exact := `{"reply":"a \"quoted\" word and a \\ mark","ready":false}`
	if repaired := feedbackJSONRepaired(exact); repaired != exact {
		t.Fatalf("correct JSON repaired into %q", repaired)
	}
	if got, ok := parseFeedbackReply(exact); !ok || got.Reply != `a "quoted" word and a \ mark` {
		t.Fatalf("escaped quotes: %+v %v", got, ok)
	}
	// Whatever json.Marshal writes is left byte for byte.
	for _, s := range []string{`plain`, `a "quote"`, `back\slash`, "line\nbreak\ttab\x01", `中文“引号”和「括号」`, `</script> & <b>`, "\u2028",
		`{"nested":"json"}`, `ends with \`, `"`, `", "ready": true`} {
		raw, _ := json.Marshal(map[string]any{"reply": s, "ready": false, "report": map[string]any{"title": s, "steps": []string{s, s}}})
		if repaired := feedbackJSONRepaired(string(raw)); repaired != string(raw) {
			t.Errorf("%s repaired into %s", raw, repaired)
		}
	}
}

func TestFeedbackPageAddressKeepsOnlyWhereThePersonWas(t *testing.T) {
	got := feedbackPageURL("https://awwo.clawhunt.store/?tenant=t_1&canvas=c-2&invite=SECRET&reset=TOKEN&view=results#frag")
	if strings.Contains(got, "SECRET") || strings.Contains(got, "TOKEN") || strings.Contains(got, "frag") ||
		!strings.Contains(got, "tenant=t_1") || !strings.Contains(got, "canvas=c-2") || !strings.Contains(got, "view=results") {
		t.Fatalf("kept %q", got)
	}
	if got := feedbackPageURL("javascript:alert(1)\r\nBcc: x@y"); strings.ContainsAny(got, "\r\n") {
		t.Fatalf("not one line: %q", got)
	}
}

func TestFeedbackReportReachesTheInboxAsPlainTextWithSafeHeaders(t *testing.T) {
	_, server, sent, _ := feedbackApp(t)
	body := feedbackRequest()
	status, out := postFeedback(t, server, "/feedback", body, nil)
	id, _ := out["id"].(string)
	if status != 200 || !regexp.MustCompile(`^FB-\d{8}-[A-Z2-9]{6}$`).MatchString(id) || len(*sent) != 1 {
		t.Fatalf("send: %d %v, %d sent", status, out, len(*sent))
	}
	m := parseFeedbackMail(t, (*sent)[0])
	if m.header.Get("Bcc") != "" || m.header.Get("X-AwwO-Feedback-ID") != id || !strings.Contains(m.header.Get("From"), "<support@clawhunt.store>") ||
		m.header.Get("To") != "<support@clawhunt.store>" || m.header.Get("Reply-To") != "" {
		t.Fatalf("headers: %v", m.header)
	}
	if want := "[AwwO 反馈 · development] [bug/high] 运行后一直转圈 Bcc: someone@example.com · " + id; m.subject != want {
		t.Fatalf("subject %q, want %q", m.subject, want)
	}
	for _, want := range []string{"编号 ID: " + id, "标题 Title: 运行后一直转圈 Bcc: someone@example.com", "严重程度 Severity: 高 high", "  1. 打开画布",
		"访客（未登录）", "联系邮箱 Contact: 未留", "tenant=t_1", "工作区 Workspace: t_1 · 画布 Canvas: c-2", "TypeError: x is undefined",
		"409 canvas_reload_required", "用户 Person:\n  点运行以后画布一直转圈\n  Subject: injected", "助手 Assistant:\n  是哪张画布？"} {
		if !strings.Contains(m.text, want) {
			t.Errorf("the body lacks %q:\n%s", want, m.text)
		}
	}
	if strings.Contains(m.text, "SECRET") || strings.Contains(m.text, "TOKEN") {
		t.Error("the body holds the link's invitation or reset token")
	}
	// The same report again (its answer lost) is the same report: no second mail.
	status, again := postFeedback(t, server, "/feedback", body, nil)
	if status != 200 || again["id"] != id || again["duplicate"] != true || len(*sent) != 1 {
		t.Fatalf("resend: %d %v, %d sent", status, again, len(*sent))
	}
}

func TestFeedbackReportCarriesItsPicturesAndAVisitorsAddress(t *testing.T) {
	_, server, sent, _ := feedbackApp(t)
	jpeg := append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, bytes.Repeat([]byte("j"), 5000)...)
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte("p"), 300)...)
	body := feedbackRequest()
	delete(body, "report")
	body["contact"] = "visitor@example.com"
	body["attachments"] = []map[string]string{{"type": "image/jpeg", "data": base64.StdEncoding.EncodeToString(jpeg)}, {"type": "image/png", "data": base64.StdEncoding.EncodeToString(png)}}
	if status, out := postFeedback(t, server, "/feedback", body, nil); status != 200 {
		t.Fatalf("send: %d %v", status, out)
	}
	m := parseFeedbackMail(t, (*sent)[0])
	if !bytes.Equal(m.attachments["screenshot-1.jpg"], jpeg) || !bytes.Equal(m.attachments["screenshot-2.png"], png) {
		t.Fatalf("attachments: %d", len(m.attachments))
	}
	if m.header.Get("Reply-To") != "<visitor@example.com>" || !strings.Contains(m.text, "联系邮箱 Contact: visitor@example.com") ||
		!strings.Contains(m.text, "未经助手整理") || !strings.HasPrefix(m.subject, "[AwwO 反馈 · development] 点运行以后画布一直转圈 Subject: injected · FB-") {
		t.Fatalf("visitor report: %v %q\n%s", m.header, m.subject, m.text)
	}
	// Pictures that are not what they say, too many or too large are refused before anything is sent.
	for name, attachments := range map[string][]map[string]string{
		"a PNG called JPEG": {{"type": "image/jpeg", "data": base64.StdEncoding.EncodeToString(png)}},
		"not a picture":     {{"type": "text/html", "data": base64.StdEncoding.EncodeToString([]byte("<script>"))}},
		"not base64":        {{"type": "image/png", "data": "%%%"}},
		"too large":         {{"type": "image/jpeg", "data": base64.StdEncoding.EncodeToString(append([]byte{0xFF, 0xD8, 0xFF}, make([]byte, feedbackAttachmentBytes)...))}},
		"four":              {{"type": "image/png", "data": base64.StdEncoding.EncodeToString(png)}, {"type": "image/png", "data": base64.StdEncoding.EncodeToString(png)}, {"type": "image/png", "data": base64.StdEncoding.EncodeToString(png)}, {"type": "image/png", "data": base64.StdEncoding.EncodeToString(png)}},
	} {
		body["attachments"] = attachments
		if status, out := postFeedback(t, server, "/feedback", body, nil); status != 400 || out["error"].(map[string]any)["code"] != "invalid_attachment" {
			t.Errorf("%s: %d %v", name, status, out)
		}
	}
	if len(*sent) != 1 {
		t.Fatalf("%d sent", len(*sent))
	}
}

func TestFeedbackRefusesWhatIsNotAReport(t *testing.T) {
	a, server, sent, _ := feedbackApp(t)
	for name, change := range map[string]func(map[string]any){
		"no words":        func(b map[string]any) { b["messages"] = []map[string]string{{"role": "assistant", "text": "你好"}} },
		"an unknown role": func(b map[string]any) { b["messages"] = []map[string]string{{"role": "system", "text": "x"}} },
		"too long": func(b map[string]any) {
			b["messages"] = []map[string]string{{"role": "user", "text": strings.Repeat("长", feedbackMessageMax+1)}}
		},
		"a bad contact":     func(b map[string]any) { b["contact"] = "x@y\r\nBcc: z@w" },
		"an unknown field":  func(b map[string]any) { b["cc"] = "x@example.com" },
		"too many messages": func(b map[string]any) { b["messages"] = make([]map[string]string, feedbackMessages+1) },
	} {
		body := feedbackRequest()
		change(body)
		if status, out := postFeedback(t, server, "/feedback", body, nil); status != 400 {
			t.Errorf("%s: %d %v", name, status, out)
		}
	}
	// Another site's page cannot send one.
	if status, _ := postFeedback(t, server, "/feedback", feedbackRequest(), map[string]string{"Origin": "https://evil.example"}); status != 403 {
		t.Errorf("cross-origin send: %d", status)
	}
	// With no inbox, nothing is sent and the page is told to email instead.
	a.cfg.SupportEmail = ""
	if status, out := postFeedback(t, server, "/feedback", feedbackRequest(), nil); status != 503 || out["error"].(map[string]any)["code"] != "feedback_unavailable" {
		t.Errorf("no inbox: %d %v", status, out)
	}
	if len(*sent) != 0 {
		t.Fatalf("%d sent", len(*sent))
	}
}

func TestFeedbackLimitsAPersonAndGivesBackWhatTheRelayRefused(t *testing.T) {
	a, server, sent, mu := feedbackApp(t)
	a.feedbackLimits.sendHourN = 2
	refuse := true
	send := a.sendFeedback
	a.sendFeedback = func(ctx context.Context, from, to string, message []byte) error {
		if refuse {
			return errors.New("mail unavailable")
		}
		return send(ctx, from, to, message)
	}
	body := func(i int) map[string]any {
		b := feedbackRequest()
		b["messages"] = []map[string]string{{"role": "user", "text": fmt.Sprintf("report %d", i)}}
		return b
	}
	// A refused send is answered as such and does not count.
	for i := 0; i < 3; i++ {
		if status, out := postFeedback(t, server, "/feedback", body(i), nil); status != 502 || out["error"].(map[string]any)["code"] != "feedback_send_failed" {
			t.Fatalf("refused %d: %d %v", i, status, out)
		}
	}
	refuse = false
	for i := 0; i < 2; i++ {
		if status, out := postFeedback(t, server, "/feedback", body(i), nil); status != 200 {
			t.Fatalf("send %d: %d %v", i, status, out)
		}
	}
	status, out := postFeedback(t, server, "/feedback", body(9), nil)
	if status != 429 || out["error"].(map[string]any)["code"] != "rate_limited" {
		t.Fatalf("third in the hour: %d %v", status, out)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*sent) != 2 {
		t.Fatalf("%d sent", len(*sent))
	}
}

func TestFeedbackLimiterBoundsAnswersInFlightAndPerMinute(t *testing.T) {
	l := &feedbackLimiter{turnMinuteN: 2, maxTurning: 2}
	now := time.Now()
	release, refused := l.turn("u:1", now)
	if refused != "" {
		t.Fatal(refused)
	}
	if _, refused := l.turn("u:1", now); refused != "assistant_busy" {
		t.Fatalf("a second answer at once: %q", refused)
	}
	other, _ := l.turn("u:2", now)
	if _, refused := l.turn("u:3", now); refused != "assistant_busy" {
		t.Fatalf("past the deployment's answers at once: %q", refused)
	}
	release()
	other()
	if release, refused := l.turn("u:1", now); refused != "" {
		t.Fatalf("second answer of the minute: %q", refused)
	} else {
		release()
	}
	if _, refused := l.turn("u:1", now); refused != "rate_limited" {
		t.Fatalf("third answer of the minute: %q", refused)
	}
	if release, refused := l.turn("u:1", now.Add(time.Minute)); refused != "" {
		t.Fatalf("the next minute: %q", refused)
	} else {
		release()
	}
	// The deployment's answers a day: past them nobody's turn is taken, and a report is still sent without one.
	day := &feedbackLimiter{turnAllN: 2}
	for _, key := range []string{"n:1", "n:2"} {
		if release, refused := day.turn(key, now); refused != "" {
			t.Fatalf("%s: %q", key, refused)
		} else {
			release()
		}
	}
	if _, refused := day.turn("n:3", now); refused != "assistant_busy" {
		t.Fatalf("past the deployment's day: %q", refused)
	}
	// A visitor has fewer answers a day than an account.
	visitors := &feedbackLimiter{turnVisitorDayN: 1}
	for i, key := range []string{"n:9", "u:9", "u:9"} {
		if release, refused := visitors.turn(key, now.Add(time.Duration(i)*time.Minute)); refused != "" {
			t.Fatalf("%s: %q", key, refused)
		} else {
			release()
		}
	}
	if _, refused := visitors.turn("n:9", now.Add(5*time.Minute)); refused != "rate_limited" {
		t.Fatalf("a visitor's second answer of the day: %q", refused)
	}
	// The deployment's reports a day.
	all := &feedbackLimiter{sendAllN: 1}
	done, refused := all.send("n:1", now)
	if refused != "" {
		t.Fatal(refused)
	}
	done("FB-1", "d")
	if _, refused := all.send("n:2", now); refused != "feedback_capacity" {
		t.Fatalf("past the deployment's day: %q", refused)
	}
	if id := all.sent("n:1", "d", now.Add(time.Minute)); id != "FB-1" {
		t.Fatalf("resend id %q", id)
	}
	if id := all.sent("n:1", "d", now.Add(feedbackResendWindow)); id != "" {
		t.Fatalf("a resend after the window: %q", id)
	}
}

func TestFeedbackModelIsTheOperatorsAndOnlyOneThatAnswersAOneShotCall(t *testing.T) {
	a := New(nil, testConfig())
	worker := piHealth{Model: "qwen-free", Models: []piModel{{ID: "qwen-free", Runtime: "pi"}, {ID: "bedrock.claude-haiku-4-5", Provider: "bedrock", Runtime: "pi"}}}
	a.cfg.PlannerModel = "bedrock.claude-haiku-4-5"
	if got := a.feedbackModel(worker); got != "qwen-free" {
		t.Fatalf("a Bedrock model without the worker's bridge: %q", got)
	}
	worker.ComputerBedrock = true
	if got := a.feedbackModel(worker); got != "bedrock.claude-haiku-4-5" {
		t.Fatalf("the planner model: %q", got)
	}
	a.cfg.FeedbackModel = "missing"
	if got := a.feedbackModel(worker); got != "" {
		t.Fatalf("a named model the worker lacks: %q", got)
	}
	a.cfg.FeedbackModel, a.cfg.PlannerModel, a.cfg.RouteFreeModels = "", "", []string{"other-free"}
	if got := a.feedbackModel(worker); got != "" {
		t.Fatalf("a default that is not free: %q", got)
	}
}

func TestFeedbackAssistantAsksOneShotWithThinkingOff(t *testing.T) {
	identifier := regexp.MustCompile(`^feedback-[A-Za-z0-9_-]{1,119}$`)
	answer := `{"reply":"哪张画布？","ready":false}`
	worker, calls := routeWorker(t, func(w http.ResponseWriter, body map[string]any) {
		if body["thinking"] != false || body["maxTokens"] != float64(feedbackMaxTokens) || body["model"] != "qwen-test" || body["tenantId"] != "feedback" {
			t.Errorf("call body: %v", body)
		}
		if id, _ := body["runId"].(string); !identifier.MatchString(id) || body["sessionId"] != id {
			t.Errorf("run id %q", id)
		}
		messages := body["completion"].(map[string]any)["messages"].([]any)
		system := messages[0].(map[string]any)["content"].(string)
		last := messages[len(messages)-1].(map[string]any)
		if !strings.HasPrefix(system, feedbackInstructions) || !strings.Contains(system, `"canvas page"`) || !strings.Contains(system, "not signed in") ||
			last["role"] != "user" || last["content"] != "画布一直转圈" {
			t.Errorf("messages: %v", messages)
		}
		json.NewEncoder(w).Encode(content(answer))
	})
	cfg := testConfig()
	cfg.PIURL = worker.URL
	a := New(nil, cfg)
	server := httptest.NewServer(a.Handler())
	defer server.Close()
	turn := map[string]any{"messages": []map[string]string{{"role": "user", "text": "画布一直转圈"}}, "locale": "zh", "page": "canvas page"}
	status, out := postFeedback(t, server, "/feedback/assistant", turn, nil)
	if status != 200 || out["reply"] != "哪张画布？" || out["ready"] != false || *calls != 1 {
		t.Fatalf("turn: %d %v after %d calls", status, out, *calls)
	}
	// An answer it cannot read, and a conversation that does not end with the person, are refused.
	answer = `{"reply":"cut`
	if status, out := postFeedback(t, server, "/feedback/assistant", turn, nil); status != 503 || out["error"].(map[string]any)["code"] != "assistant_unavailable" {
		t.Fatalf("unreadable: %d %v", status, out)
	}
	turn["messages"] = []map[string]string{{"role": "user", "text": "x"}, {"role": "assistant", "text": "y"}}
	if status, _ := postFeedback(t, server, "/feedback/assistant", turn, nil); status != 400 {
		t.Fatalf("ends with the assistant: %d", status)
	}
	// After enough of the person's messages the model is told to write the report now.
	many := []map[string]string{}
	for i := 0; i < feedbackFinalTurns; i++ {
		many = append(many, map[string]string{"role": "user", "text": fmt.Sprint(i)}, map[string]string{"role": "assistant", "text": "?"})
	}
	if !strings.Contains(a.feedbackSystemPrompt(feedbackTurnInput{Messages: decodeMessages(many)}, true), `answer "ready": true`) {
		t.Error("the model is not told to finish")
	}
	// A staging inbox is the one the assistant names.
	a.cfg.SupportEmail = "qa@clawhunt.store"
	if prompt := a.feedbackSystemPrompt(feedbackTurnInput{}, false); !strings.Contains(prompt, "qa@clawhunt.store") || strings.Contains(prompt, defaultSupportEmail) {
		t.Error("the assistant names another inbox than the configured one")
	}
	a.cfg.SupportEmail = ""
	// With personal credentials there is no platform model to ask.
	a.cfg.UserCredentials = true
	turn["messages"] = []map[string]string{{"role": "user", "text": "x"}}
	if status, out := postFeedback(t, server, "/feedback/assistant", turn, nil); status != 503 || out["error"].(map[string]any)["code"] != "assistant_unavailable" {
		t.Fatalf("personal credentials: %d %v", status, out)
	}
}

// The worker's slots are its runs' first (review, 2026-11-09): with two of four in use the assistant asks nothing, so
// visitors chatting at once can never hold the slots a run needs; the report is still sent without it.
func TestFeedbackAssistantLeavesTheWorkersSlotsToRuns(t *testing.T) {
	routeActive = 2
	worker, calls := routeWorker(t, func(w http.ResponseWriter, _ map[string]any) {
		json.NewEncoder(w).Encode(content(`{"reply":"x","ready":false}`))
	})
	routeActive = 0
	cfg := testConfig()
	cfg.PIURL = worker.URL
	_, err := New(nil, cfg).feedbackModelTurn(t.Context(), feedbackTurnInput{Messages: []feedbackMessage{{Role: "user", Text: "x"}}}, false)
	if err == nil || err.Error() != "assistant_worker_busy" || *calls != 0 {
		t.Fatalf("with two of four slots in use: %v after %d calls", err, *calls)
	}
	if feedbackTurnsInFlight != 1 {
		t.Fatal("more than one of the assistant's answers at once for the deployment")
	}
}

// The model reads the latest of a conversation only: at most feedbackModelMessages messages and feedbackModelText
// runes, starting with one of the person's.
func TestFeedbackModelReadsTheLatestOfTheConversation(t *testing.T) {
	messages := []feedbackMessage{}
	for i := 0; i < feedbackMessages; i++ {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		messages = append(messages, feedbackMessage{Role: role, Text: fmt.Sprintf("%d %s", i, strings.Repeat("长", 1500))})
	}
	kept := feedbackModelConversation(messages)
	total := 0
	for _, m := range kept {
		total += len([]rune(m.Text))
	}
	if len(kept) == 0 || len(kept) > feedbackModelMessages || kept[0].Role != "user" || total > feedbackModelText ||
		!strings.HasPrefix(kept[len(kept)-1].Text, fmt.Sprint(feedbackMessages-1)) {
		t.Fatalf("kept %d messages, %d runes, first %q", len(kept), total, kept[0].Role)
	}
}

func decodeMessages(raw []map[string]string) []feedbackMessage {
	out := []feedbackMessage{}
	for _, m := range raw {
		out = append(out, feedbackMessage{Role: m["role"], Text: m["text"]})
	}
	return out
}

func TestFeedbackStatusSaysWhatThePageCanDo(t *testing.T) {
	_, server, _, _ := feedbackApp(t)
	resp, err := http.Get(server.URL + "/api/v1/feedback")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != 200 || out["available"] != true || out["assistant"] != true || out["signedIn"] != false || out["supportEmail"] != "support@clawhunt.store" || out["email"] != nil {
		t.Fatalf("status: %d %v", resp.StatusCode, out)
	}
}

// A signed-in person's report names their account and answers to it; a session that ended makes a visitor, who can
// still send one.
func TestPostgresFeedbackNamesTheSignedInAccount(t *testing.T) {
	var mu sync.Mutex
	sent := [][]byte{}
	h := newHarness(t, "http://127.0.0.1:1", func(a *App) {
		a.cfg.SupportEmail, a.cfg.SMTPFrom = "support@clawhunt.store", "support@clawhunt.store"
		a.sendFeedback = func(_ context.Context, _, _ string, message []byte) error {
			mu.Lock()
			defer mu.Unlock()
			sent = append(sent, message)
			return nil
		}
	})
	cookie, _, _ := h.register(t, "reporter@example.test")
	status := h.request(t, cookie, "GET", "/feedback", nil, 200)
	if status["signedIn"] != true || status["email"] != "reporter@example.test" {
		t.Fatalf("status: %v", status)
	}
	out := h.request(t, cookie, "POST", "/feedback", feedbackRequest(), 200)
	if out["id"] == nil || len(sent) != 1 {
		t.Fatalf("send: %v, %d sent", out, len(sent))
	}
	m := parseFeedbackMail(t, sent[0])
	if !strings.Contains(m.header.Get("Reply-To"), "<reporter@example.test>") || !strings.Contains(m.text, "账号 Account: Test <reporter@example.test>") ||
		strings.Contains(m.text, "访客") || strings.Contains(m.text, "网络地址") {
		t.Fatalf("signed-in report: %v\n%s", m.header, m.text)
	}
	if _, err := h.db.Exec(context.Background(), "UPDATE auth_sessions SET expires_at=now()-interval '1 second'"); err != nil {
		t.Fatal(err)
	}
	body := feedbackRequest()
	body["messages"] = []map[string]string{{"role": "user", "text": "登录过期了"}}
	h.request(t, cookie, "POST", "/feedback", body, 200)
	if m := parseFeedbackMail(t, sent[1]); !strings.Contains(m.text, "访客（未登录）") || m.header.Get("Reply-To") != "" {
		t.Fatalf("ended session: %v\n%s", m.header, m.text)
	}
}
