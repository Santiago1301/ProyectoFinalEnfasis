#!/usr/bin/env bash
###############################################################################
# Configura la gobernanza del repositorio en GitHub (idempotente):
#   - ramas estáticas dev / test / prod (dev por defecto)
#   - sólo merge commits (squash/rebase romperían la ascendencia dev->test->prod
#     y provocarían conflictos cruzados en cada promoción)
#   - ruleset "ambientes-estaticos" sobre dev, test y prod, SIN bypass (ni admins):
#       * non_fast_forward  -> bloquea git push --force
#       * deletion          -> bloquea borrar la rama
#       * pull_request      -> prohíbe el push directo: todo entra por PR
#       * required_status_checks (estricto) -> Merge sólo con CI en verde
#   - GitHub Environments dev/test/prod; prod exige aprobación del dueño
#
# Requiere: gh autenticado (gh auth login) con permiso de admin en el repo.
# Uso: scripts/github/setup-repo.sh <owner>/<repo>
###############################################################################
set -euo pipefail
REPO="${1:?Uso: $0 <owner>/<repo>}"
CHECKS=(promotion-guard lint-build unit-tests integration-tests e2e-tests terraform-plan)

log() { printf '\033[1;34m[setup-repo]\033[0m %s\n' "$*"; }

log "Ramas dev/test/prod"
DEV_SHA=$(gh api "repos/$REPO/git/ref/heads/dev" --jq .object.sha)
for b in test prod; do
  gh api "repos/$REPO/git/ref/heads/$b" >/dev/null 2>&1 \
    || gh api -X POST "repos/$REPO/git/refs" -f ref="refs/heads/$b" -f sha="$DEV_SHA" >/dev/null
done

log "Rama por defecto = dev; sólo merge commits"
gh api -X PATCH "repos/$REPO" -f default_branch=dev \
  -F allow_merge_commit=true -F allow_squash_merge=false -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true >/dev/null

log "Ruleset de protección (sin bypass)"
CHECKS_JSON=$(printf '%s\n' "${CHECKS[@]}" | jq -R '{context: .}' | jq -s .)
RULESET=$(jq -n --argjson checks "$CHECKS_JSON" '{
  name: "ambientes-estaticos",
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { include: ["refs/heads/dev", "refs/heads/test", "refs/heads/prod"], exclude: [] } },
  rules: [
    { type: "non_fast_forward" },
    { type: "deletion" },
    { type: "pull_request", parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: true } },
    { type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: $checks } }
  ]
}')
EXISTING=$(gh api "repos/$REPO/rulesets" --jq '.[] | select(.name=="ambientes-estaticos") | .id')
if [[ -n "$EXISTING" ]]; then
  echo "$RULESET" | gh api -X PUT "repos/$REPO/rulesets/$EXISTING" --input - >/dev/null
else
  echo "$RULESET" | gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null
fi

log "GitHub Environments"
ME_ID=$(gh api user --jq .id)
for env in dev test prod; do
  body=$(jq -n --arg env "$env" --argjson me "$ME_ID" '{
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  } + (if $env == "prod" then { reviewers: [{ type: "User", id: $me }] } else {} end)')
  echo "$body" | gh api -X PUT "repos/$REPO/environments/$env" --input - >/dev/null
  # Cada Environment sólo acepta despliegues desde su propia rama.
  gh api "repos/$REPO/environments/$env/deployment-branch-policies" --jq '.branch_policies[].name' | grep -qx "$env" \
    || gh api -X POST "repos/$REPO/environments/$env/deployment-branch-policies" -f name="$env" -f type=branch >/dev/null
done

log "Listo. Prueba: git push --force origin test  -> rechazado por el ruleset 'ambientes-estaticos'"
