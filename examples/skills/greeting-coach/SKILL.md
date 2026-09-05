---
name: greeting-coach
description: Use this when the user wants help writing a warm, culturally-aware greeting for an email, message, or meeting opener.
---

# Greeting Coach

Authored from scratch as a pure-prose SuperClaw skill (Route A). It adds no
side effects — it only returns guidance the model reads.

When the user asks for a greeting:

- Ask (or infer) the audience, relationship, and channel (email / chat / spoken).
- Match formality to the relationship: first contact and senior audiences skew
  formal; teammates and follow-ups skew warm and brief.
- Offer two options (one safe, one warmer) and a one-line rationale for each.
- Keep it under three sentences unless the user asks for more.

Never invent facts about the recipient. If the relationship is unknown, default
to the safe, formal option and say so.
