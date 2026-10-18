package app

import (
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// A model's training data ends before the model itself was released, and no request said which model answers or what
// day it is: on 2026-10-18 a canvas node running on Claude Opus 5.5 told a customer that no product called "Opus 5.5"
// exists and that the newest Claude is Opus 4.x, and the canvas planner (Claude Haiku 4.5) called the model
// "claude-opus-5". So every model call's system prompt ends with a note that names the model it runs on (its catalog
// name and AwwO id) and today's UTC date, and says that what was released after the model's training exists, the model
// itself among it. The note is added where a worker request is built (a run, a team member's turn, a workspace run, a
// direct task), never frozen into a snapshot, and admission counts it in the same budgets (sentInstructions).

// modelIdentityNote is that note for the model id whose catalog name is name, on the UTC day of now; "" for no model.
func modelIdentityNote(name, id string, now time.Time) string {
	id = strings.TrimSpace(id)
	if id == "" || strings.ContainsFunc(id, unicode.IsControl) {
		return ""
	}
	model := "the AwwO model " + id
	if name = strings.TrimSpace(name); name != "" && name != id && !strings.ContainsFunc(name, unicode.IsControl) {
		model = name + " (AwwO model id " + id + ")"
	}
	return "Model and date: you run on " + model + ", and today is " + now.UTC().Format("2006-01-02") + " (UTC). " +
		"Your training data ends before today, so models, products and versions released since then exist, the model you run on among them. " +
		"Never say that a model or product does not exist only because you do not know it; when you cannot verify its details, say so and work from what the user tells you about it."
}

// withPromptNote ends instructions with note, after a blank line.
func withPromptNote(instructions, note string) string {
	switch {
	case note == "":
		return instructions
	case strings.TrimSpace(instructions) == "":
		return note
	}
	return instructions + "\n\n" + note
}

// promptNow is the clock of the note's date (promptClock; nil is time.Now).
func (a *App) promptNow() time.Time {
	if a.promptClock != nil {
		return a.promptClock()
	}
	return time.Now()
}

// modelIdentity is the note for model as the worker behind health's catalog names it: the model's own name, never a UI
// label (a personal model's label carries the name of the user's connection).
func (a *App) modelIdentity(health piHealth, model string) string {
	name := ""
	for _, m := range health.Models {
		if m.ID == model {
			if n := strings.TrimSpace(m.Name); n != "" && utf8.RuneCountInString(n) <= 80 {
				name = n
			}
			break
		}
	}
	return modelIdentityNote(name, model, a.promptNow())
}

// piDefaultSystemPrompt is what the Pi worker tells a model when a run sends no system prompt (apps/pi-worker/pi-task.mjs;
// TestPiDefaultSystemPromptIsThePiWorkers keeps the two the same). A Pi run with no instructions keeps it before the note,
// which would otherwise replace it.
const piDefaultSystemPrompt = "You are a helpful assistant. Answer the user accurately. You have no tools or access to files, shell commands, or private application data."

// computerStepNote tells a direct task how many model calls it may make. The managed execution core stops a task
// whose last allowed answer still asks for a tool, so a task that had done its work lost its answer (2026-10-18);
// knowing the budget, the model batches its tool calls and keeps the last call for its answer.
func computerStepNote(maxModelCalls int) string {
	if maxModelCalls < 1 {
		return ""
	}
	return "Step budget: this task may make at most " + strconv.Itoa(maxModelCalls) + " model calls, and each of your replies is one of them. " +
		"Batch the tool calls you need into few replies, and keep the last call for your final answer: what you did and checked, the files you published, and what is still left."
}

// sentInstructions is what a run's framed instructions become on the wire: a direct task's step budget, then the note
// naming the run's model. A team's members are named one by one (executeTeamTurn) and a media generation calls no
// language model, so their instructions stay as they are.
func (a *App) sentInstructions(framed string, snap executionSnapshot) string {
	if snap.Team != nil || snap.Media != nil {
		return framed
	}
	if snap.Computer != nil {
		framed = withPromptNote(framed, computerStepNote(snap.Computer.MaxModelCalls))
	} else if strings.TrimSpace(framed) == "" && snap.Workspace == nil && snap.Runtime == runtimePI {
		framed = piDefaultSystemPrompt
	}
	return withPromptNote(framed, a.modelIdentity(snap.Health, snap.Model))
}
