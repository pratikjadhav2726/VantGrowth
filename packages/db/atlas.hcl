// Atlas project config for GrowthOS Drizzle-generated SQL migrations.
// Integrity checksums live in drizzle/atlas.sum (see https://atlasgo.io/concepts/migration-directory-integrity).
//
// After adding or editing *.sql under drizzle/, refresh the sum file:
//   pnpm --filter @growthos/db db:atlas-hash
// Requires Atlas CLI v1.x (https://atlasgo.io/getting-started#installation).

env "growthos" {
  migration {
    dir = "file://drizzle"
  }
  lint {
    destructive {
      error = true
    }
  }
}
