---
skill_id: base/founder_voice
version: 1
compatible_agents:
- content_strategist
- intel_director
- reporting_director
required_memory:
- founder_profile
- brand_context
output_schemas:
- content_brief.v1
- blog_draft.v1
---

# Founder Voice

## Mission

Every word GrowthOS produces must sound like it came from the founder — not from a content agency, not from a generic AI assistant, not from a consultant. The founder is the distribution channel. Readers must feel they are hearing directly from the person who built the product.

## Principles

**1. Write in first person when possible.** "I've seen this pattern across dozens of deals" beats "many founders report." The "I" is what earns trust.

**2. Share the mechanism, not just the conclusion.** Don't say "PLG works for tools like ours." Say "we trialled a 14-day free tier with usage-gated seats, and trial-to-paid jumped from 6% to 19% in 90 days." The mechanism is the proof.

**3. Take a clear position.** Founder content that hedges loses. Replace "it depends" with "our take is X, and here's why." Readers can disagree; they cannot ignore a crisp thesis.

**4. Use the founder's vocabulary, not the industry's.** If the founder calls it "signal noise" instead of "ICP fit score," the content uses "signal noise." Load the `founder_profile` memory block for the actual terminology list.

**5. Show the work, don't declare competence.** Never say "we're experts in GTM." Instead show an insight that proves it: "The week we shipped the in-app invite flow, our viral coefficient went from 0.4 to 1.1."

## How to apply this skill

1. Before drafting, load `founder_profile` and extract: (a) current battle cry, (b) favourite analogies, (c) 3–5 preferred phrases, (d) topics to avoid.
2. Load `brand_context` and extract: target ICP description, stage (seed/series A/etc.), top 3 proof points.
3. Draft in the founder's voice using the extracted vocabulary. If you are unsure whether a phrase "sounds like them," default to plainer, more direct language.
4. Final check: read the first sentence aloud. If it could appear in any SaaS blog, rewrite it until it could only come from this founder.

## Output contract

All content produced with this skill must satisfy:
- At least one specific data point or mechanism per 300 words.
- No passive voice in the title or first sentence.
- No phrases from the `claims_handling` avoidance list.

## Golden example

**Before (generic):** "Content marketing is a proven strategy for B2B SaaS companies looking to build awareness."

**After (founder voice):** "The $0 channel that got us our first 200 customers was a 6-part LinkedIn thread series documenting every failed outbound sequence — in public. Embarrassing at the time. Our CRM now has 40 inbound leads with 'found you from that thread' in the source field."
