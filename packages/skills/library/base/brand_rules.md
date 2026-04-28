---
skill_id: base/brand_rules
version: 1
compatible_agents:
- content_strategist
- intel_director
- reporting_director
required_memory:
- brand_context
- competitor_map
output_schemas:
- content_brief.v1
- blog_draft.v1
---

# Brand Rules

## Mission

Protect the brand signal-to-noise ratio. Every output must reinforce a single, consistent positioning — not scatter brand equity across multiple competing claims. Apply these rules as hard constraints before any content leaves the system.

## Core positioning frame

Load `brand_context` and identify the one-sentence positioning statement. All content must be traceable back to it. If a draft paragraph cannot be linked to the positioning, cut it.

## What we claim (load from `brand_context`)

The positioning proof points are stored in `brand_context.proof_points`. Use them, substantiate them, do not invent new ones. A proof point without a source is a liability.

## What we never do

**1. Negative competitor framing.** Never name a competitor to disparage. Mention competitors only in factual comparison contexts ("unlike tools that require X, ours does Y") and only when the comparison is verifiable.

**2. Superlatives without proof.** "Fastest", "easiest", "best", "most powerful" are banned unless followed immediately by a verifiable benchmark. The `claims_handling` skill governs this.

**3. Enterprise promises we cannot keep.** If the product is not SOC 2 Type II certified, do not hint at "enterprise-grade security." Load `brand_context.compliance_status` before drafting any security copy.

**4. Metrics we do not own.** Do not quote industry statistics without a primary source. Do not quote our own metrics without confirmation from the `brand_context.approved_stats` field.

**5. Future-state promises in the present tense.** "We integrate with 300 tools" is a promise. "We are building integrations with 300 tools" is a roadmap item. The copy reflects current reality unless clearly labelled as roadmap.

## Tone constraints

| Context | Tone |
|---|---|
| LinkedIn / social | Direct, one-idea-per-post, conversational |
| Long-form blog | Analytical, evidence-led, willing to challenge consensus |
| Email (nurture) | Warm, specific to the reader's trigger, never promotional |
| Case study | Customer-first, outcome-led, specific numbers |

## Competitor rules

Load `competitor_map` to identify which competitors the founder has approved for explicit comparison. For unapproved competitors: do not mention by name; acknowledge the category instead ("tools that track...")

## Enforcement checklist (run before every output)

- [ ] Does the headline reinforce the core positioning?
- [ ] Are all statistics sourced and present in `brand_context.approved_stats`?
- [ ] Is any competitor named? If yes, is it on the approved comparison list?
- [ ] Is there a superlative? If yes, is it immediately followed by proof?
- [ ] Does the CTA align with the current ICP (loaded from `brand_context`)?
