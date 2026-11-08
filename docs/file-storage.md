# File storage (step 3.3)

Uploaded files (promissory notes, contracts, IDs, receipts, Excel imports) are
personal data. They are kept in a private Google Cloud Storage bucket in the
Dammam region, and only reached through the API, which checks the client first.

The code is ready (`api/src/storage/storage.ts`). This page is the one-time
setup once the Google Cloud account (bought through CNTXT) exists.

## What the code does

- Only file details go in the database (`app.documents`); the bytes go to the bucket.
- Object names are `clients/<client id>/documents/<document id>`. No file names,
  debtor names or ID numbers.
- Files are created once and never overwritten.
- The file type is read from the file itself. Documents: PDF, JPEG, PNG, WEBP, HEIC.
  Imports: .xlsx.
- Each file gets a SHA-256 fingerprint, stored with its details, so it can be shown
  later that it was not changed (evidence for Najiz).
- Development and tests keep files in a local folder (`STORAGE_LOCAL_DIR`).
  Production refuses that and needs `STORAGE_DRIVER=gcs`.

## Setting up the bucket

Replace `talos-prod` with the real project and `talos-prod-documents` with a
bucket name of your choice.

```bash
# 1. The bucket: Dammam only, no public access ever, one set of permissions for the whole bucket.
gcloud storage buckets create gs://talos-prod-documents \
  --project=talos-prod \
  --location=me-central2 \
  --uniform-bucket-level-access \
  --public-access-prevention

# 2. Keep deleted or replaced files for 30 days, in case of a mistake.
gcloud storage buckets update gs://talos-prod-documents --soft-delete-duration=30d

# 3. The API's service account may create and read files, nothing else.
gcloud storage buckets add-iam-policy-binding gs://talos-prod-documents \
  --member=serviceAccount:talos-api@talos-prod.iam.gserviceaccount.com \
  --role=roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding gs://talos-prod-documents \
  --member=serviceAccount:talos-api@talos-prod.iam.gserviceaccount.com \
  --role=roles/storage.objectViewer
```

The API is not given delete rights on purpose: documents are evidence. The only
delete in the code is a clean-up when saving a file's details fails right after
the upload; without delete rights that file simply stays in the bucket, unused.

Files are encrypted at rest by Google by default. To hold the key yourselves
(optional), create a Cloud KMS key in `me-central2`, allow the Cloud Storage
service agent to use it, and set `GCS_KMS_KEY` to its full name.

## API settings

```
STORAGE_DRIVER=gcs
GCS_BUCKET=talos-prod-documents
GCS_KMS_KEY=            # optional
MAX_UPLOAD_MB=10
```

No key file is needed on Cloud Run: the API uses the service account it runs as.

## Not done yet

- Deleting files when a client leaves (needs a retention decision with the lawyer, step 0.9).
- Virus scanning of uploads. The type check stops programs pretending to be PDFs,
  but a scanner is worth adding before files are opened by staff at scale.
