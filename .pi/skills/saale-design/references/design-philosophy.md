# Design Philosophy

## Core Principles

1. **Calm over clever.** The interface should feel quiet. Information is presented clearly without decoration competing for attention.
2. **Space communicates hierarchy.** Empty space between elements is more effective than dividers, labels, or color coding.
3. **Glass creates depth.** Translucent panels over a gradient background give a sense of layers without visual noise.
4. **Friendly, not formal.** Rounded corners, warm tones, and generous spacing make the app feel approachable.
5. **Instant readability.** A user should understand their situation within 3 seconds of looking at any screen.

## What We Are Building

A productivity hub — email, chat, tasks in one place. The interface should feel like a well-organized desk: everything visible, nothing cluttered.

## What We Are Not Building

- **A gaming dashboard.** No neon, no aggressive gradients, no "cyber" aesthetics, no glowing borders.
- **A developer tool.** No monospace UI text, no terminal-inspired styling, no raw data dumps.
- **A dense enterprise app.** No cramped tables, no information overload, no 3-column grids.
- **A social media feed.** No infinite scroll without controls, no engagement-bait patterns.

## Design Decisions Framework

When choosing between two approaches:

| Criterion | Prefer |
|---|---|
| Visual weight | Lighter, more transparent |
| Corner radius | More rounded (2xl/3xl over lg/md) |
| Spacing | More whitespace over compact layout |
| Color | Neutral over colored |
| Border | Subtle glass border over solid line |
| Background | Translucent glass over solid color |
| Animation | Subtle fade over slide/bounce |
| Typography | Sentence case over ALL CAPS |
| Font | Inter over monospace or decorative |
| Component | shadcn/ui over custom implementation |

## The 3-Second Rule

Every screen must pass the 3-second test:

1. What is this page? (heading or context)
2. What do I have to do? (action items, unread count)
3. Where do I go next? (primary action or navigation)

If any of these takes more than 3 seconds to answer, the design needs simplification.

## Progressive Disclosure

Show only what's needed. Reveal detail on demand:

- **Level 1:** List view (subject, sender, time)
- **Level 2:** Expanded row or hover preview
- **Level 3:** Full detail in a sheet or panel

Never show Level 3 information by default.
