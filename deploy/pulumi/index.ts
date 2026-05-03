import * as pulumi from "@pulumi/pulumi";

/**
 * Stub stack: export deterministic outputs until real infra is modelled.
 * Extend with @pulumi/aws / @pulumi/kubernetes / etc.
 */
export const environment = pulumi.output("stub");
export const note = pulumi.output(
  "Replace this program with real resources when wiring Pulumi to your cloud account.",
);
