/**
 * The documents bucket and the key that encrypts it.
 *
 * This is the resource `packages/integrations/src/s3.ts` writes to, and the
 * two are written to agree: the adapter names SSE-KMS on every object, and this
 * bucket also defaults to it. That redundancy is deliberate and the comment in
 * the adapter says why — bucket default encryption lives here, where a later
 * edit removes it with no code change, and objects already written keep
 * whatever they had.
 */

resource "aws_kms_key" "main" {
  description = "locum-planner ${var.environment}: documents, RDS, Redis"

  /*
   * Rotation on, and a deletion window at the maximum.
   *
   * If this key is destroyed, every SAPC certificate and ID document in the
   * bucket becomes permanently unreadable, along with the database snapshots.
   * Thirty days is the longest pause AWS offers between "someone ran destroy"
   * and "the data is gone".
   */
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = { Name = local.name }
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.main.key_id
}

resource "aws_s3_bucket" "documents" {
  bucket = "${local.name}-documents"

  tags = { Name = "${local.name}-documents" }
}

/*
 * Every public-access switch off, explicitly.
 *
 * AWS now blocks public access by default on new buckets, which is exactly why
 * this is written out rather than left implicit: the default protects a bucket
 * created today and says nothing about one whose ACLs someone edits in the
 * console in eighteen months. These four booleans are the invariant, and they
 * belong in the file that would have to change to break it.
 *
 * Retrieval is by expiring signed URL — see signed-url.ts and the presign cap
 * in the S3 adapter. There is no path by which a document is meant to be
 * publicly readable.
 */
resource "aws_s3_bucket_public_access_block" "documents" {
  bucket = aws_s3_bucket.documents.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    # Cuts KMS calls on repeated access to the same prefix, which matters
    # because the admin review queue reads the same locum's documents
    # repeatedly while working through it.
    bucket_key_enabled = true
  }
}

/*
 * Versioning, which is not about convenience.
 *
 * §5's admin review queue makes decisions about identity documents. A document
 * replaced or deleted between upload and review, accidentally or otherwise,
 * would leave a verification decision with no evidence behind it — and the
 * §8 attendance record is meant to be evidence years later.
 */
resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id

  versioning_configuration {
    status = "Enabled"
  }
}

/*
 * §10 retention.
 *
 * The erasure endpoint anonymises the database row straight away; this expires
 * the object itself. The window must match RETENTION_POLICY in
 * packages/core/src/privacy/retention.ts — that policy is asserted against
 * every table in the schema by a test, but nothing asserts it against this
 * bucket, so the two are kept in sync by hand and by this comment.
 *
 * Noncurrent versions are expired far sooner. Versioning exists to protect a
 * review in progress, not to keep a copy of a deleted ID document for seven
 * years after someone asked for it to be gone.
 */
resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    id     = "expire-documents"
    status = "Enabled"

    filter {}

    expiration {
      days = var.document_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.documents]
}

/*
 * Refuse any write that is not KMS-encrypted.
 *
 * The default encryption above means an ordinary PUT gets SSE-KMS. This makes
 * a PUT that explicitly asks for something weaker fail instead of quietly
 * succeeding — the failure mode being a piece of code that "works" and leaves
 * identity documents encrypted with a key AWS holds rather than one this
 * account controls.
 */
resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.documents.id
  policy = data.aws_iam_policy_document.documents_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.documents]
}

data "aws_iam_policy_document" "documents_bucket" {
  statement {
    sid    = "DenyUnencryptedWrites"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.documents.arn}/*"]

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.documents.arn,
      "${aws_s3_bucket.documents.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}
