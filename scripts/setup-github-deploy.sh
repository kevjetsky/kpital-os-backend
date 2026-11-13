#!/usr/bin/env bash
# One-time setup so GitHub Actions can deploy the backend to App Engine
# without any stored key.
#
#   - The private config (app.yaml, with the database URI and every secret)
#     goes into Google Secret Manager as "backend-app-yaml". Nothing secret is
#     ever stored in GitHub.
#   - A deploy-only service account, github-deployer, gets just the roles
#     `gcloud app deploy` needs, and read access to that one secret.
#   - GitHub signs in as that account through Workload Identity Federation,
#     and only for pushes to main of kevjetsky/kpital-os-backend: forks, pull
#     requests and other branches cannot use it.
#
# Run from the project root (the folder holding backend/), signed in to gcloud
# as the project owner:   bash .wt/backend-stick-drift/scripts/setup-github-deploy.sh
# Safe to run again. Afterwards: when app.yaml changes, refresh the secret with
#   gcloud secrets versions add backend-app-yaml --data-file=backend/app.yaml
set -euo pipefail

PROJECT=kpital-os
REPO=kevjetsky/kpital-os-backend
APP_YAML=${APP_YAML:-backend/app.yaml}
NUMBER=$(gcloud projects describe "$PROJECT" --format="value(projectNumber)")
SA="github-deployer@${PROJECT}.iam.gserviceaccount.com"
POOL=github
PROVIDER=github-actions

[ -f "$APP_YAML" ] || { echo "No $APP_YAML here; run from the project root."; exit 1; }

gcloud services enable secretmanager.googleapis.com sts.googleapis.com iam.googleapis.com iamcredentials.googleapis.com --project="$PROJECT"

if gcloud secrets describe backend-app-yaml --project="$PROJECT" >/dev/null 2>&1; then
  gcloud secrets versions add backend-app-yaml --project="$PROJECT" --data-file="$APP_YAML"
else
  gcloud secrets create backend-app-yaml --project="$PROJECT" --replication-policy=automatic --data-file="$APP_YAML"
fi

gcloud iam service-accounts describe "$SA" --project="$PROJECT" >/dev/null 2>&1 ||
  gcloud iam service-accounts create github-deployer --project="$PROJECT" --display-name="GitHub Actions: deploy the backend"

for ROLE in roles/appengine.deployer roles/appengine.serviceAdmin roles/cloudbuild.builds.editor roles/artifactregistry.reader; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role="$ROLE" --condition=None --quiet >/dev/null
done
# Uploading the app goes through App Engine's own staging bucket only.
for BUCKET in "staging.${PROJECT}.appspot.com" "${PROJECT}.appspot.com"; do
  gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 &&
    gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectAdmin >/dev/null
done
# Deploying runs the app as App Engine's own account.
gcloud iam service-accounts add-iam-policy-binding "${PROJECT}@appspot.gserviceaccount.com" --project="$PROJECT" \
  --member="serviceAccount:$SA" --role=roles/iam.serviceAccountUser >/dev/null
gcloud secrets add-iam-policy-binding backend-app-yaml --project="$PROJECT" \
  --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null

gcloud iam workload-identity-pools describe "$POOL" --project="$PROJECT" --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --project="$PROJECT" --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers describe "$PROVIDER" --project="$PROJECT" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --project="$PROJECT" --location=global \
    --workload-identity-pool="$POOL" --display-name="kpital-os-backend main" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='${REPO}' && assertion.ref=='refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding "$SA" --project="$PROJECT" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" >/dev/null

# Turns the deploy job on. Until this variable exists, pushes only run the tests.
gh variable set DEPLOY_ENABLED --repo "$REPO" --body true

echo "Done. The next push to main tests, then deploys."
