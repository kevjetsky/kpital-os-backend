# Deploying The Backend To Cloud Run

This service is ready to run on Google Cloud Run as a container.

## Required environment variables

- `MONGODB_URI`
- `JWT_SECRET`
- `CLIENT_ORIGIN`

## Optional environment variables

- `AUTH_COOKIE_NAME` defaults to `kpital_token`
- `COOKIE_SECURE` defaults to `true` when `NODE_ENV=production`
- `COOKIE_SAME_SITE` defaults to `lax`

For cross-site cookies between separate frontend and backend domains, use:

- `COOKIE_SECURE=true`
- `COOKIE_SAME_SITE=none`

## Deploy from source

From the `backend/` directory:

```bash
gcloud run deploy kpital-api \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,CLIENT_ORIGIN=https://your-frontend-domain.com,COOKIE_SECURE=true,COOKIE_SAME_SITE=none \
  --update-secrets MONGODB_URI=MONGODB_URI:1,JWT_SECRET=JWT_SECRET:1
```

Cloud Run will build the container from source and store it in Artifact Registry automatically.

## Build and deploy a container image manually

Replace the placeholders before running:

```bash
PROJECT_ID="your-gcp-project-id"
REGION="us-central1"
SERVICE_NAME="kpital-api"
REPOSITORY="kpital-containers"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE_NAME}:latest"

gcloud artifacts repositories create "${REPOSITORY}" \
  --repository-format=docker \
  --location "${REGION}"

gcloud builds submit --tag "${IMAGE}" .

gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,CLIENT_ORIGIN=https://your-frontend-domain.com,COOKIE_SECURE=true,COOKIE_SAME_SITE=none \
  --update-secrets MONGODB_URI=MONGODB_URI:1,JWT_SECRET=JWT_SECRET:1
```

## Notes

- Cloud Run injects `PORT`, and the API already listens on that port.
- Store `MONGODB_URI` and `JWT_SECRET` in Secret Manager instead of committing them.
- For environment variable secrets, pin a version such as `:1` instead of `:latest`.
- `app.yaml` is for App Engine and is not used by the Docker-based Cloud Run deployment above.
