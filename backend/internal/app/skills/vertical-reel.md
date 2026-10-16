---
name: vertical-reel
title: Vertical reel: 9:16 video for Reels, Shorts, TikTok and Douyin
title_zh: 竖屏短视频：适配 Reels、Shorts、TikTok 与抖音的 9:16 画面
description: Use when a video is meant for a vertical feed (Instagram Reels, YouTube Shorts, TikTok, Douyin, WeChat Channels): a 1080x1920 layout that keeps clear of the app's buttons and caption, an opening that earns attention in the first second or two, words that work with the sound off, landscape footage recomposed instead of cropped, and an ending that loops or lands on one action.
description_zh: 视频要发到竖屏信息流时使用（Instagram Reels、YouTube Shorts、TikTok、抖音、视频号）：避开应用按钮和文案区的 1080x1920 版式，头一两秒抓住注意力的开场，静音也看得懂的文字，横版素材重新构图而不是硬裁，结尾循环或落在一个行动上。
category: video
applies: video,motion,html,design
version: 1
attribution:
---
# Vertical reel

A vertical feed plays full screen, often with the sound off, under the app's buttons and caption, and the viewer decides in the first second or two. If code-video-brief is attached, write its brief; if not, write a short one first: format, facts with a "Do not claim" line, a beat-by-beat timeline with every word on screen, the frames to check.

## Rendering it in AwwO

- Tell the member to render every part at 1080 x 1920, the same fps and the exact length (the render panel starts at 1920 x 1080 and 6 s). AwwO renders picture only, up to 20 s per video.
- Music goes on in an editor, commonly at about -14 LUFS integrated with true peaks under -1 dBTP; an app that normalises just turns a louder mix down.

## Safe area (1080 x 1920, approximate)

Margins for the main feeds at once; layouts change with app versions, phones and caption length, so tell the member to check the target placement before publishing.

| Zone | Pixels | Use |
| --- | --- | --- |
| Top bar | y 0-250 | the app's header: no text, no faces |
| Core | x 70-940, y 270-1400 | everything that must be read or recognised |
| Right rail | x 940-1080, y 1000-1700 | buttons: no text, no key detail |
| Bottom | y 1400-1920 | caption and account name: background only |

- In a 9:16 frame these numbers replace promo-film's landscape ones; keep only its 96 px side margins if it is attached. A paid placement can cover about 670 px: keep what must be read above y 1250.
- Text at 1080 wide (a vertical frame fills the phone's width): captions 44-60 px, labels 32 px, small labels inside a diagram or an interface at least 24 px.
- Grids may crop the cover to 3:4 (y 240-1680) or a square (y 420-1500), and the cover may be another frame: keep frame 0's title and subject in y 420-1400.

## The first seconds

- Frame 0 is complete and says what this is, with poster words and a picture.
- The picture moves on every beat of the first second, while words wait for their reading hold (1 s plus 1 s per 4 words, or per 5 Chinese characters). The payoff is on screen by t = 2 s (frame 60 at 30 fps).
- In a feed this replaces promo-film's calm brand open: no logo sting, no black frames, no fade from nothing. Name the product within five seconds, after the hook, and again at the end; a looping reel shows the name inside every loop.

## Landscape material

- Never crop 16:9 footage to 9:16, which keeps a third of it. Show it as a card 870-940 px wide (489-529 px high; this replaces promo-film's 50-75 %), its title above and its context below; past 870 px, keep key detail out of the rail.
- Punch in 1.2-1.4x on small subjects and drift at most about 4 % of scale over a shot.
- A canvas video keeps its own clock: once it has loaded, pause it in `renderAt`, set `currentTime` and resolve on its `seeked` event (code-video-brief has the full steps). A list or a finale can be a grid of cards at least 270 px wide.

## Length and rhythm

| Length | Shape |
| --- | --- |
| up to 10 s | hook, payoff, name |
| 10-20 s | hook, three to five beats of proof, name and action |
| 20-60 s | hook, chapters of 2 s items with a new stamp every 6-10 s, a finale, name and action |

- About one new idea per 1.5 to 2 s; a list item holds one bar (2 s at 120 BPM) or its reading time, whichever is longer, rounded up to a beat. A fresh hook comes at least every 10 s: a chapter stamp, a question, a number, a new layout.

## Reels longer than 20 seconds

AwwO renders each part as its own video; the member joins them and adds sound in an editor. For a clean join, each part is a whole number of frames (at 30 fps a 2 s bar is 60 frames, a 128 BPM bar 56.25), has a constant OFFSET equal to the length of the parts before it, and draws everything in `renderAt` from OFFSET + t, without CSS animations (they restart in every part). In a loop, every repeating period divides the whole length.

## The ending

- Loop (the last frame leads into frame 0, same layout, carried element still moving) or land on the name and one action, held at least 1.5 s.
- One action only: a handle, a search term or a short address; no long URLs, no QR code viewers would have to scan off their own screen.

## Checklist

- Render size, fps and length are stated; the page has no audio.
- Nothing that must be read sits in the top bar, the right rail or the bottom zone; frame 0 works as a cover.
- It reads muted, text meets the sizes above and holds for its reading time, footage is carded and seeked.
- The payoff shows by t = 2 s, a fresh hook comes every 10 s or sooner, and the end loops or holds the name and one action.
