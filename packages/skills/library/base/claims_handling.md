---
skill_id: base/claims_handling
version: 1
compatible_agents:
- content_strategist
- intel_director
- reporting_director
required_memory:
- brand_context
output_schemas:
- content_brief.v1
- blog_draft.v1
---

# Claims Handling

## Mission

Unverified claims are a legal and reputational liability. This skill governs how agents treat statistics, comparisons, predictions, and superlatives. When in doubt, downgrade the claim — never upgrade it.

## Claim taxonomy

| Type | Definition | Verification requirement |
|---|---|---|
| `stat` | A numerical fact ("73% of buyers...") | Primary source URL required |
| `comparison` | Relative claim ("faster than X") | Benchmark methodology required |
| `prediction` | Forward-looking assertion ("will become...") | Qualified with timeframe + hedging language |
| `definition` | Category claim ("the category of...") | Widely accepted industry framing required |

## Processing rules by type

### Stats
1. Check if the stat is in `brand_context.approved_stats`. If yes, use it verbatim with the stored source.
2. If the stat is not in `approved_stats`, mark it with `requires_verification: true` in the `blog_draft.v1.estimated_claims` array.
3. Never round a stat upward to make it sound more impressive. If a study says 68%, do not write "nearly three-quarters."
4. Include year of publication for any stat older than 18 months: "2023 Gartner report" not just "Gartner report."

### Comparisons
1. Only compare to competitors that appear in `brand_context.approved_comparisons`.
2. The comparison must be specific: "processes in under 50ms vs. the category average of 800ms (measured on [benchmark], n=12)" is acceptable; "way faster" is not.
3. If no benchmark data is available, replace the comparison with a descriptive benefit: "processes synchronously so users never see a loading spinner."

### Predictions
All forward-looking statements must include:
- A clear timeframe: "by 2026", "within 3 product cycles"
- A hedging qualifier: "we believe", "early signals suggest", "based on current trajectory"
- Never a percentage of probability without a model to back it up.

### Definitions / category claims
If we are asserting a category definition ("the new category of agentic GTM"), load `brand_context.category_narrative`. If no category narrative is set, do not make category claims.

## Hard-stop phrases

The following phrases must never appear in output under any circumstances:

- "proven to increase revenue by X%"
- "guaranteed ROI"
- "industry-leading" (unless from a third-party award)
- "best-in-class" (unless from a third-party benchmark)
- "always", "never", "100%" (when describing product capabilities)
- "HIPAA compliant", "SOC 2 certified" (unless confirmed in `brand_context.compliance_status`)

## What to do when you flag a claim

1. Add the claim to `blog_draft.v1.estimated_claims` with `requires_verification: true`.
2. Include a `source_url` if one is available from the source material.
3. Leave a comment inline: `<!-- CLAIM: requires verification before publish -->`.
4. Do NOT block the draft — surface it for human review in the approval queue.

## Confidence scoring effect

Every flagged unverified claim reduces the draft's `quality_indicators` confidence. The critique worker reads these flags and penalises the rubric score accordingly. Fewer flags = higher confidence score = faster approval.
