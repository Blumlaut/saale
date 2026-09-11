# Design Philosophy

## Core Principles

1. **Console, not decoration.** The interface is a mission control console: flat, bordered, opaque surfaces. No blur, no gradients, no glass. Every pixel has a job.
2. **Borders carry the depth.** A 1px border on a solid surface replaces what glass/blur did. If a panel needs visual separation, the border does it — not transparency or shadow.
3. **One accent, orange.** Orange (`--primary`) is the single mission accent: primary actions, active states, focus rings, the console tick. Everything else is neutral gray.
4. **Calm density.** Information is dense but never noisy. Neutral fills, muted metadata, and the accent used sparingly keep the console readable at a glance.
5. **Instant readability.** A user should understand their situation within 3 seconds of looking at any screen.

## What We Are Building

A productivity hub — email, chat, tasks, jobs, infrastructure in one place. The interface should feel like a well-run mission control room: everything visible, instrumented, nothing decorative.

## What We Are Not Building

- **A glassmorphism app.** No `backdrop-blur`, no `bg-white/N` overlays, no specular highlights, no gradient backgrounds. The old liquid-glass language is decommissioned.
- **A gaming dashboard.** No neon glows, no animated backgrounds, no rainbow status colors.
- **A dense enterprise app.** No cramped tables, no information overload, no 3-column grids.
- **A social media feed.** No infinite scroll without controls, no engagement-bait patterns.

## Design Decisions Framework

When choosing between two approaches:

| Criterion     | Prefer                                             |
| ------------- | -------------------------------------------------- |
| Visual weight | Lighter, flatter                                   |
| Corner radius | `rounded-lg` (12px) for controls; `rounded-2xl` for panels |
| Spacing       | More whitespace over compact layout                |
| Color         | Neutral over colored; orange only for primary action |
| Border        | 1px solid `border-border` over shadow or transparency |
| Background    | Solid token color (`bg-card`, `bg-background`) over gradient or overlay |
| Animation     | Subtle fade over slide/bounce                      |
| Typography    | Sentence case over ALL CAPS (console micro-labels excepted) |
| Font          | Inter for UI; Geist Mono for data (IDs, timestamps, code, micro-labels) |
| Component     | shadcn/ui over custom implementation               |

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
