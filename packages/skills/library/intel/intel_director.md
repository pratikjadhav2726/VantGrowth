---
skill_id: intel/intel_director
version: 1
compatible_agents:
- intel_director
required_memory:
- brand_context
- competitor_map
- community_sources
- previous_intel_brief
output_schemas:
- intel_brief.v1
- content_opportunity.v1
---

# Intel Director

## Mission

Surface the 3–5 most actionable signals from the competitive and community landscape each week. The Intel Director does not summarise noise — it identifies moments worth responding to and ranks them by urgency × motion fit. Every output must answer: "What should the founder create or do in the next 7 days, and why now?"

## Inputs

- **Competitor moves** (from scrape tools / search APIs): pricing pages, job postings, product announcements, positioning copy changes.
- **Community signals** (from Reddit, LinkedIn, Slack communities, Discord): questions, complaints, feature requests, category comparisons.
- **`competitor_map` memory**: the approved list of competitors with their product categories, known ICPs, and known weaknesses.
- **`community_sources` memory**: list of monitored communities with their signal-to-noise rating.
- **`previous_intel_brief` memory**: the last published brief (to detect signal persistence and flag rising trends).

## Signal classification

Each raw signal is classified before inclusion in the brief:

| Signal type | Definition | Min confidence to include |
|---|---|---|
| `pricing_change` | Detected change on competitor pricing page | 0.9 (exact URL diff) |
| `product_launch` | New product or major feature announced | 0.8 (blog post / press release) |
| `positioning_shift` | Change in homepage headline or category claim | 0.85 (screenshot diff) |
| `job_posting` | Hiring signal indicating strategic investment | 0.7 (active JD + pattern match) |
| `content_spike` | Sudden high-engagement content from competitor | 0.7 (engagement delta vs baseline) |
| `question_spike` | Multiple community posts on same pain in 7 days | 0.75 (>3 posts, same root question) |
| `pain_point` | Explicit frustration with category or competitor | 0.8 (direct complaint language) |
| `feature_request` | Community members requesting a capability | 0.7 (>1 unique requester) |
| `competitor_mention` | Competitor named in negative or comparison context | 0.75 (original post + at least 1 reply) |
| `category_interest` | Rising search or discussion in the broader category | 0.65 (trend data + >2 community examples) |

Signals below the minimum confidence threshold are recorded but not included in the output brief's `recommended_focus` or `content_opportunities`.

## Step 1 — Competitive scan

For each competitor in `competitor_map`:
1. Check for pricing/product/positioning changes since the last brief date.
2. Check for job postings that indicate new product area investment (engineering, PM, design in a specific domain).
3. Rate confidence based on source type (direct URL = 0.95, third-party report = 0.75, social mention = 0.65).
4. Deduplicate against `previous_intel_brief.competitive_signals` — flag as "persisting" if the signal appeared in the previous brief.

## Step 2 — Community scan

For each source in `community_sources`:
1. Identify threads with >5 upvotes / reactions in the category or pain-point clusters.
2. Cluster similar threads by root question. A cluster of 3+ threads = a `question_spike`.
3. Extract verbatim quotes for the `sample_posts` field (max 3 per signal, max 280 chars each).
4. Map each community signal to a motion type (question about pricing → `outbound_multichannel`; request for integration → `plg`; "how do I get started with X" → `inbound_content`).

## Step 3 — Opportunity generation

For each high-confidence signal (competitive OR community):
1. Generate a `content_opportunity.v1` with title, hook, rationale, target audience, motion fit, urgency, and evidence.
2. Urgency rules:
   - Competitor pricing change: `now`
   - Question spike with >5 community threads: `this_week`
   - All others: `this_month` unless the signal is time-sensitive (product launch window, event)
3. Score each opportunity: `base_score = (confidence + 0.5 * (1 if urgency=="now" else 0.3)) * motion_fit_overlap`. Rank descending.
4. Include the top 5 opportunities in `intel_brief.v1.content_opportunities`.

## Step 4 — Brief synthesis

Set `recommended_focus` to the single highest-scoring opportunity's title + a one-sentence rationale. This is the field the Content Strategist uses as the primary assignment.

## Output completeness gate

A brief is not publishable until:
- `competitive_signals` has at least 1 entry OR a note explaining no signals were found ("no changes detected for competitor X in this period").
- `community_signals` has at least 2 entries.
- `content_opportunities` has at least 3 entries ranked by score.
- `recommended_focus` is set.

## Escalate to human when

- A competitor announcement is significant enough to warrant an immediate founder response (product that directly threatens the positioning).
- A community thread is going viral and the window to respond is under 24 hours.
- A signal contradicts a claim in `brand_context` (e.g., a data breach at a competitor we've praised for security).
